import {
  Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, TFile,
  editorInfoField, requestUrl, setIcon, type EventRef
} from "obsidian";
import { NativeYjs, type UndoReview } from "./live";
import {
  effectiveDisplayName, normalizeDisplayName, DISPLAY_NAME_LIMIT
} from "./display-name";
import {
  queueRename, queueDelete, acknowledgePending, localPaths,
  type TrackedFile, type PendingMutation
} from "./pending";
import {
  stageWrite, acknowledgeWrite, type StagedWrite
} from "./writes";
import {
  classifySnapshotAbsence, readChangesThrough, retainDeletionProofs,
  type DeletionProof
} from "./reconcile";
import {
  normalizeOrigin, parseJoinLink, validateConnection, sessionError,
  scopedSecretId, type ConnectionDraft
} from "./connection-setup";
import { importNativeFiles, nativeConnectionState } from "./mobile-controls";
import { classifySyncSocketClose } from "./connection-close";
import {
  persistScopedDeviceCredential, type SecretDurability
} from "./credential-persistence";
import { readQuiescentBinary } from "./binary-quiescence";
import {
  SyncHttpError, isReviewableConflict, pendingDependent
} from "./operation-replay";
import { mountMobileNavbarAction } from "../../../packages/server-core/src/mobile-navbar";
import { mobileUiCopy, mobileUiLanguage } from "../../../packages/server-core/src/mobile-ui-copy";
import {
  createContentScope, type SyncContentScope,
} from "../../../packages/sync-policy/src/content-scope";
import {
  effectiveContentScope, sharingSummary, formatLocalBytes,
  effectiveMediaBypassExtensions, type DeviceContentScope,
} from "./sharing-settings";
import {
  MEDIA_BYPASS_TYPES, normalizeMediaBypassExtensions,
} from "../../../packages/sync-policy/src/media-bypass";
import { connectionRecoveryLabel } from "./connection-recovery";
import {
  isMigrationRecordCurrent, migrationNeedsPreservation,
  migrationCardLabel, migrationVersionPath, type PreservedMigration,
} from "./migration";
import { migrationUiCopy, migrationReason } from "./migration-ui-copy";
import {
  assessJournalTrust, journalProofMatches, journalHoldMessage, journalHoldExplanation,
  type JournalTrust
} from "./journal-lineage";

// The same Web APIs and Obsidian Vault APIs run on macOS, Windows, Linux,
// Android and iOS. Never import Node/Electron into this plugin bundle.
type Base = TrackedFile;
type Pending = PendingMutation;
type SyncIssue = { path: string; reason: string };
type StoredUndoReview = UndoReview & { scope: string; capturedAt: number };
type Settings = {
  displayName: string;
  serverUrl: string;
  authMode: "device" | "tailnet";
  discoveryUrl: string;
  serverDeviceId: string;
  vaultId: string;
  deviceId: string;
  contentScope: SyncContentScope;
  deviceContentScope: DeviceContentScope;
  serverMediaBypassExtensions: string[];
  deviceMediaBypassExtensions: string[];
  cursor: number;
  journalLineage: string;
  journalProof: string;
  tombstoneProofs: Record<string, DeletionProof>;
  baselines: Record<string, Base>;
  pending: Pending[];
  pendingWrites: StagedWrite[];
  applyRemoteDeletes: boolean;
  syncIssues: SyncIssue[];
  undoReviews: StoredUndoReview[];
  migrations: Record<string, PreservedMigration>;
  yjsIds: Record<string, string>;
  scope: string;
  archivedScopes: Array<{
    scope: string;
    journalLineage?: string;
    journalProof?: string;
    cursor: number;
    tombstoneProofs?: Record<string, DeletionProof>;
    baselines: Record<string, Base>;
    pending: Pending[];
    pendingWrites: StagedWrite[];
    syncIssues: SyncIssue[];
    yjsIds: Record<string, string>;
  }>;
};
type RemoteFile = Base & { path: string; size: number };
type Manifest = { vaultId: string; vaultSeq: number; journalLineage?: string;
  headProof?: string | null; files: RemoteFile[] };
type OperationResult = {
  vaultId: string;
  seq: number;
  opId: string;
  fileId: string;
  generationId: string;
  type: string;
  hash: string | null;
  path: string;
  toPath?: string | null;
};

const DEFAULT: Settings = {
  displayName: "",
  serverUrl: "", authMode: "device", discoveryUrl: "", serverDeviceId: "", vaultId: "", deviceId: "",
  contentScope: "all",
  deviceContentScope: "follow-server",
  serverMediaBypassExtensions: [], deviceMediaBypassExtensions: [],
  cursor: 0, journalLineage: "", journalProof: "", tombstoneProofs: {}, baselines: {}, pending: [], pendingWrites: [],
  applyRemoteDeletes: false, syncIssues: [], undoReviews: [], migrations: {}, yjsIds: {},
  scope: "", archivedScopes: []
};
const MAX_FILE_BYTES = 4 * 1024 * 1024;
class AttachmentStillWriting extends Error {}
const textEncoder = new TextEncoder();

function safeBypassList(value: unknown): string[] {
  try { return [...normalizeMediaBypassExtensions(value as string[])]; }
  catch { return []; }
}

function isSyncablePath(path: string): boolean {
  const parts = path.split("/");
  return !!path && !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !parts.some((part) => {
      const lower = part.toLowerCase();
      return !part || part === "." || part === ".." ||
        [".obsidian", ".git", ".ignis-connector", ".trash"].includes(lower) ||
        lower.startsWith(".ignis-sync-tmp-") ||
        lower.startsWith(".ignis-collab-tmp-");
    });
}
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md") && isSyncablePath(path);
}

function encodeBase64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}
function validServerUrl(input: string): string {
  return normalizeOrigin(input);
}

async function sha256(content: Uint8Array): Promise<string> {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

// An HTTPS Discovery answer is an address hint, NOT identity proof. Never
// send a bearer token to a newly discovered origin without user approval.
async function discover(discoveryUrl: string, serverDeviceId: string): Promise<string[]> {
  const base = new URL(discoveryUrl);
  if (base.protocol !== "https:") throw new Error("Discovery must use HTTPS");
  base.searchParams.set("device", serverDeviceId);
  const response = await requestUrl({ url: base.toString(), method: "GET" });
  if (response.status !== 200 || !Array.isArray(response.json?.addresses)) {
    throw new Error("Discovery did not return addresses");
  }
  return response.json.addresses.filter((raw: unknown) => {
    if (typeof raw !== "string") return false;
    try { validServerUrl(raw); return true; }
    catch { return false; }
  });
}

class NativeMobileActionsModal extends Modal {
  private stateText: HTMLElement | null = null;
  constructor(app: IgnisConnector["app"], private readonly currentStatus: () => string,
    private readonly addFiles: () => void,
    private readonly showPeople: () => void) {
    super(app);
  }
  onOpen() {
    const t = mobileUiCopy();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Ignis" });
    this.stateText = contentEl.createEl("p");
    this.refreshStatus();
    new Setting(contentEl).setName(t.upload)
      .addButton(button => button.setButtonText(t.chooseFile)
        .onClick(() => { this.close(); this.addFiles(); }));
    new Setting(contentEl).setName(t.people)
      .addButton(button => button.setButtonText(t.openPeople)
        .onClick(() => { this.close(); this.showPeople(); }));
  }
  refreshStatus() {
    if (this.stateText) this.stateText.textContent = mobileUiCopy().status + ": " + this.currentStatus();
  }
  onClose() { this.stateText = null; }
}

export default class IgnisConnector extends Plugin {
  declare settings: Settings;
  private fileScope = createContentScope();
  private devicePolicy(
    deviceScope = this.settings.deviceContentScope || "follow-server",
    deviceBypass: readonly string[] = this.settings.deviceMediaBypassExtensions || [],
    serverScope = this.settings.contentScope || "all",
    serverBypass: readonly string[] = this.settings.serverMediaBypassExtensions || [],
  ) {
    return createContentScope(
      effectiveContentScope(serverScope, deviceScope),
      effectiveMediaBypassExtensions(serverScope, deviceScope,
        serverBypass, deviceBypass)
    );
  }
  private canShare(path: string): boolean {
    return this.fileScope.allowsPath(path);
  }
  private rebuildFileScope(): void {
    this.fileScope = this.devicePolicy();
  }
  getSharingDetails() {
    const files = typeof this.app?.vault?.getFiles === "function"
      ? this.app.vault.getFiles() : [];
    return { ...sharingSummary(
      files, this.settings.contentScope || "all",
      this.settings.deviceContentScope || "follow-server",
      this.settings.pending || [], this.settings.pendingWrites || [],
      this.settings.serverMediaBypassExtensions || [],
      this.settings.deviceMediaBypassExtensions || [],
    ), emptyFolders: this.emptyLocalFolders().length };
  }
  private emptyLocalFolders(): string[] {
    // Sync v1 has file operations, not directory identities. The user must
    // not mistake an empty folder visible in Obsidian for a saved remote
    // folder. Ordinary directories containing files are implicitly rebuilt.
    const entries = typeof this.app?.vault?.getAllLoadedFiles === "function"
      ? this.app.vault.getAllLoadedFiles() : [];
    return entries.filter((entry: any) =>
      entry && typeof entry.path === "string" && isSyncablePath(entry.path) &&
      Array.isArray(entry.children) && entry.children.length === 0
    ).map((entry: any) => entry.path);
  }
  getServerMediaBypassExtensions(): readonly string[] {
    return normalizeMediaBypassExtensions(
      this.settings.serverMediaBypassExtensions || []
    );
  }
  getDeviceMediaBypassExtensions(): readonly string[] {
    return normalizeMediaBypassExtensions(
      this.settings.deviceMediaBypassExtensions || []
    );
  }
  async setDeviceMediaBypassExtensions(value: readonly string[]): Promise<{
    ok: boolean; message: string;
  }> {
    let proposed: readonly string[];
    try { proposed = normalizeMediaBypassExtensions(value); }
    catch { return { ok: false, message: "Unsupported file extension selection." }; }
    if (!this.ready()) return { ok: false, message:
      "Verify the Ignis connection before changing media bypass." };
    if (this.syncing) return { ok: false, message:
      "A sync is running. Retry when it finishes." };
    const scope = this.settings.deviceContentScope || "follow-server";
    if (scope !== "markdown-only") return { ok: false, message:
      "Enable Keep attachments on this device to choose individual exceptions." };
    const selected = effectiveMediaBypassExtensions(
      this.settings.contentScope || "all", scope,
      this.settings.serverMediaBypassExtensions || [], proposed
    );
    if (selected.length !== proposed.length) return { ok: false, message:
      "The server has not authorized those file types. Ask the Mac owner to approve them." };
    const target = this.devicePolicy(scope, proposed);
    if ([...(this.settings.pending || []), ...(this.settings.pendingWrites || [])]
      .some((item) => !target.allowsPath(item.path) ||
        ("toPath" in item && typeof item.toPath === "string" &&
          !target.allowsPath(item.toPath)))) {
      return { ok: false, message:
        "Unsent operations for excluded files need review first." };
    }
    const previous = [...(this.settings.deviceMediaBypassExtensions || [])];
    this.settings.deviceMediaBypassExtensions = [...proposed];
    this.rebuildFileScope();
    try { await this.persistSettings(); }
    catch {
      this.settings.deviceMediaBypassExtensions = previous;
      this.rebuildFileScope();
      return { ok: false, message: "Could not save bypass; previous choice restored." };
    }
    this.schedule();
    return { ok: true, message: proposed.length
      ? "Selected types now use IGNIS Sync independently of Syncthing (4 MiB maximum)."
      : "Document/media exceptions disabled on this device." };
  }
  async setDeviceContentScope(value: DeviceContentScope): Promise<{
    ok: boolean; message: string;
  }> {
    if (value !== "markdown-only" && value !== "follow-server") {
      return { ok: false, message: "Unsupported device sharing preference." };
    }
    if (this.settings.deviceContentScope === value) {
      return { ok: true, message: "Device sharing preference is unchanged." };
    }
    if (this.syncing) {
      return { ok: false, message:
        "A sync is in progress. Retry this change after it finishes." };
    }
    const target = this.devicePolicy(value);
    const previousEffective = effectiveContentScope(
      this.settings.contentScope || "all",
      this.settings.deviceContentScope || "follow-server"
    );
    const queued: Array<{ path: string; toPath?: string }> = [
      ...(this.settings.pending || []),
      ...(this.settings.pendingWrites || []),
    ];
    const blocked = queued.filter((op) =>
      !target.allowsPath(op.path) || (op.toPath && !target.allowsPath(op.toPath))
    );
    if (blocked.length && (previousEffective !== target.mode ||
        blocked.some((op) => this.fileScope.allowsPath(op.path) ||
          (op.toPath && this.fileScope.allowsPath(op.toPath))))) {
      return { ok: false, message:
        blocked.length + " unsent attachment operation(s) require review. " +
        "The previous setting was preserved." };
    }
    const previous = this.settings.deviceContentScope || "follow-server";
    this.settings.deviceContentScope = value;
    this.rebuildFileScope();
    try {
      await this.persistSettings();
    } catch {
      this.settings.deviceContentScope = previous;
      this.rebuildFileScope();
      return { ok: false, message:
        "Could not save the device preference. The previous setting was restored." };
    }
    this.schedule();
    return { ok: true, message: value === "markdown-only"
      ? "Attachments stay on this device. Markdown remains shared."
      : "Using the server's allowed file types on this device." };
  }
  async recheckSharingScope(): Promise<{ ok: boolean; message: string }> {
    if (!this.ready()) {
      return { ok: false, message:
        "Verify your Ignis connection before checking server sharing rules." };
    }
    if (this.syncing) {
      return { ok: false, message:
        "Finish the current sync before rechecking the server's sharing rules." };
    }
    const scope = this.settings.scope;
    const deviceId = this.settings.deviceId;
    const vaultId = this.settings.vaultId;
    const attempt = this.connectionAttempt;
    try {
      const reply = await this.deviceRequest(
        "/vaults/" + encodeURIComponent(vaultId) + "/session"
      );
      const session = reply.json;
      if (scope !== this.settings.scope || deviceId !== this.settings.deviceId ||
          vaultId !== this.settings.vaultId || attempt !== this.connectionAttempt ||
          session?.vaultId !== vaultId || session?.deviceId !== deviceId ||
          !["all", "markdown-only"].includes(session.contentScope)) {
        return { ok: false, message:
          "Server identity or sharing rules could not be verified; settings unchanged." };
      }
      let serverBypass: string[];
      try {
        serverBypass = [...normalizeMediaBypassExtensions(
          session.mediaBypassExtensions || []
        )];
      } catch {
        return { ok: false, message:
          "Server returned invalid file sharing exceptions; settings unchanged." };
      }
      const target = this.devicePolicy(
        this.settings.deviceContentScope || "follow-server",
        this.settings.deviceMediaBypassExtensions || [],
        session.contentScope, serverBypass
      );
      const pending: Array<{ path: string; toPath?: string }> = [
        ...(this.settings.pending || []),
        ...(this.settings.pendingWrites || []),
      ];
      if (pending.some((item) =>
        !target.allowsPath(item.path) ||
        (item.toPath && !target.allowsPath(item.toPath)))) {
        return { ok: false, message:
          "Unsent attachment operations conflict with the server's rules. " +
          "Resolve those operations before changing the sharing scope." };
      }
      if (session.contentScope !== this.settings.contentScope ||
          JSON.stringify(serverBypass) !==
            JSON.stringify(this.settings.serverMediaBypassExtensions || [])) {
        const previousScope = this.settings.contentScope;
        const previousBypass = this.settings.serverMediaBypassExtensions || [];
        this.settings.contentScope = session.contentScope;
        this.settings.serverMediaBypassExtensions = serverBypass;
        this.rebuildFileScope();
        try { await this.persistSettings(); }
        catch {
          this.settings.contentScope = previousScope;
          this.settings.serverMediaBypassExtensions = previousBypass;
          this.rebuildFileScope();
          return { ok: false, message:
            "Could not save verified sharing rules; previous state retained." };
        }
        this.schedule();
      }
      return { ok: true, message:
        (session.contentScope === "markdown-only"
          ? "Server: Markdown only." : "Server: Markdown + small attachments.") +
        (this.settings.deviceContentScope === "markdown-only"
          ? " This device keeps attachments locally except selected bypass types." : "") +
        (serverBypass.length ? " Allowed bypass: " + serverBypass.join(", ") + "." : "") };
    } catch {
      return { ok: false, message:
        "Could not check current sharing rules. Local files remain unchanged." };
    }
  }
  private incomingLink = "";
  private token = "";
  // Whether a verified *session* also has a verified restart-safe token.
  private credentialDurability: SecretDurability = "verified";
  private socket: WebSocket | null = null;
  private syncing = false;
  private syncDrain: Promise<void> | null = null;
  private releaseSyncDrain: (() => void) | null = null;
  private migrationBusy = false;
  private queued = false;
  private quiet = new Set<string>();
  private status: HTMLElement | null = null;
  private collaborationRibbon: HTMLElement | null = null;
  private mobileActions: HTMLElement | null = null;
  private mobileConnection: HTMLButtonElement | null = null;
  private mobileConnectionDot: HTMLElement | null = null;
  private mobileMenu: NativeMobileActionsModal | null = null;
  private migrationModal: MigrationModal | null = null;
  private undoReviewModal: UndoReviewModal | null = null;
  private unmountMobileNavbar: (() => void) | null = null;
  private statusText = "Not connected";
  private timer: number | null = null;
  private lastError = "";
  private live!: NativeYjs;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private needsReload = false;
  private authBlocked = false;
  private retryCount = 0;
  private persistTail: Promise<void> = Promise.resolve();
  private connectionAttempt = 0;
  // Highest durable server sequence evidenced by this client's operation
  // receipts. A manifest below this frontier cannot certify a full sync.
  private latestOperationReceipt: { scope: string; seq: number } | null = null;
  // Explanations are a projection of durable pending opIds, not another
  // authority. Recomputed on replay after restart; never used to drop data.
  private outboundFailures = new Map<string, string>();
  private historyHold: Extract<JournalTrust,{state:"hold"}>["reason"] | null = null;
  private observeOperationReceipt(seq: number): void {
    const scope = this.settings.scope;
    const previous = this.latestOperationReceipt;
    this.latestOperationReceipt = {
      scope,
      seq: previous?.scope === scope ? Math.max(previous.seq, seq) : seq
    };
  }

  private persistSettings(): Promise<void> {
    // Obsidian Plugin.saveData is asynchronous. Two overlapping Vault events
    // must never let an older JSON snapshot overwrite a newer pending opId.
    // Snapshot at enqueue time and write in FIFO order, including failures.
    const snapshot = JSON.parse(JSON.stringify(this.settings)) as Settings;
    const next = this.persistTail.catch(() => {}).then(() =>
      this.saveData(snapshot));
    this.persistTail = next;
    return next;
  }

  async onload() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = {
      ...DEFAULT, ...saved,
      contentScope: saved?.contentScope === "markdown-only" ? "markdown-only" : "all",
      deviceContentScope: saved?.deviceContentScope === "markdown-only"
        ? "markdown-only" : "follow-server",
      serverMediaBypassExtensions: safeBypassList(saved?.serverMediaBypassExtensions),
      deviceMediaBypassExtensions: safeBypassList(saved?.deviceMediaBypassExtensions),
      displayName: normalizeDisplayName(
        typeof saved?.displayName === "string" ? saved.displayName : ""
      ),
      baselines: saved?.baselines || {},
      journalLineage: typeof saved?.journalLineage === "string" ? saved.journalLineage : "",
      journalProof: typeof saved?.journalProof === "string" ? saved.journalProof : "",
      tombstoneProofs: saved?.tombstoneProofs || {},
      pending: saved?.pending || [],
      pendingWrites: saved?.pendingWrites || [],
      applyRemoteDeletes: saved?.applyRemoteDeletes === true,
      syncIssues: saved?.syncIssues || [],
      undoReviews: Array.isArray(saved?.undoReviews)
        ? saved.undoReviews.filter((entry): entry is StoredUndoReview =>
          typeof entry?.scope === "string" &&
          typeof entry?.path === "string" &&
          typeof entry?.deleted === "string" && entry.deleted.length <= MAX_FILE_BYTES &&
          (entry?.operation === "undo" || entry?.operation === "redo") &&
          (entry?.reason === "boundary-removed" || entry?.reason === "target-changed") &&
          typeof entry?.context === "string" &&
          (entry?.documentId === null || typeof entry?.documentId === "string") &&
          typeof entry?.capturedAt === "number") : [],
      migrations: saved?.migrations || {},
      yjsIds: saved?.yjsIds || {},
      archivedScopes: saved?.archivedScopes || []
    };
    this.rebuildFileScope();
    if (!this.settings.scope && this.settings.serverUrl && this.settings.vaultId) {
      try { this.settings.scope = this.currentScope(); } catch { /* unconfigured */ }
    }
    // Obsidian's editor is CodeMirror 6 on desktop and mobile. The Yjs
    // extension is inert until the per-file identity and native text agree.
    this.live = new NativeYjs({
      vaultId: () => this.settings.vaultId,
      origin: () => this.settings.serverUrl,
      pathForView: (view) => view.state.field(editorInfoField, false)?.file?.path || null,
      knownId: (path) => this.settings.yjsIds[path] || null,
      fileBaseline: (path) => this.settings.baselines[path] || null,
      rememberId: async (path, id) => {
        this.settings.yjsIds[path] = id;
        await this.persistSettings();
      },
      displayName: () => this.getDisplayName(),
      mobile: Platform.isMobile,
      send: (message) => {
        if (!this.historyHold && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify(message));
        }
      },
      notify: (path, status) => {
        this.lastError = path + ": " + status;
        if (/\b(?:Undo|Redo) needs review\b/.test(status)) {
          this.rememberUndoReviews();
          // The status bar may be hidden on mobile; preserve the review in
          // the collaborator menu and use only one notice per new incident.
          new Notice(mobileUiLanguage() === "ja"
            ? "元に戻す位置を確定できません。Ignisの共同編集者から操作を確認できます。"
            : "Cannot safely place the edit. Open Ignis collaborators to review.", 7000);
          // A document-level Undo incident is NOT a transport/save status.
          // Keep the last grounded Sync status; the review count is a
          // separate persistent overlay and remains after another ACK.
          this.showStatus(this.statusText);
        } else {
          this.showStatus(status);
        }
      },
      compositionChanged: (path) => {
        if (this.app.workspace.getActiveFile()?.path === path) {
          this.renderStatus();
        }
      }
    });
    this.registerEditorExtension(this.live.extension());
    // Obsidian mobile does not support the desktop status bar API.
    if (!Platform.isMobile) this.status = this.addStatusBarItem();
    this.showStatus("Not connected");
    this.addSettingTab(new ConnectorSettings(this.app, this));
    // Mobile ribbon entries appear in Obsidian's bottom navigation menu.
    // These commands are also accessible from the command palette when the
    // keyboard is open or a floating participants control is obstructed.
    this.collaborationRibbon = this.addRibbonIcon(
      "users", "Ignis collaborators and display name", () =>
        this.openCollaborators()
    );
    this.addRibbonIcon("upload", "Import files to this Obsidian Vault", () =>
      this.openFilePicker());
    if (Platform.isMobile) this.createMobileActions();
    this.showStatus(this.statusText);
    this.registerEvent(this.app.workspace.on("active-leaf-change",
      () => this.renderStatus()));
    this.addCommand({
      id: "show-collaborators",
      name: "Show collaborators and display name",
      callback: () => this.openCollaborators()
    });
    this.addCommand({
      id: "review-undo",
      name: "Review pending Undo / Redo edits",
      callback: () => this.openUndoReview()
    });
    this.addCommand({
      id: "change-display-name",
      name: "Change my Ignis display name",
      callback: () => this.openDisplayName()
    });
    this.addCommand({
      id: "import-files-to-vault",
      name: "Import files into this Obsidian Vault",
      callback: () => this.openFilePicker()
    });
    this.registerObsidianProtocolHandler("ignis-connector", (params) => {
      if (typeof params.link !== "string") return;
      try {
        parseJoinLink(params.link);
        this.incomingLink = params.link;
        (this.app as any).setting?.open();
        (this.app as any).setting?.openTabById?.(this.manifest.id);
      } catch {
        new Notice("Invalid Ignis connection link");
      }
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync with Ignis now",
      callback: () => void this.syncNow()
    });
    this.addCommand({
      id: "discover-server",
      name: "Check Syncthing Discovery addresses",
      callback: () => void this.inspectDiscovery()
    });
    this.addCommand({
      id: "show-sync-issues",
      name: "Review Ignis sync issues",
      callback: () => this.openSyncIssues()
    });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && this.canShare(file.path) && !this.quiet.has(file.path)) {
        this.schedule();
      }
    }));
    // A newly created note or attachment does not have to emit a later
    // "modify" event. Both Connector sites should see it without a 45s poll.
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && this.canShare(file.path) && !this.quiet.has(file.path)) {
        this.schedule();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || this.quiet.has(file.path) ||
          !this.canShare(oldPath) || !this.canShare(file.path)) return;
      if (!this.live.relocate(oldPath, file.path)) return;
      const yjsId = this.settings.yjsIds[oldPath];
      if (yjsId) {
        this.settings.yjsIds[file.path] = yjsId;
        delete this.settings.yjsIds[oldPath];
      }
      const tracked = localPaths(this.settings).has(oldPath);
      const queued = queueRename(this.settings, oldPath, file.path, crypto.randomUUID());
      if (tracked && !queued) {
        this.lastError = "Cannot queue conflicting local rename: " + oldPath;
        this.showStatus("Rename needs review");
      }
      void this.persistSettings().then(() => this.schedule());
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFile) || this.quiet.has(file.path) ||
          !this.canShare(file.path)) return;
      queueDelete(this.settings, file.path, crypto.randomUUID());
      void this.persistSettings().then(() => this.schedule());
    }));
    this.registerInterval(window.setInterval(() => this.schedule(), 45000));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    // iOS suspends the WebView rather than reliably firing WebSocket close.
    // An apparently OPEN socket can be dead after wake or a network handoff.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.recoverConnection();
    });
    this.registerDomEvent(window, "pageshow", () => this.recoverConnection());
    this.registerDomEvent(window, "online", () => this.recoverConnection());
    this.token = await this.getSavedSecret();
    this.credentialDurability = this.token ? "verified" : "session-only";
    if (this.ready()) {
      this.connectSocket();
      this.schedule();
    } else if (this.settings.vaultId && this.settings.serverUrl &&
        this.settings.authMode === "device") {
      this.showStatus("Reconnect · device token required · local notes retained");
    }
  }

  takeIncomingLink(): string {
    const link = this.incomingLink;
    this.incomingLink = "";
    return link;
  }

  getDisplayName(): string {
    return effectiveDisplayName(
      this.settings.displayName || "", this.settings.deviceId
    );
  }

  async setDisplayName(value: string) {
    const next = normalizeDisplayName(value);
    if (this.settings.displayName === next) return;
    this.settings.displayName = next;
    await this.persistSettings();
    // Existing live peers should see this change immediately, without
    // disconnecting the socket or destroying unsaved editor CRDT state.
    this.live.updateDisplayName();
  }

  openDisplayName() {
    new DisplayNameModal(this.app, this).open();
  }

  openCollaborators() {
    new CollaboratorsModal(this.app, this).open();
  }

  getUndoReviews(): UndoReview[] {
    const scope = this.settings?.scope;
    const reviews = new Map<string, UndoReview>();
    for (const stored of this.settings?.undoReviews || []) {
      if (stored.scope === scope) {
        reviews.set([stored.path, stored.documentId, stored.operation].join("|"), stored);
      }
    }
    for (const review of this.live?.pendingUndoReviews?.() || []) {
      reviews.set([review.path, review.documentId, review.operation].join("|"), review);
    }
    return [...reviews.values()];
  }
  private rememberUndoReviews(): void {
    const scope = this.settings.scope;
    if (!scope) return;
    const reviews = this.live?.pendingUndoReviews?.() || [];
    if (!reviews.length) return;
    const current = this.settings.undoReviews || [];
    const retained = current.filter(entry =>
      !reviews.some(review => review.path === entry.path &&
        review.documentId === entry.documentId &&
        review.operation === entry.operation && entry.scope === scope));
    this.settings.undoReviews = [
      ...retained,
      ...reviews.map(review => ({ ...review, scope, capturedAt: Date.now() }))
    ];
    // The review remains private to this Obsidian device. It must never be
    // uploaded as a Markdown document or merged into a different Vault.
    void this.persistSettings().catch(() => {
      new Notice("Ignis could not save the Undo review. Copy its text before closing Obsidian.");
    });
  }
  dismissUndoReview(review: UndoReview): boolean {
    const scope = this.settings?.scope;
    const previous = this.settings?.undoReviews || [];
    const retained = previous.filter(entry => !(entry.scope === scope &&
      entry.path === review.path && entry.documentId === review.documentId &&
      entry.operation === review.operation));
    const removedSaved = retained.length !== previous.length;
    const removedLive =
      this.live?.dismissUndoReview?.(review.path, review.documentId) || false;
    if (!removedSaved && !removedLive) return false;
    this.settings.undoReviews = retained;
    void this.persistSettings().catch(() =>
      new Notice("Could not save the acknowledgement. Review may reappear after restart."));
    this.showStatus(this.statusText);
    return true;
  }
  openUndoReview() {
    if (!this.getUndoReviews().length) {
      new Notice(mobileUiLanguage() === "ja"
        ? "確認が必要なUndo・Redoはありません。"
        : "No Undo or Redo edits need review.");
      return;
    }
    if (this.undoReviewModal) {
      this.undoReviewModal.refresh();
      return;
    }
    this.undoReviewModal = new UndoReviewModal(this.app, this);
    this.undoReviewModal.open();
  }
  undoReviewModalClosed(modal: UndoReviewModal) {
    if (this.undoReviewModal === modal) this.undoReviewModal = null;
  }
  getCurrentStatus(): string {
    const currentPath = this.app?.workspace?.getActiveFile?.()?.path || null;
    const composition = this.live?.compositionState?.(currentPath);
    const count = this.getUndoReviews().length;
    const status = this.historyHold ? journalHoldMessage(this.historyHold) :
      composition?.composing
      ? this.statusText.replace(
        /^(?:Synced · server acknowledged|Server persisted collaborative edits)$/,
        "Server has received provisional text") +
        " · IME not confirmed" +
        (composition.peerEditWaiting ? " · peer edit waiting" : "")
      : this.statusText;
    const credentialWarning = this.ready() &&
      this.settings.authMode === "device" &&
      this.credentialDurability !== "verified"
      ? " · device token not saved" : "";
    return status + credentialWarning + (count
      ? (mobileUiLanguage() === "ja"
        ? " · Undo/Redo " + count + "件を確認"
        : " · " + count + " Undo/Redo need review") : "");
  }
  private createMobileActions(): void {
    const action = document.createElement("div");
    action.className = "mobile-navbar-action ignis-connector-navbar-action";
    action.style.position = "relative";
    action.style.minWidth = "36px";
    const connection = document.createElement("button");
    connection.type = "button";
    connection.className = "ignis-connector-navbar-trigger";
    connection.setAttribute("aria-haspopup", "dialog");
    Object.assign(connection.style, {
      position: "relative", border: "0", padding: "0", background: "transparent",
      color: "var(--text-normal)", touchAction: "manipulation",
      width: "100%", height: "100%", display: "flex",
      alignItems: "center", justifyContent: "center"
    });
    setIcon(connection, "flame");
    const dot = document.createElement("span");
    Object.assign(dot.style, {
      position: "absolute", top: "calc(50% - 20px)", left: "calc(50% + 8px)",
      width: "9px", height: "9px", borderRadius: "50%",
      border: "2px solid var(--background-primary)",
      background: "var(--text-muted)", pointerEvents: "none"
    });
    dot.setAttribute("aria-hidden", "true");
    connection.appendChild(dot);
    connection.addEventListener("click", () => {
      this.mobileMenu?.close();
      this.mobileMenu = new NativeMobileActionsModal(this.app,
        () => nativeConnectionState(this.getCurrentStatus(), this.ready(),
          this.socket?.readyState === WebSocket.OPEN, mobileUiLanguage()).label,
        () => this.openFilePicker(),
        () => this.openCollaborators());
      this.mobileMenu.open();
    });
    action.appendChild(connection);
    this.unmountMobileNavbar = mountMobileNavbarAction(action);
    this.mobileActions = action;
    this.mobileConnection = connection;
    this.mobileConnectionDot = dot;
  }
  private openFilePicker(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.className = "ignis-native-upload-input";
    input.setAttribute("aria-label", "Choose files for Obsidian Vault");
    Object.assign(input.style, {
      position: "fixed", width: "1px", height: "1px",
      opacity: "0", left: "-100px", top: "0"
    });
    const cleanup = () => input.remove();
    input.addEventListener("cancel", cleanup, { once: true });
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      if (!files.length) { cleanup(); return; }
      try {
        new Notice("Importing " + files.length + " file(s) into Obsidian…");
        const outcome = await importNativeFiles(
          this.app.vault, files, isSyncablePath, MAX_FILE_BYTES
        );
        if (outcome.imported) {
          this.showStatus(this.ready() ? "Syncing" : "Pending · locally retained");
          this.schedule();
          new Notice("Imported " + outcome.imported + " file(s)." +
            (effectiveContentScope(this.settings.contentScope,
              this.settings.deviceContentScope || "follow-server") === "markdown-only"
              ? " Markdown files sync; attachments stay on this device."
              : " Ignis sync queued."));
        }
        if (outcome.failed || outcome.tooLarge) {
          new Notice("Skipped " + (outcome.failed + outcome.tooLarge) +
            " file(s); Ignis Sync supports attachments up to 4 MiB.", 6000);
        }
      } finally {
        cleanup();
      }
    });
    document.body.appendChild(input);
    // Keep input.click() on the same synchronous user gesture for iOS WebView.
    input.click();
  }

  openSyncIssues() {
    const queued: SyncIssue[] = [
      ...(this.settings.pending || []).map((operation) => ({
        path: operation.path,
        reason: "Unsent " + operation.type +
          (operation.toPath ? " to " + operation.toPath : "") +
          (this.outboundFailures.has(operation.opId)
            ? "; server conflict: " + this.outboundFailures.get(operation.opId) +
              ". Local operation retained for review."
            : "; retained until the server acknowledges it."),
      })),
      ...(this.settings.pendingWrites || []).map((operation) => ({
        path: operation.path,
        reason: "Unsent " + operation.type +
          (this.outboundFailures.has(operation.opId)
            ? "; server conflict: " + this.outboundFailures.get(operation.opId) +
              ". Staged bytes retained for review."
            : "; staged bytes are retained for safe retry."),
      })),
    ];
    const issues = [...(this.settings.syncIssues || []), ...queued];
    if (this.migrationModal) {
      // Reuse the one active dialog. A close/open pair on iOS can leave the
      // previous backdrop in the DOM while its dismissal animation runs.
      this.migrationModal.refresh(issues, this.lastError);
      return;
    }
    this.migrationModal = new MigrationModal(this.app, this, issues, this.lastError);
    this.migrationModal.open();
  }

  migrationModalClosed(modal: MigrationModal) {
    if (this.migrationModal === modal) this.migrationModal = null;
  }

  getMigrationIssues(): SyncIssue[] {
    const issues = [...(this.settings.syncIssues || [])];
    const seen = new Set(issues.map(issue => issue.path));
    for (const path of this.live.blockingPaths()) {
      if (!seen.has(path)) {
        issues.push({ path, reason: "Live editor blocked; local draft retained" });
      }
    }
    return issues.filter(issue => migrationNeedsPreservation(issue.reason));
  }

  getPreservedMigration(path: string): PreservedMigration | undefined {
    const record = this.settings.migrations?.[path];
    return record?.scope === this.settings.scope ? record : undefined;
  }

  private async snapshotMigrationSource(path: string): Promise<{
    data: string | ArrayBuffer; hash: string
  }> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("Local version is no longer available");
    let data: string | ArrayBuffer;
    if (isMarkdown(path)) {
      // A native CodeMirror pane can contain edits not yet flushed to disk.
      // Preserve what the user actually sees, not a potentially stale file.
      const pane = this.app.workspace.getLeavesOfType("markdown")
        .find(leaf => (leaf.view as any).file?.path === path);
      const editor = (pane?.view as any)?.editor;
      data = typeof editor?.getValue === "function" ?
        editor.getValue() : await this.app.vault.read(file);
    } else {
      data = await this.app.vault.readBinary(file);
    }
    const bytes = typeof data === "string" ? textEncoder.encode(data) :
      new Uint8Array(data);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("This version exceeds the 4 MiB sync limit; local original is retained");
    }
    return { data, hash: await sha256(bytes) };
  }

  private async ensureMigrationCopy(
    original: string, role: "device" | "server", identity: string,
    value: string | ArrayBuffer, digest: string, remoteFiles: RemoteFile[]
  ): Promise<string> {
    for (let index = 0; index < 100; index++) {
      const candidate = migrationVersionPath(original, role, identity, digest, index);
      if (!this.canShare(candidate)) throw new Error("Saved version is outside the sharing policy");
      const local = this.app.vault.getAbstractFileByPath(candidate);
      const remote = remoteFiles.find(file => file.path === candidate);
      if (local && !(local instanceof TFile)) continue;
      if (local && await this.localHash(local) !== digest) continue;
      if (remote && remote.hash !== digest) continue;
      if (!local) {
        await this.writeLocal(candidate, value);
      }
      const saved = this.app.vault.getAbstractFileByPath(candidate);
      if (!(saved instanceof TFile) || await this.localHash(saved) !== digest) {
        throw new Error("Could not verify the saved local copy: " + candidate);
      }
      if (remote) {
        this.saveBase(candidate, remote);
        await this.persistSettings();
      } else {
        // Staged immutable payload + operation ID are persisted before sending.
        // On a lost ACK replayWrites() verifies the server receipt. Neither
        // failure nor a competitor's CREATE_CONFLICT deletes the local copy.
        await this.stageAndSend("create", saved);
      }
      if (this.settings.baselines[candidate]?.hash !== digest) {
        throw new Error("Server has not acknowledged the saved version");
      }
      return candidate;
    }
    throw new Error("Could not allocate an independent version filename");
  }

  async previewMigration(path: string): Promise<{
    local: string | null; remote: string | null; sourceHash: string | null;
    remoteHash: string | null; saved: PreservedMigration | null;
  }> {
    if (!this.ready() || !this.canShare(path)) {
      throw new Error("Verify the Vault connection before comparing versions");
    }
    const manifest = await this.api("/vaults/" +
      encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
    const remote = manifest.files.find(file => file.path === path) || null;
    const localFile = this.app.vault.getAbstractFileByPath(path);
    const local = localFile instanceof TFile ?
      await this.snapshotMigrationSource(path) : null;
    const remoteBytes = remote ? await this.remoteBytes(remote) : null;
    return {
      local: local && typeof local.data === "string" ? local.data : null,
      remote: remoteBytes && isMarkdown(path) ?
        new TextDecoder().decode(remoteBytes) : null,
      sourceHash: local?.hash || null,
      remoteHash: remote?.hash || null,
      saved: local && isMigrationRecordCurrent(
        this.settings.migrations?.[path], this.settings.scope, local.hash, remote
      ) ? this.settings.migrations[path] : null,
    };
  }

  private async withMigrationLock<T>(work: () => Promise<T>): Promise<T> {
    // A routine background sync must not turn a user's explicit decision to
    // preserve two originals into a flaky Retry button. Wait for the active
    // pass and acquire the preservation lock before another pass can begin.
    while (this.syncing) {
      const active = this.syncDrain;
      if (!active) throw new Error("Cannot verify completion of the active sync");
      await active;
    }
    if (this.migrationBusy) {
      throw new Error("Another version preservation operation is in progress");
    }
    this.migrationBusy = true;
    try { return await work(); }
    finally {
      this.migrationBusy = false;
      if (this.queued) { this.queued = false; this.schedule(); }
    }
  }

  async preserveMigration(path: string): Promise<PreservedMigration> {
    return this.withMigrationLock(() => this.preserveMigrationUnlocked(path));
  }

  private async preserveMigrationUnlocked(path: string): Promise<PreservedMigration> {
    if (this.historyHold) {
      throw new Error("Server history is not verified. Restore or reconnect to the original journal before saving copies.");
    }
    if (!this.ready() || !this.canShare(path) || this.syncing ||
        this.settings.pending.some(operation => operation.path === path ||
          operation.toPath === path)) {
      throw new Error("Connection or a rename/delete of this document is busy; retry after sync");
    }
    if (!this.getMigrationIssues().some(issue => issue.path === path)) {
      throw new Error("No unresolved collision on this path");
    }
    const source = await this.snapshotMigrationSource(path);
    const manifest = await this.api("/vaults/" +
      encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
    const remote = manifest.files.find(file => file.path === path) || null;
    const existing = this.settings.migrations?.[path];
    const verifiedCopy = async (copyPath: string, expected: string) => {
      const file = this.app.vault.getAbstractFileByPath(copyPath);
      const serverCopy = manifest.files.find(item => item.path === copyPath);
      return file instanceof TFile && await this.localHash(file) === expected &&
        serverCopy?.hash === expected &&
        this.settings.baselines[copyPath]?.hash === expected;
    };
    if (isMigrationRecordCurrent(existing, this.settings.scope, source.hash, remote) &&
        await verifiedCopy(existing!.sourceCopy, source.hash) &&
        (!remote || (existing!.remoteCopy &&
          await verifiedCopy(existing!.remoteCopy, remote.hash)))) {
      return existing!;
    }
    const remoteData = remote ? await this.remoteBytes(remote) : null;
    const sourceCopy = await this.ensureMigrationCopy(
      path, "device", this.settings.deviceId, source.data, source.hash, manifest.files
    );
    const remoteCopy = remote && remoteData ? await this.ensureMigrationCopy(
      path, "server", remote.generationId,
      isMarkdown(path) ? new TextDecoder().decode(remoteData) : remoteData,
      remote.hash, manifest.files
    ) : null;
    // Durable ACK of both distinct paths is mandatory before recording success.
    const record: PreservedMigration = {
      scope: this.settings.scope, path, sourceHash: source.hash,
      sourceCopy, remoteHash: remote?.hash || null, remoteCopy,
      remoteFileId: remote?.fileId || null,
      remoteGenerationId: remote?.generationId || null,
    };
    this.settings.migrations ||= {};
    this.settings.migrations[path] = record;
    await this.persistSettings();
    return record;
  }

  async finishMigration(path: string): Promise<void> {
    return this.withMigrationLock(() => this.finishMigrationUnlocked(path));
  }

  private async finishMigrationUnlocked(path: string): Promise<void> {
    if (this.historyHold) {
      throw new Error("Server history is not verified. The previous originals remain protected.");
    }
    const record = this.settings.migrations?.[path];
    if (!record || record.scope !== this.settings.scope || !record.remoteFileId ||
        !record.remoteCopy || this.syncing || !this.ready() ||
        this.openInEditor(path) || this.live.isManaged(path)) {
      throw new Error("Save both versions and close the original editor first");
    }
    const original = await this.snapshotMigrationSource(path);
    const backup = this.app.vault.getAbstractFileByPath(record.sourceCopy);
    const remoteBackup = this.app.vault.getAbstractFileByPath(record.remoteCopy);
    if (original.hash !== record.sourceHash || !(backup instanceof TFile) ||
        !(remoteBackup instanceof TFile) ||
        await this.localHash(backup) !== record.sourceHash ||
        await this.localHash(remoteBackup) !== record.remoteHash ||
        this.settings.baselines[record.sourceCopy]?.hash !== record.sourceHash ||
        this.settings.baselines[record.remoteCopy]?.hash !== record.remoteHash) {
      throw new Error("A version changed; save both again before migrating");
    }
    const manifest = await this.api("/vaults/" +
      encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
    const remote = manifest.files.find(file => file.path === path);
    const serverSourceCopy = manifest.files.find(file => file.path === record.sourceCopy);
    const serverRemoteCopy = manifest.files.find(file => file.path === record.remoteCopy);
    if (!remote || !isMigrationRecordCurrent(record, this.settings.scope,
        original.hash, remote) ||
        serverSourceCopy?.hash !== record.sourceHash ||
        serverRemoteCopy?.hash !== record.remoteHash) {
      throw new Error("Server version changed; preserve the new version first");
    }
    // A locally staged create/modify that lost its 409 race must not replay
    // AFTER the user has intentionally switched the original to the verified
    // shared version. Retire its opId on the server first, and only then
    // remove the local durable stage. Copies are already verified by hash.
    await this.retireObsoleteStages(path);
    const afterRetirement = await this.api("/vaults/" +
      encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
    const stillCurrent = afterRetirement.files.find(file => file.path === path);
    if (!stillCurrent || !isMigrationRecordCurrent(record, this.settings.scope,
        original.hash, stillCurrent)) {
      throw new Error("Server original changed during migration; copies retained for review");
    }
    const data = await this.remoteBytes(remote);
    // File generation and in-memory Yjs room are a single identity.
    // Retire the old (possibly blocked) room before replacing the original.
    // Otherwise an old room can immediately re-block this newly migrated file.
    await this.live.retireDocument?.(path);
    await this.writeLocal(path, isMarkdown(path) ? new TextDecoder().decode(data) : data);
    const changed = this.app.vault.getAbstractFileByPath(path);
    if (!(changed instanceof TFile) || await this.localHash(changed) !== remote.hash) {
      throw new Error("Server original could not be verified after migration");
    }
    // Old CRDT identity cannot be reused for a different generation.
    delete this.settings.yjsIds[path];
    this.saveBase(path, remote);
    await this.persistSettings();
    this.schedule();
  }

  currentParticipants() {
    const path = this.app.workspace.getActiveFile()?.path || null;
    return {
      path,
      peers: this.live.participants(path)
    };
  }

  jumpToParticipant(path: string, id: string) {
    return this.live.jumpToParticipant(path, id);
  }

  onunload() {
    this.migrationModal?.close();
    this.migrationModal = null;
    this.undoReviewModal?.close();
    this.undoReviewModal = null;
    this.mobileMenu?.close();
    this.unmountMobileNavbar?.();
    this.mobileActions = null;
    this.stopped = true;
    this.live.disconnected();
    void this.live.dispose();
    this.socket?.close();
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
  }

  private async getSavedSecret(): Promise<string> {
    const secrets = (this.app as any).secretStorage;
    if (!secrets || !this.settings.vaultId || !this.matchesScope()) return "";
    try {
      return secrets.getSecret(await scopedSecretId(this.settings.scope)) || "";
    } catch {
      // SecretStorage may be unavailable on older Obsidian builds. Retain
      // local files and allow an explicit verified connection again.
      return "";
    }
  }
  async connectToServer(draft: ConnectionDraft): Promise<{
    ok: boolean; message: string; memoryOnly?: boolean; availableVaults?: string[]
  }> {
    // Draft data is not persisted or used for any transport until one click.
    const attempt = ++this.connectionAttempt;
    let target: ReturnType<typeof validateConnection>;
    try {
      const link = parseJoinLink(draft.serverUrl);
      let vault = link.vaultId || draft.vaultId.trim();
      if (!vault) {
        const suggestion = await requestUrl({
          url: link.origin + "/api/sync/v1/link", method: "GET", throw: false
        });
        const vaults = suggestion?.status === 200 &&
          Array.isArray(suggestion.json?.vaults) ? suggestion.json.vaults : [];
        if (vaults.length !== 1) {
          return { ok: false, message: vaults.length > 1 ?
            "Choose the Vault you want to connect to." :
            "No Vault could be detected. Check Tailscale or specify the Vault in Advanced settings.",
            availableVaults: vaults.length > 1 ? vaults : undefined };
        }
        vault = vaults[0];
      }
      // Try identity-backed auth first. Reusing an old device token is only
      // an explicit fallback; never accidentally send it to another origin.
      target = validateConnection({
        serverUrl: link.origin, vaultId: vault, token: draft.token
      }, "", true);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const switching = !!this.settings.scope && this.settings.scope !== target.scope;
    if (switching && (this.settings.pending.length || this.settings.pendingWrites.length)) {
      return {
        ok: false,
        message: "Unsent local operations exist for the old Vault. Finish syncing those changes before switching servers."
      };
    }

    let session: { deviceId: string; vaultId: string; label?: string;
      journalLineage?: string;
      auth?: string; contentScope?: SyncContentScope;
      mediaBypassExtensions?: string[] };
    let selectedToken = target.token;
    try {
      const endpoint = target.origin + "/api/sync/v1/vaults/" +
        encodeURIComponent(target.vaultId) + "/session";
      const verify = (token: string) => requestUrl({
        url: endpoint, method: "GET", throw: false,
        headers: token ? { Authorization: "Bearer " + token } : {}
      });
      let response = await verify(selectedToken);
      const fallback = target.scope === this.settings.scope ?
        this.token || await this.getSavedSecret() : "";
      if (response.status === 401 && !selectedToken &&
          /^ignis_dev_[A-Za-z0-9_-]{43}$/.test(fallback)) {
        selectedToken = fallback;
        response = await verify(selectedToken);
      }
      const error = sessionError(response.status, response.json, target.vaultId);
      if (error) {
        return { ok: false, message: response.status === 401 && !selectedToken ?
          "Tailscale identity was not recognized for this Vault. Check Tailscale, or use a device token under Advanced settings." :
          error };
      }
      session = response.json;
      if (!session.journalLineage) {
        if (!switching && this.settings.journalLineage) {
          await this.pauseJournal("unsupported");
        }
        return { ok: false,
          message: "Ignis Server must be updated before a safe synchronization connection. Local files remain unchanged." };
      }
      if (!selectedToken && session.auth !== "tailnet") {
        return { ok: false, message: "Server did not confirm Tailscale authentication." };
      }
      if (session.contentScope !== undefined &&
          !["all", "markdown-only"].includes(session.contentScope)) {
        return { ok: false, message: "Server returned an unsupported content scope." };
      }
      if (session.mediaBypassExtensions !== undefined) {
        try { normalizeMediaBypassExtensions(session.mediaBypassExtensions); }
        catch { return { ok: false, message:
          "Server returned unsupported media bypass extensions." }; }
      }
    } catch {
      return {
        ok: false,
        message: "Cannot reach the Ignis server. Check the HTTPS address, Tailscale connection and whether the Mac server is running."
      };
    }
    if (this.stopped || attempt !== this.connectionAttempt) {
      return { ok: false, message: "The connection check was interrupted. Try again." };
    }
    if (!switching && this.settings.journalLineage &&
        session.journalLineage !== this.settings.journalLineage) {
      await this.pauseJournal("changed");
      return { ok: false, message: journalHoldExplanation("changed") };
    }
    const incomingScope = session.contentScope || "all";
    if (incomingScope !== this.settings.contentScope && !switching) {
      const ineligible = [
        ...(this.settings.pending || []).map((entry) => entry.path),
        ...(this.settings.pendingWrites || []).map((entry) => entry.path),
      ].filter((file) => !createContentScope(incomingScope).allowsPath(file));
      if (ineligible.length) {
        return { ok: false, message:
          "The server's file scope changed while local operations are pending. " +
          "Review unsent files before switching." };
      }
    }

    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close();
    this.live.disconnected();
    if (switching) {
      // An old Vault's CRDT document identity must never be carried into a
      // newly verified server. Keep its tracked history for later inspection.
      this.settings.archivedScopes.push({
        scope: this.settings.scope,
        journalLineage: this.settings.journalLineage,
        journalProof: this.settings.journalProof,
        cursor: this.settings.cursor,
        tombstoneProofs: this.settings.tombstoneProofs,
        baselines: this.settings.baselines,
        pending: this.settings.pending,
        pendingWrites: this.settings.pendingWrites,
        syncIssues: this.settings.syncIssues,
        yjsIds: this.settings.yjsIds
      });
      this.settings.cursor = 0;
      this.settings.journalLineage = "";
      this.settings.journalProof = "";
      this.settings.tombstoneProofs = {};
      this.settings.baselines = {};
      this.settings.pending = [];
      this.settings.pendingWrites = [];
      this.settings.syncIssues = [];
      this.settings.yjsIds = {};
    }
    this.settings.serverUrl = target.origin;
    this.settings.authMode = selectedToken ? "device" : "tailnet";
    this.settings.vaultId = target.vaultId;
    this.settings.scope = target.scope;
    if (switching || (!this.settings.journalLineage &&
        this.settings.cursor === 0 &&
        !Object.keys(this.settings.baselines).length &&
        !Object.keys(this.settings.yjsIds).length)) {
      this.settings.journalLineage = session.journalLineage;
    }
    this.settings.deviceId = session.deviceId;
    this.settings.contentScope = incomingScope;
    this.settings.serverMediaBypassExtensions = [
      ...normalizeMediaBypassExtensions(session.mediaBypassExtensions || [])
    ];
    this.rebuildFileScope();
    this.token = selectedToken;
    if (switching) await this.live.resetForConnection();
    const durability = selectedToken
      ? await persistScopedDeviceCredential(
        (this.app as any).secretStorage, await scopedSecretId(target.scope),
        selectedToken)
      : "verified";
    const memoryOnly = durability !== "verified";
    this.credentialDurability = durability;
    await this.persistSettings();
    this.authBlocked = false;
    this.needsReload = false;
    this.retryCount = 0;
    this.connectSocket();
    this.schedule();
    this.showStatus("Connected · " + target.vaultId);
    return {
      ok: true,
      message: (selectedToken ? "Connected" : "Connected through Tailscale") +
        " to " + target.vaultId + " as " +
        (session.label || session.deviceId.slice(0, 8)) +
        (durability === "session-only"
          ? ". Secure storage did not confirm the token; keep a safe copy for reconnecting after restart."
          : durability === "unverified"
            ? ". Token storage could not be verified across restart; keep a safe copy."
            : ".") +
        (effectiveContentScope(incomingScope,
          this.settings.deviceContentScope || "follow-server") === "markdown-only"
          ? " Markdown-only sharing; images and videos stay local." : ""),
      memoryOnly
    };
  }

  async saveSettings() {
    await this.persistSettings();
    // Advanced settings and deletion preferences do not alter the trusted
    // connection. Saving them must not interrupt native Yjs editing.
  }
  connectionSummary(): { ready: boolean; vaultId: string; deviceId: string } {
    return {
      ready: this.ready(),
      vaultId: this.settings.vaultId,
      deviceId: this.settings.deviceId
    };
  }
  journalRecoveryInfo(): { message: string; explanation: string } | null {
    return this.historyHold ? {
      message: journalHoldMessage(this.historyHold),
      explanation: journalHoldExplanation(this.historyHold)
    } : null;
  }

  async recheckJournal(): Promise<{ ok: boolean; message: string }> {
    if (!this.ready()) return { ok: false,
      message: "Verify the Vault connection before checking server history." };
    try {
      const manifest = await this.api("/vaults/" +
        encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
      if (!await this.verifyJournal(manifest, this.settings.cursor)) {
        return { ok: false, message: this.journalRecoveryInfo()?.explanation ||
          "Server history is not verified. Local originals are retained." };
      }
      if (!this.socket) this.connectSocket();
      this.schedule();
      return { ok: true, message:
        "Server history verified. Checking pending files and collaborative save receipts." };
    } catch {
      this.showStatus(this.historyHold ? journalHoldMessage(this.historyHold) :
        "Offline · local Vault retained");
      return { ok: false, message: this.authBlocked
        ? "The server rejected this device identity. Reauthorize the Connector; local originals and pending work are retained."
        : "Cannot reach the server to verify its history. Local files are unchanged." };
    }
  }
  private currentScope(): string {
    return validServerUrl(this.settings.serverUrl) + "|" + this.settings.vaultId;
  }
  private matchesScope(): boolean {
    try { return this.settings.scope === this.currentScope(); }
    catch { return false; }
  }
  private ready(): boolean {
    return !!(!this.authBlocked && !this.needsReload &&
      this.matchesScope() && this.settings.vaultId &&
      (this.settings.authMode === "tailnet" && !!this.settings.deviceId ||
       /^ignis_dev_[A-Za-z0-9_-]{43}$/.test(this.token)));
  }
  private showStatus(status: string) {
    this.statusText = status;
    this.renderStatus();
  }
  private renderStatus() {
    const shown = this.getCurrentStatus();
    const path = this.app?.workspace?.getActiveFile?.()?.path || null;
    const composition = this.live?.compositionState?.(path);
    const compact = this.historyHold ? shown : composition?.composing
      ? (mobileUiLanguage() === "ja"
        ? (composition.peerEditWaiting
          ? "競合保留中 · IME未確定" : "IME変換中 · 未確定")
        : (composition.peerEditWaiting
          ? "Peer edit waiting · IME draft" : "IME draft · not confirmed"))
      : shown;
    if (this.status) {
      this.status.setText("Ignis: " + compact);
      // Obsidian supplies a DOM element; minimal host adapters may expose
      // only setText. Accessibility metadata is an optional capability of
      // that presentation sink, not a prerequisite for sync state changes.
      this.status.setAttribute?.("aria-label", "Ignis: " + shown);
      this.status.setAttribute?.("title", "Ignis: " + shown);
    }
    // Obsidian's custom status bar doesn't exist on mobile. This reflects
    // the *actual* sync message, never treats a connected socket as a save ACK.
    this.collaborationRibbon?.setAttribute("aria-label", "Ignis: " + shown +
      " · open collaborators and sync status");
    this.collaborationRibbon?.setAttribute("title", "Ignis: " + shown);
    if (this.mobileConnection) {
      const projection = nativeConnectionState(
        shown, this.ready(), this.socket?.readyState === WebSocket.OPEN,
        mobileUiLanguage(),
      );
      this.mobileActions?.setAttribute("data-connection", projection.kind);
      this.mobileConnection.setAttribute("aria-label",
        "Ignis: " + projection.label + " · " + mobileUiCopy().openActions);
      this.mobileConnection.setAttribute("title", "Ignis: " + shown);
      if (this.mobileConnectionDot) {
        this.mobileConnectionDot.style.backgroundColor = {
          connected: "#28a46e", syncing: "#d3a440",
          offline: "var(--text-muted)", error: "#da5b5b"
        }[projection.kind];
      }
      this.mobileMenu?.refreshStatus();
    }
  }
  private schedule() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, 450);
  }
  private url(path: string): string {
    return validServerUrl(this.settings.serverUrl) + "/api/sync/v1" + path;
  }
  private async deviceRequest(
    path: string, method = "GET", body?: unknown, allowNotFound = false
  ) {
    const response = await requestUrl({
      url: this.url(path),
      method,
      throw: false,
      headers: {
        ...(this.settings.authMode !== "tailnet" ?
          { Authorization: "Bearer " + this.token } : {}),
        ...(method !== "GET" && this.settings.journalLineage ?
          { "X-Ignis-Journal-Lineage": this.settings.journalLineage } : {}),
        ...(method !== "GET" && this.settings.journalLineage &&
          /^[a-f0-9]{64}$/.test(this.settings.journalProof || "") &&
          Number.isSafeInteger(this.settings.cursor) ? {
            "X-Ignis-Journal-Cursor": String(this.settings.cursor),
            "X-Ignis-Journal-Proof": this.settings.journalProof
          } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 401) {
      this.authBlocked = true;
      this.live.disconnected();
      this.socket?.close();
      this.showStatus("Device revoked or no longer authorized");
      throw new Error("Sync device authorization rejected");
    }
    if (response.status >= 400 && !(allowNotFound && response.status === 404)) {
      const code = typeof response.json?.code === "string" ? response.json.code : "";
      if (code === "JOURNAL_LINEAGE_MISMATCH") {
        await this.pauseJournal("changed");
      } else if (code === "JOURNAL_CHECKPOINT_MISMATCH") {
        await this.pauseJournal("diverged");
      }
      throw new SyncHttpError(response.status, code);
    }
    return response;
  }
  private async api(path: string, method = "GET", body?: unknown) {
    return (await this.deviceRequest(path, method, body)).json;
  }
  private async sendOperation(body: object): Promise<OperationResult> {
    return this.api(
      "/vaults/" + encodeURIComponent(this.settings.vaultId) + "/operations",
      "POST", body
    );
  }

  private connectSocket() {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.live.disconnected();
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    if (!this.ready()) return;
    try {
      const base = new URL(validServerUrl(this.settings.serverUrl));
      base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      base.pathname = "/ws";
      base.searchParams.set("vault", this.settings.vaultId);
      const socket = new WebSocket(base.toString());
      const scope = this.settings.scope;
      const token = this.token;
      let authorized = false;
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped || !this.ready() ||
            this.settings.scope !== scope || this.token !== token) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ channel: "sync", type: "auth",
          ...(this.settings.authMode !== "tailnet" ? { token } : {}) }));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.stopped || !this.ready()) return;
        try {
          const message = JSON.parse(event.data);
          if (message.channel === "collab") {
            if (authorized && !this.historyHold) void this.live.handle(message);
          } else if (message.channel === "sync") {
            if (message.type === "ready") {
              if (message.vaultId !== this.settings.vaultId) {
                this.authBlocked = true;
                this.showStatus("Server returned the wrong Vault");
                socket.close();
                return;
              }
              if (typeof message.deviceId !== "string" ||
                  (this.settings.deviceId && message.deviceId !== this.settings.deviceId)) {
                this.authBlocked = true;
                this.showStatus("Server returned the wrong device identity");
                socket.close();
                return;
              }
              // A socket AUTH only establishes the device, not the history
              // that the native CRDT and its outgoing queue belong to. A
              // server replaced at the same URL must not receive old Yjs.
              // Even the SAME journal UUID and a newer sequence are not
              // sufficient: a restored backup can diverge and catch up before
              // this socket reconnects. Validate the saved frontier proof
              // before publishing any local Yjs edit to the new connection.
              void (async () => {
                if (!message.journalLineage ||
                    (this.settings.journalLineage &&
                      message.journalLineage !== this.settings.journalLineage)) {
                  await this.pauseJournal(message.journalLineage ? "changed" : "unsupported");
                  return;
                }
                const manifest = await this.api("/vaults/" +
                  encodeURIComponent(this.settings.vaultId) + "/manifest") as Manifest;
                if (this.socket !== socket || this.stopped ||
                    this.settings.scope !== scope || this.token !== token) return;
                if (manifest.journalLineage !== message.journalLineage) {
                  await this.pauseJournal("changed");
                  return;
                }
                if (!await this.verifyJournal(manifest, this.settings.cursor)) return;
                if (this.socket !== socket || this.stopped) return;
                authorized = true;
                this.retryCount = 0;
                this.live.connected();
                this.schedule();
              })().catch(error => {
                if (this.socket !== socket) return;
                this.lastError = String(error);
                this.showStatus("Server identity verification failed · local notes retained");
                socket.close(1000, "Identity verification failed");
              });
            }
            if (message.type === "changed") this.schedule();
            if (message.type === "auth-error") {
              this.authBlocked = true;
              this.live.disconnected();
              this.showStatus("Authorization failed");
              socket.close();
            }
          }
        } catch { /* Other Ignis websocket messages are not sync data. */ }
      };
      socket.onerror = () => {
        if (this.socket === socket) this.showStatus("Offline · local Vault retained");
      };
      socket.onclose = (event) => {
        if (this.socket === socket) {
          this.live.disconnected();
          this.socket = null;
          if (this.historyHold) {
            this.showStatus(journalHoldMessage(this.historyHold));
            return;
          }
          const result = classifySyncSocketClose(event.code, event.reason);
          this.showStatus(result.status);
          if (result.terminal) {
            this.authBlocked = true;
            return;
          }
          // Background Obsidian sessions are still authoritative editors.
          // After a server restart, macOS may keep their window hidden for
          // hours, with no visibilitychange to restart the socket. Retry at
          // the bounded backoff even while hidden; auth refusal stays terminal.
          if (!this.stopped && this.ready()) this.retryConnection();
        }
      };
    } catch (error) {
      this.lastError = String(error);
    }
  }
  private retryConnection() {
    if (this.reconnectTimer !== null || this.stopped || !this.ready()) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5));
    this.reconnectTimer = window.setTimeout(() => this.connectSocket(), delay);
  }
  private recoverConnection() {
    if (this.stopped || !this.ready()) return;
    // Re-establish the old Yjs rooms, then reconcile changed Vault files.
    // Never rely on a socket which merely *looks* open after iOS sleep.
    this.connectSocket();
    this.schedule();
  }

  private openInEditor(path: string): boolean {
    return this.app.workspace.getLeavesOfType("markdown").some((leaf) =>
      (leaf.view as any).file?.path === path);
  }
  private async openOriginalMatchesDisk(path: string, file: TFile): Promise<boolean> {
    // A fresh server cannot join a note that has not yet been created in its
    // file journal. An open native editor remains a valid source, but only if
    // EVERY visible editing buffer is identical to the file we are about to
    // upload. Never publish the potentially older disk snapshot while the
    // user has a newer, uncommitted CM6 draft.
    const leaves = this.app.workspace.getLeavesOfType("markdown")
      .filter((leaf) => (leaf.view as any).file?.path === path);
    if (!leaves.length) return !this.live.isManaged(path);
    const buffers = leaves.map((leaf) => (leaf.view as any).editor?.getValue?.());
    if (buffers.some((value) => typeof value !== "string")) return false;
    const saved = await this.app.vault.read(file);
    return buffers.every((value) => value === saved);
  }
  private localFiles(): Map<string, TFile> {
    return new Map(this.app.vault.getFiles()
      .filter((file) => this.canShare(file.path)).map((file) => [file.path, file]));
  }
  private async localHash(file: TFile): Promise<string | null> {
    if (file.stat.size > MAX_FILE_BYTES) return null;
    return sha256(isMarkdown(file.path) ?
      textEncoder.encode(await this.app.vault.read(file)) :
      new Uint8Array(await this.app.vault.readBinary(file)));
  }
  private async remoteBytes(remote: RemoteFile): Promise<ArrayBuffer> {
    if (remote.size > MAX_FILE_BYTES) throw new Error("File exceeds mobile-safe sync limit");
    const response = await this.deviceRequest(
      "/vaults/" + encodeURIComponent(this.settings.vaultId) +
      "/files/" + encodeURIComponent(remote.fileId)
    );
    const bytes = new Uint8Array(response.arrayBuffer);
    if (bytes.length !== remote.size || await sha256(bytes) !== remote.hash) {
      throw new Error("Remote content size/hash mismatch");
    }
    return response.arrayBuffer;
  }
  private async payloadFor(file: TFile): Promise<{ content: string } | { contentBase64: string }> {
    if (file.stat.size > MAX_FILE_BYTES) throw new Error("Local file exceeds mobile-safe sync limit");
    if (isMarkdown(file.path)) {
      return { content: await this.app.vault.read(file) };
    }
    const stat = async () => {
      const current = this.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) return null;
      const actual = typeof this.app.vault.adapter?.stat === "function"
        ? await this.app.vault.adapter.stat(file.path) : current.stat;
      return actual && typeof actual.size === "number" &&
        typeof actual.mtime === "number"
        ? { size: actual.size, mtime: actual.mtime } : null;
    };
    const bytes = await readQuiescentBinary({
      stat,
      read: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      wait: () => new Promise<void>(resolve => window.setTimeout(resolve, 700)),
      maxBytes: MAX_FILE_BYTES
    });
    if (!bytes) throw new AttachmentStillWriting("Attachment is still changing: " + file.path);
    return { contentBase64: encodeBase64(bytes) };
  }
  private async writeLocal(path: string, data: string | ArrayBuffer) {
    this.quiet.add(path);
    try {
      let parent = "";
      for (const segment of path.split("/").slice(0, -1)) {
        parent = parent ? parent + "/" + segment : segment;
        const existing = this.app.vault.getAbstractFileByPath(parent);
        if (existing === null) await this.app.vault.createFolder(parent);
        else if (existing instanceof TFile) {
          throw new Error("Parent folder occupied by file: " + parent);
        }
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        if (typeof data === "string") await this.app.vault.modify(file, data);
        else await this.app.vault.modifyBinary(file, data);
      } else if (file === null) {
        if (typeof data === "string") await this.app.vault.create(path, data);
        else await this.app.vault.createBinary(path, data);
      }
      else throw new Error("Path occupied by a folder: " + path);
    } finally {
      // Vault events may be delivered on the next tick.
      window.setTimeout(() => this.quiet.delete(path), 1000);
    }
  }
  private saveBase(path: string, file: RemoteFile | OperationResult) {
    this.settings.baselines[path] = {
      fileId: file.fileId,
      generationId: file.generationId,
      hash: file.hash || "",
      revision: "revision" in file ? file.revision : 0
    };
  }
  private async replayPending() {
    const deferred: Pending[] = [];
    for (const pending of [...this.settings.pending]) {
      if (!this.settings.pending.some(item => item.opId === pending.opId)) continue;
      // Keep the original order for dependent path/identity transitions,
      // but allow unrelated files to progress after a 409 conflict.
      if (deferred.some(item => pendingDependent(item, pending))) {
        deferred.push(pending);
        continue;
      }
      if (!this.canShare(pending.path) ||
          (pending.toPath && !this.canShare(pending.toPath))) {
        throw new Error("An excluded file has an unsent rename/delete; review before syncing");
      }
      try {
        const result = await this.sendOperation(pending);
        acknowledgePending(this.settings, result);
        this.observeOperationReceipt(result.seq);
        if (pending.toPath) {
          this.live.rejoinPath(pending.toPath);
        }
        this.outboundFailures.delete(pending.opId);
        await this.persistSettings();
      } catch (error) {
        if (!isReviewableConflict(error)) throw error;
        this.outboundFailures.set(pending.opId, error.code);
        deferred.push(pending);
      }
    }
  }
  private async retireObsoleteStages(path: string): Promise<void> {
    const vaultId = encodeURIComponent(this.settings.vaultId);
    for (const staged of [...this.settings.pendingWrites]) {
      if (staged.path !== path) continue;
      const result = await this.api(
        "/vaults/" + vaultId + "/operations/" +
        encodeURIComponent(staged.opId) + "/abandon", "POST"
      ) as { status: "committed" | "abandoned"; opId?: string };
      if (result.status !== "abandoned" || result.opId !== staged.opId) {
        // A committed request may have won between the manifest and this
        // call. Do not consume it or overwrite the version in that case.
        throw new Error("A queued operation reached the server; resync and compare versions again");
      }
      const index = this.settings.pendingWrites.findIndex(item =>
        item.opId === staged.opId);
      if (index >= 0) {
        this.settings.pendingWrites.splice(index, 1);
        this.outboundFailures.delete(staged.opId);
        await this.persistSettings();
      }
    }
  }
  private async replayWrites() {
    const vaultId = encodeURIComponent(this.settings.vaultId);
    for (const staged of [...this.settings.pendingWrites]) {
      if (!this.settings.pendingWrites.some(item => item.opId === staged.opId)) continue;
      if (!this.canShare(staged.path)) {
        throw new Error("An excluded file has an unsent write; review before syncing");
      }
      try {
      // A lost response may mean that the server has already committed.
      // Query the durable receipt before inspecting the mutable local file.
      const receiptResponse = await this.deviceRequest(
        "/vaults/" + vaultId + "/operations/" + encodeURIComponent(staged.opId),
        "GET", undefined, true
      );
      let receipt: OperationResult;
      if (receiptResponse.status === 200) {
        receipt = receiptResponse.json;
      } else if (receiptResponse.status === 404) {
        const local = this.app.vault.getAbstractFileByPath(staged.path);
        if (!(local instanceof TFile) ||
            await this.localHash(local) !== staged.localHash) {
          // Never send a stale copy-in-progress. A missed ACK could mean
          // the old request is in flight: the server must DURABLY reject its
          // opId before the obsolete staged bytes can be retired.
          const outcome = await this.api(
            "/vaults/" + vaultId + "/operations/" +
              encodeURIComponent(staged.opId) + "/abandon", "POST"
          ) as { status: "committed" | "abandoned";
            opId?: string; receipt?: OperationResult };
          if (outcome.status === "committed" && outcome.receipt) {
            receipt = outcome.receipt;
          } else if (outcome.status === "abandoned" &&
              outcome.opId === staged.opId) {
            this.settings.pendingWrites.splice(
              this.settings.pendingWrites.findIndex(item => item.opId === staged.opId), 1
            );
            this.outboundFailures.delete(staged.opId);
            await this.persistSettings();
            this.queued = true;
            continue;
          } else {
            throw new Error("Server did not confirm the obsolete operation was rejected");
          }
        } else {
          receipt = await this.sendOperation({
            opId: staged.opId, type: staged.type, path: staged.path,
            ...(staged.content !== undefined ? { content: staged.content } :
              { contentBase64: staged.contentBase64 }),
            ...(staged.type === "modify" ? {
              fileId: staged.fileId, generationId: staged.generationId,
              baseHash: staged.baseHash
            } : {})
          });
        }
      } else {
        throw new Error("Could not verify staged write receipt: HTTP " + receiptResponse.status);
      }
      // Check the receipt before mutating any local tracking state.
      acknowledgeWrite(this.settings.pendingWrites, receipt);
      this.observeOperationReceipt(receipt.seq);
      this.saveBase(staged.path, receipt);
      this.outboundFailures.delete(staged.opId);
      await this.persistSettings();
      } catch (error) {
        if (!isReviewableConflict(error)) throw error;
        // A 409 is a durable unresolved intention, not a reason to stop
        // unrelated uploads or the download/review reconciliation pass.
        this.outboundFailures.set(staged.opId, error.code);
      }
    }
  }
  private async stageAndSend(
    type: "create" | "modify", file: TFile, base?: Base
  ): Promise<void> {
    if (!this.canShare(file.path)) return;
    const payload = await this.payloadFor(file);
    const bytes = "content" in payload ?
      textEncoder.encode(payload.content) :
      Uint8Array.from(atob(payload.contentBase64), (ch) => ch.charCodeAt(0));
    const digest = await sha256(bytes);
    const staged = stageWrite(this.settings.pendingWrites, {
      type, path: file.path, opId: crypto.randomUUID(),
      ...payload, localHash: digest,
      ...(base ? {
        fileId: base.fileId, generationId: base.generationId,
        baseHash: base.hash
      } : {})
    });
    // The immutable payload and operation ID must be on disk BEFORE the
    // first network send. A timeout or app kill can now retry exactly.
    await this.persistSettings();
    if (staged.localHash !== digest) {
      throw new Error("Another staged version exists for " + file.path);
    }
    await this.replayWrites();
  }

  private async verifyJournal(
    manifest: Manifest, startingCursor: number
  ): Promise<boolean> {
    const tracked = Object.entries(this.settings.baselines)
      .filter(([path]) => this.canShare(path))
      .map(([path, entry]) => ({ path,
        fileId: entry.fileId, generationId: entry.generationId }));
    const liveGenerations = Object.entries(this.settings.yjsIds)
      .filter(([path]) => this.canShare(path)).map(([, id]) => id);
    const assessment = assessJournalTrust({
      pinnedLineage: this.settings.journalLineage,
      remoteLineage: manifest.journalLineage,
      cursor: startingCursor,
      remoteSeq: manifest.vaultSeq,
      tracked, liveGenerations, remoteFiles: manifest.files
    });
    if (assessment.state === "trusted") {
      if (this.settings.journalProof) {
        let witness: unknown = manifest.headProof;
        if (manifest.vaultSeq !== startingCursor) {
          const exact = await this.api("/vaults/" +
            encodeURIComponent(this.settings.vaultId) +
            "/checkpoint?seq=" + startingCursor) as {
              journalLineage?: string; seq?: number; proof?: string | null
            };
          witness = exact.journalLineage === manifest.journalLineage &&
            exact.seq === startingCursor ? exact.proof : null;
        }
        if (!journalProofMatches(this.settings.journalProof, witness)) {
          await this.pauseJournal("diverged");
          return false;
        }
      }
      const priorHold = this.historyHold;
      this.historyHold = null;
      if (assessment.newlyPinned) this.settings.journalLineage = assessment.lineage;
      if (priorHold) {
        // A restored journal may be retried without changing the local draft
        // or discarding a queued operation. Retire ONLY the lineage warning.
        this.settings.syncIssues = (this.settings.syncIssues || []).filter(issue =>
          !issue.reason.startsWith("Server journal identity requires review"));
      }
      if (assessment.newlyPinned || priorHold) await this.persistSettings();
      if (priorHold) this.showStatus("History verified · waiting for sync confirmation");
      return true;
    }
    await this.pauseJournal(assessment.reason);
    return false;
  }

  private async pauseJournal(
    reason: Extract<JournalTrust,{state:"hold"}>["reason"]
  ): Promise<void> {
    this.historyHold = reason;
    this.live.disconnected();
    const tracked = Object.keys(this.settings.baselines)
      .filter(path => this.canShare(path));
    const affected = new Set([
      ...tracked,
      ...Object.keys(this.settings.yjsIds).filter(path => this.canShare(path)),
      ...(this.settings.pending || []).map(entry => entry.path),
      ...(this.settings.pendingWrites || []).map(entry => entry.path)
    ]);
    const previousIssues = (this.settings.syncIssues || []).filter(issue =>
      !issue.reason.startsWith("Server journal identity requires review"));
    this.settings.syncIssues = [...previousIssues,
      ...[...affected].filter(path =>
        !previousIssues.some(issue => issue.path === path)).map(path => ({
        path, reason: "Server journal identity requires review; local original retained"
      }))];
    this.lastError = journalHoldExplanation(reason);
    this.showStatus(journalHoldMessage(reason));
    await this.persistSettings();
    // WebSocket authentication is not proof of journal ancestry. Stop any
    // existing native Yjs stream while the server identity is in dispute.
    this.socket?.close(1000, "Server history review required");
  }

  async syncNow() {
    if (!this.ready()) return;
    if (this.migrationBusy) { this.queued = true; return; }
    if (this.syncing) { this.queued = true; return; }
    this.syncing = true;
    this.syncDrain = new Promise<void>(resolve => {
      this.releaseSyncDrain = resolve;
    });
    let unsettledAttachments = 0;
    this.showStatus("Syncing");
    try {
      // A local operation receipt proves only that ONE operation committed,
      // not that all intervening remote changes were reconciled.
      const startingCursor = this.settings.cursor;
      const vaultId = encodeURIComponent(this.settings.vaultId);
      if (this.settings.pending.length || this.settings.pendingWrites.length) {
        // Never send a queued old-generation operation to a server which has
        // lost the journal that previously assigned its file identity.
        const preflight = await this.api("/vaults/" + vaultId + "/manifest") as Manifest;
        if (!await this.verifyJournal(preflight, startingCursor)) return;
      }
      await this.replayWrites();
      await this.replayPending();
      // Freeze the local tracking frontier before asking for a remote
      // manifest. Writes acknowledged later in this pass belong to a newer
      // frontier and must not be judged absent from this older snapshot.
      const baselineAtManifest = Object.fromEntries(
        Object.entries(this.settings.baselines).map(([path, base]) =>
          [path, { ...base }])
      );
      const manifest = await this.api("/vaults/" + vaultId + "/manifest") as Manifest;
      if (!await this.verifyJournal(manifest, startingCursor)) return;
      const changes = await readChangesThrough(startingCursor, manifest.vaultSeq,
        (since, limit) => this.api("/vaults/" + vaultId +
          "/changes?since=" + since + "&limit=" + limit));
      this.settings.tombstoneProofs = retainDeletionProofs(
        this.settings.tombstoneProofs || {}, baselineAtManifest, changes);
      // Preserve deletion evidence before advancing the journal frontier.
      await this.persistSettings();
      const local = this.localFiles();
      const remotePaths = new Set<string>();
      const conflicts: SyncIssue[] = [];
      const report = (path: string, reason: string) =>
        conflicts.push({ path, reason });
      // A previously protected independent origin remains protected even if
      // the remote file is deleted before the user chooses a version.
      const protectedOriginals = new Set(
        (this.settings.syncIssues || [])
          .filter((issue) => migrationNeedsPreservation(issue.reason))
          .map((issue) => issue.path)
      );
      for (const remote of manifest.files) {
        if (!this.canShare(remote.path)) continue;
        remotePaths.add(remote.path);
        if (remote.size > MAX_FILE_BYTES) {
          report(remote.path, "Attachment exceeds preview size limit");
          continue;
        }
        // Live Yjs handles in-memory panes. A file-level REST write cannot
        // carry a native editor's uncommitted state safely.
        if (this.live.isManaged(remote.path)) continue;
        const oldEntry = Object.entries(this.settings.baselines).find(
          ([name, state]) => name !== remote.path && state.fileId === remote.fileId
        );
        if (oldEntry && !this.settings.baselines[remote.path]) {
          const [oldPath, oldBase] = oldEntry;
          const previousLocal = local.get(oldPath);
          const targetLocal = local.get(remote.path);
          const isClean = previousLocal &&
            await this.localHash(previousLocal) === oldBase.hash;
          if (!isClean || targetLocal || this.openInEditor(oldPath)) {
            report(remote.path, "Remote move requires review");
            continue;
          }
          this.quiet.add(oldPath);
          this.quiet.add(remote.path);
          try {
            await this.app.vault.rename(previousLocal, remote.path);
            local.delete(oldPath);
            local.set(remote.path, previousLocal);
            this.settings.baselines[remote.path] = oldBase;
            delete this.settings.baselines[oldPath];
            const yjsId = this.settings.yjsIds[oldPath];
            if (yjsId) {
              this.settings.yjsIds[remote.path] = yjsId;
              delete this.settings.yjsIds[oldPath];
            }
            this.live.relocate(oldPath, remote.path);
          } finally {
            window.setTimeout(() => {
              this.quiet.delete(oldPath);
              this.quiet.delete(remote.path);
            }, 1000);
          }
        }
        const existing = local.get(remote.path);
        const base = this.settings.baselines[remote.path];
        const localDigest = existing ? await this.localHash(existing) : null;
        if (base && (base.fileId !== remote.fileId ||
                     base.generationId !== remote.generationId)) {
          report(remote.path, "Replaced document generation");
          continue;
        }
        if (!existing) {
          if (base) { report(remote.path, "Local deletion unresolved"); continue; }
          const data = await this.remoteBytes(remote);
          await this.writeLocal(remote.path, isMarkdown(remote.path) ?
            new TextDecoder().decode(data) : data);
          this.saveBase(remote.path, remote);
        } else if (!base) {
          if (localDigest === remote.hash) {
            // Same visible bytes can converge without replaying an obsolete
            // CREATE intention forever. The server must durably reject that
            // old opId before this device adopts the shared file identity.
            if (this.settings.pendingWrites.some(item =>
              item.path === remote.path && item.type === "create")) {
              await this.retireObsoleteStages(remote.path);
            }
            this.saveBase(remote.path, remote);
          }
          else report(remote.path, "Existing on both devices");
        } else if (localDigest === null) {
          report(remote.path, "Size limit");
        } else if (localDigest === remote.hash) {
          this.saveBase(remote.path, remote);
        } else if (localDigest !== base.hash && remote.hash !== base.hash) {
          report(remote.path, "Concurrent edit");
        } else if (localDigest !== base.hash) {
          if (this.openInEditor(remote.path)) {
            // The native editor may have unsaved changes. CM6/Yjs binding
            // comes in the next phase; do not overwrite the open editor.
            report(remote.path, "Open editor; file-level write deferred");
            continue;
          }
          try {
            await this.stageAndSend("modify", existing, base);
          } catch (error) {
            if (!(error instanceof AttachmentStillWriting)) throw error;
            unsettledAttachments++;
          }
        } else {
          if (this.openInEditor(remote.path)) {
            report(remote.path, "Open editor");
            continue;
          }
          const data = await this.remoteBytes(remote);
          await this.writeLocal(remote.path, isMarkdown(remote.path) ?
            new TextDecoder().decode(data) : data);
          this.saveBase(remote.path, remote);
        }
        await this.persistSettings();
      }
      const firstShareTotal = manifest.vaultSeq === 0 && !manifest.files.length
        ? [...local.keys()].filter(path => !this.settings.baselines[path] &&
            !this.settings.pending.some(operation => operation.toPath === path)).length : 0;
      let firstShareCompleted = 0;
      if (firstShareTotal) this.showStatus("Sharing local originals · 0/" +
        firstShareTotal + " · original files retained until acknowledged");
      for (const [path, file] of local) {
        if (protectedOriginals.has(path) && !remotePaths.has(path) &&
            !this.settings.baselines[path]) {
          report(path, "Remote missing; retained locally");
          continue;
        }
        if (!this.settings.baselines[path] && this.settings.yjsIds[path] &&
            !remotePaths.has(path)) {
          report(path, "Collaborative move has no confirmed file identity");
          continue;
        }
        if (remotePaths.has(path) || this.settings.baselines[path] ||
            this.settings.pending.some((op) => op.toPath === path)) continue;
        const bytes = file.stat.size;
        if (bytes > MAX_FILE_BYTES) {
          report(path, "Attachment exceeds preview size limit");
          continue;
        }
        const managed = this.live.isManaged(path);
        if ((managed || this.openInEditor(path)) &&
            !await this.openOriginalMatchesDisk(path, file)) {
          report(path, "Open editor has uncommitted or unverified text; local original retained");
          continue;
        }
        try {
          await this.stageAndSend("create", file);
          if (firstShareTotal && this.settings.baselines[path]) {
            firstShareCompleted++;
            this.showStatus("Sharing local originals · " + firstShareCompleted +
              "/" + firstShareTotal + " confirmed by server");
          }
          // The collaboration JOIN may have been rejected before this note
          // existed on the fresh server. Retry only after the CREATE receipt
          // established the file generation, never against a missing path.
          if (managed && this.settings.baselines[path]) this.live.rejoinPath(path);
        } catch (error) {
          if (!(error instanceof AttachmentStillWriting)) throw error;
          unsettledAttachments++;
          continue;
        }
        await this.persistSettings();
      }
      // Only an explicit tombstone for the same file generation may trigger
      // local trash, and only after verifying the local bytes are unchanged.
      for (const path of Object.keys(this.settings.baselines)) {
        if (!this.canShare(path)) continue;
        const base = this.settings.baselines[path];
        const absence = classifySnapshotAbsence(
          path, base, baselineAtManifest[path], remotePaths, changes,
          this.settings.tombstoneProofs[path]);
        if (absence === "present" || absence === "post-snapshot") continue;
        if (absence !== "tombstone" || !this.settings.applyRemoteDeletes ||
            this.live.isManaged(path) || this.openInEditor(path)) {
          report(path, "Remote missing; retained locally");
          continue;
        }
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (!(localFile instanceof TFile) ||
            await this.localHash(localFile) !== base.hash) {
          report(path, "Remote deleted; local changes retained");
          continue;
        }
        this.quiet.add(path);
        try {
          // Obsidian's local .trash is recoverable and excluded from sync.
          await this.app.vault.trash(localFile, false);
          delete this.settings.baselines[path];
          delete this.settings.yjsIds[path];
          await this.persistSettings();
        } finally {
          window.setTimeout(() => this.quiet.delete(path), 1000);
        }
      }
      // A native editor can reject an unrelated Yjs history without a REST
      // conflict (managed rooms intentionally skip whole-file writes).
      // Include that separate protection outcome in the same review surface.
      const reportedPaths = new Set(conflicts.map(issue => issue.path));
      for (const path of this.live.blockingPaths()) {
        if (!reportedPaths.has(path)) {
          report(path, "Live editor blocked; local draft retained");
        }
      }
      this.settings.cursor = manifest.vaultSeq;
      if (typeof manifest.headProof === "string" &&
          /^[a-f0-9]{64}$/.test(manifest.headProof)) {
        // The cursor and its exact journal witness are one checkpoint; save
        // them in the same ordered settings snapshot. This is independent of
        // pending operations and live Yjs ACKs.
        this.settings.journalProof = manifest.headProof;
      }
      const unsent = this.settings.pending.length + this.settings.pendingWrites.length;
      if (conflicts.length || unsent) {
        this.lastError = conflicts.slice(0, 4)
          .map((issue) => issue.path + ": " + issue.reason).join("; ");
        const affectedPaths = new Set([
          ...conflicts.map(issue => issue.path),
          ...this.settings.pending.map(op => op.path),
          ...this.settings.pendingWrites.map(op => op.path)
        ]);
        const affected = affectedPaths.size;
        this.showStatus(affected + (affected === 1 ? " item needs review" :
          " items need review") + (unsent ? " · " + unsent +
          (unsent === 1 ? " unsent change" : " unsent changes") : ""));
        if (this.latestOperationReceipt?.scope === this.settings.scope &&
            this.latestOperationReceipt.seq > manifest.vaultSeq) {
          this.queued = true;
        }
      } else if (unsettledAttachments) {
        this.showStatus("Waiting for " + unsettledAttachments +
          " attachment(s) to finish copying · local files retained");
      } else {
        if (this.latestOperationReceipt?.scope === this.settings.scope &&
            this.latestOperationReceipt.seq > manifest.vaultSeq) {
          // The server acknowledged a local operation after this manifest's
          // frontier. Reconcile against a newer manifest before saying that
          // the whole Vault has been synced; no fabricated conflict is needed.
          this.showStatus("Confirming recent server writes");
          this.queued = true;
        } else {
          // REST journal synchronization and live Yjs persistence are two
          // different durability planes. A successful manifest/operation sync
          // cannot prove that every open Markdown collaboration is saved.
          const live = this.live.saveState();
          const emptyFolders = this.emptyLocalFolders().length;
          if (live.blocked) {
            this.showStatus("Files synced · " + live.blocked +
              " collaborative notes need review");
          } else if (live.active && !live.online) {
            this.showStatus("Files synced · live collaboration offline");
          } else if (live.reconnecting) {
            this.showStatus("Files synced · " + live.reconnecting +
              " collaborative notes reconnecting");
          } else if (live.awaitingServer) {
            this.showStatus("Files synced · " + live.awaitingServer +
              " collaborative notes await server save");
          } else if (emptyFolders) {
            this.showStatus("Files synced · " + emptyFolders +
              (emptyFolders === 1 ? " empty folder" : " empty folders") +
              (emptyFolders === 1 ? " remains local (not shared)" :
                " remain local (not shared)"));
          } else {
            this.showStatus("Synced · server acknowledged");
          }
        }
      }
      this.settings.syncIssues = conflicts;
      await this.persistSettings();
    } catch (error) {
      this.lastError = String(error);
      this.showStatus(this.historyHold ? journalHoldMessage(this.historyHold) :
        "Pending · locally retained");
      console.warn("[ignis-connector] Sync failed:", error);
    } finally {
      this.syncing = false;
      this.releaseSyncDrain?.();
      this.releaseSyncDrain = null;
      this.syncDrain = null;
      if (this.queued) { this.queued = false; this.schedule(); }
      if (unsettledAttachments && !this.stopped) {
        // A quiet retry without saturating the CPU while a large OS copy is
        // in progress; no server write was staged for the transient bytes.
        window.setTimeout(() => { if (!this.stopped) this.schedule(); }, 1500);
      }
    }
  }

  async inspectDiscovery() {
    try {
      if (!this.settings.discoveryUrl || !this.settings.serverDeviceId) {
        new Notice("Configure Discovery URL and server Device ID first");
        return;
      }
      const candidates = await discover(
        this.settings.discoveryUrl, this.settings.serverDeviceId
      );
      const pinned = validServerUrl(this.settings.serverUrl);
      if (candidates.some((x) => validServerUrl(x) === pinned)) {
        new Notice("Syncthing Discovery confirms the configured HTTPS endpoint");
      } else {
        new Notice("Discovery returned other addresses. Review and approve the origin manually; no token was sent.");
      }
    } catch (error) {
      new Notice("Discovery failed: " + String(error));
    }
  }
}

export class DisplayNameModal extends Modal {
  constructor(app: IgnisConnector["app"], private readonly plugin: IgnisConnector) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Your Ignis display name" });
    contentEl.createEl("p", {
      text: "This name is shown beside your live cursor on other devices. It does not change your Tailscale identity or device permissions."
    });
    let value = this.plugin.settings.displayName || "";
    let input: HTMLInputElement;
    new Setting(contentEl).setName("Display name")
      .addText((text) => {
        text.setValue(value)
          .setPlaceholder(this.plugin.getDisplayName())
          .onChange((next) => { value = next; });
        input = text.inputEl;
        input.maxLength = DISPLAY_NAME_LIMIT;
        input.setAttribute("aria-label", "Your Ignis display name");
      });
    const save = async () => {
      try {
        await this.plugin.setDisplayName(value);
        new Notice("Ignis name: " + this.plugin.getDisplayName());
        this.close();
      } catch {
        new Notice("Could not save the display name. Try again.");
      }
    };
    input!.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void save();
      }
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Save name").setCta()
        .onClick(() => void save()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
}

export class CollaboratorsModal extends Modal {
  constructor(app: IgnisConnector["app"], private readonly plugin: IgnisConnector) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Ignis collaborators" });
    new Setting(contentEl).setName("Sync status")
      .setDesc(this.plugin.getCurrentStatus())
      .addButton((b) => b.setButtonText("Review issues")
        .onClick(() => { this.close(); this.plugin.openSyncIssues(); }));
    const reviews = this.plugin.getUndoReviews();
    if (reviews.length) {
      const ja = mobileUiLanguage() === "ja";
      new Setting(contentEl)
        .setName(ja ? "元に戻す操作の確認待ち：" + reviews.length + "件"
          : reviews.length + " Undo / Redo edit" +
            (reviews.length === 1 ? "" : "s") + " need review")
        .setDesc(ja
          ? "他端末の変更で元の位置が分からなくなりました。文字列を勝手に復元していません。"
          : "A collaborator replaced the original edit boundary. No automatic restore was attempted.")
        .addButton((b) => b.setButtonText(ja ? "内容を確認" : "Review edits")
          .onClick(() => { this.close(); this.plugin.openUndoReview(); }));
    }
    new Setting(contentEl).setName("Your display name")
      .setDesc(this.plugin.getDisplayName())
      .addButton((b) => b.setButtonText("Change name")
        .onClick(() => {
          this.close();
          this.plugin.openDisplayName();
        }));
    const { path, peers } = this.plugin.currentParticipants();
    contentEl.createEl("p", { text: path || "Open a Markdown note to see collaborators." });
    if (!peers.length) {
      contentEl.createEl("p", { text: "No other editors are connected to this note." });
    }
    for (const peer of peers) {
      new Setting(contentEl).setName(peer.name)
        .addButton((b) => b.setButtonText("Go to cursor")
          .onClick(() => {
            if (path && this.plugin.jumpToParticipant(path, peer.id)) this.close();
            else new Notice("This collaborator has no visible cursor yet.");
          }));
    }
  }
}

export class UndoReviewModal extends Modal {
  constructor(app: IgnisConnector["app"], private readonly plugin: IgnisConnector) {
    super(app);
  }
  onOpen() {
    this.render();
  }
  onClose() {
    this.plugin.undoReviewModalClosed(this);
  }
  refresh() {
    this.render();
  }
  private render() {
    const ja = mobileUiLanguage() === "ja";
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl?.classList.add("ignis-undo-review-modal");
    contentEl.createEl("h2", { text: ja ? "元に戻す操作の確認" : "Review Undo / Redo" });
    contentEl.createEl("p", { text: ja
      ? "別の端末が元の編集位置を変更しました。勝手に文章を書き換えず、確認できるように残しています。"
      : "Another editor changed the original boundary. We have not guessed or applied the edit." });
    const reviews = this.plugin.getUndoReviews();
    if (!reviews.length) {
      contentEl.createEl("p", { text: ja ? "確認待ちの操作はありません。" : "Nothing needs review." });
      return;
    }
    for (const review of reviews) {
      const group = contentEl.createDiv({ cls: "ignis-undo-review-item" });
      group.createEl("h3", { text: review.path });
      group.createEl("p", { text:
        (review.operation === "undo" ? "Undo" : "Redo") + " · " +
        (ja ? "元の編集位置を確認できません" : "Original edit position no longer exists") });
      group.createEl("p", { text: ja
        ? "元に戻せなかった文字列（改行も含みます）"
        : "Text to review, including line breaks" });
      const input = group.createEl("textarea", {
        cls: "ignis-undo-review-original"
      }) as HTMLTextAreaElement;
      input.value = review.deleted;
      input.readOnly = true;
      input.rows = Math.min(8, Math.max(3, review.deleted.split("\n").length + 1));
      input.style.width = "100%";
      input.setAttribute("aria-label", ja ? "復元候補の元の文字列" : "Original text");
      const breaks = (review.deleted.match(/\n/g) || []).length;
      if (breaks) group.createEl("small", { text:
        ja ? "改行 " + breaks + " 個（空欄に見えても改行があります）"
          : breaks + " line break(s) included" });
      const details = group.createEl("details");
      details.createEl("summary", { text: ja
        ? "操作を試みた時点の文章を見る" : "Document excerpt at the time of the edit" });
      details.createEl("pre", { text: review.context });
      const feedback = group.createEl("p", { cls: "ignis-undo-review-feedback" });
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      new Setting(group)
        .addButton((button) => button
          .setButtonText(ja ? "元の文字列をコピー" : "Copy original text")
          .onClick(async () => {
            try {
              await navigator.clipboard.writeText(review.deleted);
              feedback.setText(ja ? "コピーしました。挿入位置を確認して貼り付けてください。" :
                "Copied. Choose the insertion point before pasting.");
            } catch {
              input.focus();
              input.select();
              feedback.setText(ja ? "文字列を選択しました。手動でコピーできます。" :
                "Text selected. Copy it manually.");
            }
          }))
        .addButton((button) => button
          .setButtonText(ja ? "確認済みにする" : "Dismiss review")
          .onClick(() => {
            if (this.plugin.dismissUndoReview(review)) this.render();
          }));
    }
  }
}

class MigrationModal extends Modal {
  private selected: string | null = null;
  private busy = false;
  private feedback = "";
  private readonly itemFeedback = new Map<string, string>();
  private confirmPath: string | null = null;
  private previewEpoch = 0;
  private languageOverride: "ja" | "en" | null = (() => {
    try {
      const value = localStorage.getItem("ignis-migration-language");
      return value === "ja" || value === "en" ? value : null;
    } catch { return null; }
  })();

  constructor(app: IgnisConnector["app"],
    private readonly plugin: IgnisConnector,
    private issues: SyncIssue[],
    private lastError: string) {
    super(app);
  }

  refresh(issues: SyncIssue[], lastError: string) {
    this.issues = issues;
    this.lastError = lastError;
    this.render();
  }

  private allIssues(): SyncIssue[] {
    const issues = new Map<string, SyncIssue>();
    for (const issue of [...this.issues, ...this.plugin.getMigrationIssues()]) {
      if (!issues.has(issue.path)) issues.set(issue.path, issue);
    }
    return [...issues.values()];
  }

  private button(parent: HTMLElement, text: string,
    action: () => void, primary = false, disabled = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ignis-migration-button" + (primary ? " mod-cta" : "");
    button.textContent = text;
    button.disabled = this.busy || disabled;
    button.addEventListener("click", action);
    parent.appendChild(button);
    return button;
  }

  private async perform(
    work: () => Promise<void>, workingMessage: string, successMessage?: string
  ) {
    if (this.busy) return;
    this.busy = true;
    this.feedback = workingMessage;
    this.render();
    try {
      await work();
      this.feedback = successMessage ??
        migrationUiCopy(this.languageOverride || mobileUiLanguage()).verified;
    } catch (error) {
      this.feedback = error instanceof Error ? error.message :
        "Could not save the copies. Original versions have been retained.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  onOpen() {
    this.modalEl.classList.add("ignis-migration-modal");
    this.render();
  }

  onClose() {
    this.previewEpoch++;
    this.plugin.migrationModalClosed(this);
  }

  private render() {
    const { contentEl } = this;
    const language = this.languageOverride || mobileUiLanguage();
    const t = migrationUiCopy(language);
    contentEl.empty();
    const issues = this.allIssues();
    const preservable = issues.filter(issue => migrationNeedsPreservation(issue.reason));
    if (!this.selected || !issues.some(issue => issue.path === this.selected)) {
      this.selected = preservable[0]?.path || issues[0]?.path || null;
    }

    const header = contentEl.createDiv({ cls: "ignis-migration-header" });
    const eyebrow = header.createDiv({ cls: "ignis-migration-eyebrow" });
    eyebrow.setText(t.eyebrow);
    const switchLanguage = this.button(header, language === "ja" ? "English" : "日本語", () => {
      this.languageOverride = language === "ja" ? "en" : "ja";
      try { localStorage.setItem("ignis-migration-language", this.languageOverride); }
      catch { /* A private WebView may deny persistence; in-memory choice still works. */ }
      this.render();
    });
    switchLanguage.classList.add("ignis-migration-language");
    switchLanguage.setAttribute("aria-label", language === "ja" ?
      "Display migration in English" : "移行画面を日本語で表示");
    contentEl.createEl("h2", { text: t.title });
    contentEl.createEl("p", {
      cls: "ignis-migration-intro",
      text: t.intro
    });
    const history = this.plugin.journalRecoveryInfo();
    if (history) {
      const panel = contentEl.createDiv({ cls: "ignis-migration-history-review" });
      panel.setAttr("role", "alert");
      panel.createEl("h3", { text: t.historyTitle });
      panel.createEl("p", { text: history.explanation });
      this.button(panel, t.recheckHistory, () =>
        void this.perform(async () => {
          const result = await this.plugin.recheckJournal();
          if (!result.ok) throw new Error(result.message);
          this.issues = this.issues.filter(issue =>
            !issue.reason.startsWith("Server journal identity requires review"));
        }, t.recheckingHistory, t.historyRestored), true);
    }
    const progress = contentEl.createDiv({ cls: "ignis-migration-steps" });
    for (const title of t.stages) {
      const chip = document.createElement("span");
      chip.textContent = title;
      progress.appendChild(chip);
    }

    const toolbar = contentEl.createDiv({ cls: "ignis-migration-toolbar" });
    const count = preservable.filter(issue => !!this.plugin.getPreservedMigration(issue.path)).length;
    toolbar.createEl("strong", { text: t.count(issues.length, count) });
    this.button(toolbar, this.busy ? t.saving : t.saveAll,
      () => void this.perform(async () => {
        let failed = 0;
        for (const issue of preservable) {
          this.itemFeedback.set(issue.path, t.savingItem);
          try {
            const result = await this.plugin.preserveMigration(issue.path);
            this.itemFeedback.set(issue.path,
              result.remoteCopy ? t.preservedPair : t.preservedLocal);
          } catch (error) {
            failed++;
            this.itemFeedback.set(issue.path,
              t.needsAttention + (error instanceof Error ? error.message : String(error)));
            // Continue only when the durable write queue is clear. A staged
            // failed request cannot be replaced by a new operation ID.
            if (this.plugin.settings.pendingWrites.length) throw error;
          }
        }
        if (failed) throw new Error(t.missingCopies(failed));
      }, t.saveProgress), true,
      !preservable.length || !!history);
    const status = contentEl.createDiv({ cls: "ignis-migration-feedback" });
    status.setAttr("role", "status");
    status.setAttr("aria-live", "polite");
    status.setText(this.feedback || t.initialStatus);

    if (!issues.length) {
      contentEl.createEl("p", {
        text: this.lastError || t.noIssues
      });
      return;
    }
    const layout = contentEl.createDiv({ cls: "ignis-migration-layout" });
    const aside = layout.createDiv({ cls: "ignis-migration-list" });
    aside.setAttr("aria-label", t.listLabel);
    for (const issue of issues) {
      const entry = aside.createDiv({ cls: "ignis-migration-item" });
      if (this.selected === issue.path) entry.classList.add("is-selected");
      const select = this.button(entry, migrationCardLabel(issue.path), () => {
        this.selected = issue.path;
        this.confirmPath = null;
        this.render();
      });
      select.classList.add("ignis-migration-select");
      select.setAttribute("aria-pressed", String(this.selected === issue.path));
      select.setAttribute("aria-label", issue.path);
      select.setAttribute("title", issue.path);
      const detail = entry.createDiv({ cls: "ignis-migration-item-note" });
      detail.setText(this.itemFeedback.get(issue.path) ||
        (this.plugin.getPreservedMigration(issue.path) ?
          t.savedEarlier : migrationReason(issue.reason, language)));
    }

    const main = layout.createDiv({ cls: "ignis-migration-detail" });
    const issue = issues.find(item => item.path === this.selected)!;
    main.createEl("h3", { text: issue.path });
    main.createEl("p", { cls: "ignis-migration-reason",
      text: migrationReason(issue.reason, language) });
    const copy = this.plugin.getPreservedMigration(issue.path);
    if (copy) {
      const saved = main.createDiv({ cls: "ignis-migration-saved" });
      saved.setAttr("role", "status");
      saved.createEl("strong", { text: t.savedHeading });
      const paths = [copy.sourceCopy, copy.remoteCopy].filter(Boolean) as string[];
      for (const target of paths) {
        const row = saved.createDiv({ cls: "ignis-migration-path" });
        row.setText(target);
        this.button(row, t.openCopy, () => {
          void this.app.workspace.openLinkText(target, "", false);
          this.close();
        });
      }
    }

    const controls = main.createDiv({ cls: "ignis-migration-actions" });
    if (!history && migrationNeedsPreservation(issue.reason)) {
      this.button(controls, t.saveSelected, () =>
        void this.perform(async () => {
          const record = await this.plugin.preserveMigration(issue.path);
          this.itemFeedback.set(issue.path,
            record.remoteCopy ? t.preservedPair : t.preservedLocal);
        }, t.verifying), true);
    }
    if (this.app.vault.getAbstractFileByPath(issue.path) instanceof TFile) {
      this.button(controls, t.original, () => {
        void this.app.workspace.openLinkText(issue.path, "", false);
        this.close();
      });
    }

    const comparison = main.createDiv({ cls: "ignis-migration-comparison" });
    comparison.setAttr("aria-label", t.comparisonLabel);
    const source = comparison.createDiv({ cls: "ignis-migration-version" });
    source.createEl("h4", { text: t.localLabel });
    const localBody = source.createEl("pre", { text: t.loading });
    const server = comparison.createDiv({ cls: "ignis-migration-version" });
    server.createEl("h4", { text: t.remoteLabel });
    const remoteBody = server.createEl("pre", { text: t.loading });
    const epoch = ++this.previewEpoch;
    void this.plugin.previewMigration(issue.path).then(data => {
      if (epoch !== this.previewEpoch) return;
      const preview = (value: string | null, empty: string) =>
        value === null ? empty : value.length > 2200 ?
          value.slice(0, 2200) + "\n" + t.previewTruncated :
          value;
      localBody.textContent = preview(data.local, t.localUnavailable);
      remoteBody.textContent = preview(data.remote, t.serverUnavailable);
    }).catch(error => {
      if (epoch !== this.previewEpoch) return;
      localBody.textContent = t.previewFailure;
      remoteBody.textContent = error instanceof Error ? error.message : t.previewFailure;
    });

    if (copy?.remoteCopy) {
      const resolve = main.createDiv({ cls: "ignis-migration-finish" });
      resolve.createEl("p", { text: t.finishNote });
      if (this.confirmPath === issue.path) {
        this.button(resolve, t.confirm, () =>
          void this.perform(async () => {
            await this.plugin.finishMigration(issue.path);
            this.confirmPath = null;
            this.itemFeedback.set(issue.path, t.finished);
          }, t.finishProgress, t.finished), true);
        this.button(resolve, t.back, () => {
          this.confirmPath = null;
          this.render();
        });
      } else {
        this.button(resolve, t.finish, () => {
          this.confirmPath = issue.path;
          this.render();
        });
      }
    }
  }
}

export class ConnectorSettings extends PluginSettingTab {
  private sharingEvents: EventRef[] = [];
  private sharingTimer: number | null = null;
  private viewEpoch = 0;

  constructor(app: any, private readonly plugin: IgnisConnector) {
    super(app, plugin);
  }

  private stopSharingUpdates() {
    this.viewEpoch++;
    if (this.sharingTimer !== null) window.clearTimeout(this.sharingTimer);
    this.sharingTimer = null;
    for (const ref of this.sharingEvents) this.app?.vault?.offref?.(ref);
    this.sharingEvents = [];
  }

  hide() {
    this.stopSharingUpdates();
    super.hide?.();
  }

  display() {
    this.stopSharingUpdates();
    const epoch = this.viewEpoch;
    const { containerEl } = this;
    containerEl.empty();
    // Make identity editing discoverable without scrolling into Advanced.
    // The same editor is reachable through the mobile ribbon and commands.
    new Setting(containerEl).setName("Your display name")
      .setDesc(this.plugin.getDisplayName() +
        " · Visible beside your cursor on other devices")
      .addButton((b) => b.setButtonText("Change name")
        .onClick(() => this.plugin.openDisplayName()));
    containerEl.createEl("h3", { text: "Connect to Ignis" });
    containerEl.createEl("p", {
      text: "Paste one connection link. If Tailscale is connected, no token or Vault ID entry is needed."
    });
    const incoming = this.plugin.takeIncomingLink();
    const draft: ConnectionDraft = {
      serverUrl: incoming || (this.plugin.settings.serverUrl &&
        this.plugin.settings.vaultId ?
          this.plugin.settings.serverUrl + "/join/" +
            encodeURIComponent(this.plugin.settings.vaultId) :
          this.plugin.settings.serverUrl),
      vaultId: this.plugin.settings.vaultId,
      token: ""
    };
    if (incoming) {
      try { draft.vaultId = parseJoinLink(incoming).vaultId; }
      catch { /* A malformed link is still validated on Connect. */ }
    }
    const state = this.plugin.connectionSummary();
    let recheckButton: { setDisabled(disabled: boolean): unknown } | undefined;
    const feedback = containerEl.createDiv({ cls: "ignis-connection-feedback" });
    feedback.setAttr("role", "status");
    feedback.setAttr("aria-live", "polite");
    feedback.setText(connectionRecoveryLabel(state, this.plugin.settings));
    const journalIssue = this.plugin.journalRecoveryInfo();
    const historyFeedback = containerEl.createDiv({ cls: "ignis-journal-feedback" });
    historyFeedback.setAttr("role", "status");
    historyFeedback.setAttr("aria-live", "polite");
    const historySetting = new Setting(containerEl)
      .setName(journalIssue ? "Server history needs review" : "Server sync history")
      .setDesc(journalIssue?.explanation ||
        (this.plugin.settings.journalLineage
          ? "This Vault's journal identity is pinned on this device. A replacement server will not silently receive the old edits."
          : "The server's journal will be verified before any local drafts are shared."));
    historySetting.addButton(button => button
      .setButtonText("Recheck and resume")
      .setDisabled(!state.ready)
      .onClick(async () => {
        button.setDisabled(true).setButtonText("Checking history…");
        try {
          const result = await this.plugin.recheckJournal();
          historyFeedback.setText(result.message);
        } finally {
          button.setDisabled(false).setButtonText("Recheck and resume");
        }
      }));
    const sharingMode = new Setting(containerEl).setName("Files allowed by server");
    const renderMode = () => {
      const bypass = this.plugin.getServerMediaBypassExtensions();
      sharingMode.setDesc(
        (this.plugin.settings.contentScope === "markdown-only"
          ? "Markdown (.md)" + (bypass.length ?
            " + authorized bypass types: " + bypass.join(", ") :
            " only; attachments stay local")
          : "Markdown and attachments") +
        ". IGNIS Sync uses a 4 MiB per-file limit, independent of Syncthing."
      );
    };
    renderMode();
    const sharingFeedback = containerEl.createDiv({ cls: "ignis-sharing-feedback" });
    sharingFeedback.setAttr("role", "status");
    sharingFeedback.setAttr("aria-live", "polite");
    const sharingSummaryEl = containerEl.createDiv({ cls: "ignis-sharing-summary" });
    sharingSummaryEl.setAttr("aria-live", "polite");
    const renderSharing = () => {
      const summary = this.plugin.getSharingDetails();
      sharingSummaryEl.setText(
        summary.sharedFiles + " file(s) eligible · " +
        summary.localOnlyFiles + " file(s) kept on this device (" +
        formatLocalBytes(summary.localOnlyBytes) + ") · " +
        summary.pendingOperations + " unsent operation(s)." +
        (summary.blockedQueued ? " " + summary.blockedQueued +
          " queued operation(s) need review before syncing." : "") +
        (summary.oversizedFiles ? " " + summary.oversizedFiles +
          " file(s) exceed the 4 MiB transfer limit." : "") +
        (summary.emptyFolders ? " " + summary.emptyFolders +
          " empty folder(s) are not synchronized and stay on this device." : "")
      );
    };
    renderSharing();
    // The counters describe the current Vault, not the moment the settings
    // tab opened. Subscribe only while this tab exists and coalesce the
    // filesystem event burst from a single binary copy into one repaint.
    if (this.app?.vault) {
      const scheduleSharing = () => {
        if (epoch !== this.viewEpoch || this.sharingTimer !== null) return;
        this.sharingTimer = window.setTimeout(() => {
          this.sharingTimer = null;
          if (epoch === this.viewEpoch) renderSharing();
        }, 100);
      };
      this.sharingEvents.push(
        this.app.vault.on("create", scheduleSharing),
        this.app.vault.on("delete", scheduleSharing),
        this.app.vault.on("rename", scheduleSharing),
        this.app.vault.on("modify", scheduleSharing)
      );
    }
    new Setting(containerEl).setName("Keep attachments on this device")
      .setDesc("Share only Markdown, plus any individual bypass types you select below. Existing local files are not deleted.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.deviceContentScope === "markdown-only")
        .onChange(async (enabled) => {
          const outcome = await this.plugin.setDeviceContentScope(
            enabled ? "markdown-only" : "follow-server"
          );
          if (!outcome.ok) toggle.setValue(!enabled);
          sharingFeedback.setText(outcome.message);
          renderSharing();
        }));
    const bypassDetails = containerEl.createEl("details", {
      cls: "ignis-media-bypass-details",
    });
    bypassDetails.createEl("summary", { text: "PDFs and media Bypass" });
    bypassDetails.createEl("p", { text:
      "When Keep attachments is enabled, choose the document/media types " +
      "that IGNIS Sync may still transfer. Syncthing's running or stopped " +
      "state does not change this rule. Each file must be at most 4 MiB. " +
      "The Mac server must also authorize these types.",
      cls: "setting-item-description",
    });
    const bypassFeedback = bypassDetails.createDiv({
      cls: "ignis-media-bypass-feedback",
    });
    bypassFeedback.setAttr("role", "status");
    bypassFeedback.setAttr("aria-live", "polite");
    const pretty = (extension: string) => ({
      pdf: "PDF document", docx: "Word document", xlsx: "Excel workbook",
      pptx: "PowerPoint presentation",
    } as Record<string, string>)[extension] || "." + extension + " media";
    for (const extension of MEDIA_BYPASS_TYPES) {
      new Setting(bypassDetails).setName(pretty(extension) + " (." + extension + ")")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.getDeviceMediaBypassExtensions().includes(extension))
          .onChange(async (selected) => {
            const current = this.plugin.getDeviceMediaBypassExtensions();
            const proposed = selected ?
              [...current, extension] : current.filter((item) => item !== extension);
            const result = await this.plugin.setDeviceMediaBypassExtensions(proposed);
            if (!result.ok) toggle.setValue(!selected);
            bypassFeedback.setText(result.message);
            renderSharing();
          }));
    }
    new Setting(containerEl).setName("Check sharing rules")
      .setDesc("Read the server's current scope without restarting live editing. No file content is uploaded.")
      .addButton((button) => {
        recheckButton = button;
        button.setButtonText("Recheck")
        .setDisabled(!state.ready)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Checking…");
          try {
            const outcome = await this.plugin.recheckSharingScope();
            sharingFeedback.setText(outcome.message);
            renderMode();
            renderSharing();
          } finally {
            button.setDisabled(false).setButtonText("Recheck");
          }
        });
      });
    new Setting(containerEl).setName("Review unsent changes")
      .setDesc("Inspect pending paths and sync conflicts. Nothing is discarded or uploaded by opening this view.")
      .addButton((button) => button.setButtonText("Review")
        .onClick(() => this.plugin.openSyncIssues()));
    const availableVaults = containerEl.createDiv({ cls: "ignis-vault-picker" });
    availableVaults.setAttr("aria-live", "polite");

    let serverInput: HTMLInputElement;
    let vaultInput: HTMLInputElement;
    let tokenInput: HTMLInputElement;
    let syncButton: { setDisabled(disabled: boolean): unknown } | undefined;
    new Setting(containerEl).setName("Connection link")
      .setDesc("A complete HTTPS /join/VaultID link, or just your Tailnet server URL.")
      .addText((t) => {
        t.setPlaceholder("https://your-mac.example.ts.net:8451/join/IOSLab")
          .setValue(draft.serverUrl)
          .onChange((value) => {
            draft.serverUrl = value;
            try {
              const parsed = parseJoinLink(value);
              if (parsed.vaultId) {
                draft.vaultId = parsed.vaultId;
                vaultInput.value = parsed.vaultId;
              }
            } catch { /* Validation on Connect, not on every keystroke. */ }
          });
        t.inputEl.type = "url";
        serverInput = t.inputEl;
      });
    const advancedConnection = containerEl.createEl("details");
    advancedConnection.createEl("summary", { text: "Advanced: Vault ID or device-token connection" });
    new Setting(advancedConnection).setName("Vault ID (optional)")
      .setDesc("Needed only when your server doesn't support automatic Vault discovery.")
      .addText((t) => {
        t.setPlaceholder("IOSLab")
          .setValue(draft.vaultId)
          .onChange((value) => { draft.vaultId = value; });
        vaultInput = t.inputEl;
      });
    new Setting(advancedConnection).setName("Device token (optional)")
      .setDesc("Fallback for a server without Tailscale identity authentication.")
      .addText((t) => {
        t.setPlaceholder("ignis_dev_…")
          .onChange((value) => { draft.token = value; });
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        tokenInput = t.inputEl;
      });
    containerEl.createEl("p", {
      text: "Nothing is transmitted until you tap Connect. A Tailscale login can grant access to your Vault without a device token.",
      cls: "setting-item-description"
    });
    new Setting(containerEl)
      .setName("Verify connection")
      .setDesc("Checks your link and permissions, then remembers only the verified connection.")
      .addButton((button) => button.setButtonText("Connect and verify")
        .setCta()
        .onClick(async () => {
          serverInput.disabled = true;
          vaultInput.disabled = true;
          tokenInput.disabled = true;
          button.setDisabled(true).setButtonText("Checking connection…");
          feedback.setText("Checking your Tailscale identity and Vault access…");
          try {
            const result = await this.plugin.connectToServer({ ...draft });
            feedback.setText(result.message);
            availableVaults.empty();
            if (result.availableVaults?.length) {
              availableVaults.createEl("p", {
                text: "Your Tailscale account can access these Vaults:"
              });
              const picker = availableVaults.createEl("select");
              picker.setAttr("aria-label", "Choose an Ignis Vault");
              for (const name of result.availableVaults) {
                const option = picker.createEl("option", { text: name });
                option.setAttr("value", name);
              }
              picker.value = result.availableVaults[0];
              draft.vaultId = picker.value;
              vaultInput.value = picker.value;
              picker.addEventListener("change", () => {
                draft.vaultId = picker.value;
                vaultInput.value = picker.value;
              });
            }
            if (result.ok) {
              // Clear only after the server has verified the token.
              draft.token = "";
              tokenInput.value = "";
              button.setButtonText("Connected");
              syncButton?.setDisabled(false);
              recheckButton?.setDisabled(false);
              renderMode();
              renderSharing();
            } else {
              button.setButtonText("Retry connection");
            }
          } catch {
            feedback.setText("Could not save this connection. Your fields are unchanged; try again.");
            button.setButtonText("Retry connection");
          } finally {
            serverInput.disabled = false;
            vaultInput.disabled = false;
            tokenInput.disabled = false;
            button.setDisabled(false);
          }
        }));
    new Setting(containerEl).setName("Sync now")
      .setDesc("Available after the server confirms this device. Conflicting local content is retained.")
      .addButton((b) => {
        syncButton = b;
        b.setButtonText("Sync").setDisabled(!state.ready)
          .onClick(() => void this.plugin.syncNow());
      });
    if (state.ready && this.plugin.settings.serverUrl && state.vaultId) {
      const link = this.plugin.settings.serverUrl + "/join/" +
        encodeURIComponent(state.vaultId);
      new Setting(containerEl).setName("Connection link")
        .setDesc("Share the link, not a device token. The recipient still needs Vault access.")
        .addButton((b) => b.setButtonText("Copy link").onClick(async () => {
          try {
            await navigator.clipboard.writeText(link);
            feedback.setText("Connection link copied. It contains no credentials.");
          } catch {
            feedback.setText("Copy the link manually: " + link);
          }
        }));
    }
    new Setting(containerEl).setName("Move verified remote deletions to local trash")
      .setDesc("Off by default. Only a server tombstone for the same file ID and unchanged local content can move a file into Obsidian's recoverable .trash.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.applyRemoteDeletes)
        .onChange(async (value) => {
          this.plugin.settings.applyRemoteDeletes = value;
          await this.plugin.saveSettings();
        }));
    const advanced = containerEl.createEl("details");
    advanced.createEl("summary", { text: "Advanced: Syncthing Discovery" });
    advanced.createEl("p", {
      text: "Optional address lookup. Discovery never overrides the verified HTTPS server."
    });
    new Setting(advanced).setName("Discovery URL")
      .setDesc("Optional private stdiscosrv /v2/ HTTPS endpoint")
      .addText((t) => t.setValue(this.plugin.settings.discoveryUrl)
        .onChange(async (value) => {
          this.plugin.settings.discoveryUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(advanced).setName("Syncthing Device ID")
      .addText((t) => t.setValue(this.plugin.settings.serverDeviceId)
        .onChange(async (value) => {
          this.plugin.settings.serverDeviceId = value.trim();
          await this.plugin.saveSettings();
        }));
  }
}
