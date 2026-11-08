import {
  Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, TFile,
  editorInfoField, requestUrl, setIcon
} from "obsidian";
import { NativeYjs } from "./live";
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
import { classifyAbsence, readChangesThrough } from "./reconcile";
import {
  normalizeOrigin, parseJoinLink, validateConnection, sessionError,
  type ConnectionDraft
} from "./connection-setup";
import { importNativeFiles, nativeConnectionState } from "./mobile-controls";
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

// The same Web APIs and Obsidian Vault APIs run on macOS, Windows, Linux,
// Android and iOS. Never import Node/Electron into this plugin bundle.
type Base = TrackedFile;
type Pending = PendingMutation;
type SyncIssue = { path: string; reason: string };
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
  baselines: Record<string, Base>;
  pending: Pending[];
  pendingWrites: StagedWrite[];
  applyRemoteDeletes: boolean;
  syncIssues: SyncIssue[];
  yjsIds: Record<string, string>;
  scope: string;
  archivedScopes: Array<{
    scope: string;
    cursor: number;
    baselines: Record<string, Base>;
    pending: Pending[];
    pendingWrites: StagedWrite[];
    syncIssues: SyncIssue[];
    yjsIds: Record<string, string>;
  }>;
};
type RemoteFile = Base & { path: string; size: number };
type Manifest = { vaultId: string; vaultSeq: number; files: RemoteFile[] };
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
  cursor: 0, baselines: {}, pending: [], pendingWrites: [],
  applyRemoteDeletes: false, syncIssues: [], yjsIds: {},
  scope: "", archivedScopes: []
};
const SECRET_PREFIX = "ignis-connector-vault-";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
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
    return sharingSummary(
      files, this.settings.contentScope || "all",
      this.settings.deviceContentScope || "follow-server",
      this.settings.pending || [], this.settings.pendingWrites || [],
      this.settings.serverMediaBypassExtensions || [],
      this.settings.deviceMediaBypassExtensions || [],
    );
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
  private socket: WebSocket | null = null;
  private syncing = false;
  private queued = false;
  private quiet = new Set<string>();
  private status: HTMLElement | null = null;
  private collaborationRibbon: HTMLElement | null = null;
  private mobileActions: HTMLElement | null = null;
  private mobileConnection: HTMLButtonElement | null = null;
  private mobileConnectionDot: HTMLElement | null = null;
  private mobileMenu: NativeMobileActionsModal | null = null;
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
      pending: saved?.pending || [],
      pendingWrites: saved?.pendingWrites || [],
      applyRemoteDeletes: saved?.applyRemoteDeletes === true,
      syncIssues: saved?.syncIssues || [],
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
      rememberId: async (path, id) => {
        this.settings.yjsIds[path] = id;
        await this.persistSettings();
      },
      displayName: () => this.getDisplayName(),
      mobile: Platform.isMobile,
      send: (message) => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify(message));
        }
      },
      notify: (path, status) => {
        this.lastError = path + ": " + status;
        this.showStatus(status);
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
    this.addCommand({
      id: "show-collaborators",
      name: "Show collaborators and display name",
      callback: () => this.openCollaborators()
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
    this.token = this.getSavedSecret();
    if (this.ready()) {
      this.connectSocket();
      this.schedule();
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

  getCurrentStatus(): string {
    return this.statusText;
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
        () => nativeConnectionState(this.statusText, this.ready(),
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
          "; retained until the server acknowledges it.",
      })),
      ...(this.settings.pendingWrites || []).map((operation) => ({
        path: operation.path,
        reason: "Unsent " + operation.type +
          "; staged bytes are retained for safe retry.",
      })),
    ];
    new SyncIssuesModal(this.app,
      [...(this.settings.syncIssues || []), ...queued], this.lastError).open();
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

  private getSavedSecret(): string {
    const secrets = (this.app as any).secretStorage;
    if (!secrets || !this.settings.vaultId || !this.matchesScope()) return "";
    return secrets.getSecret(SECRET_PREFIX + this.settings.scope) || "";
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
        this.token || this.getSavedSecret() : "";
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
        cursor: this.settings.cursor,
        baselines: this.settings.baselines,
        pending: this.settings.pending,
        pendingWrites: this.settings.pendingWrites,
        syncIssues: this.settings.syncIssues,
        yjsIds: this.settings.yjsIds
      });
      this.settings.cursor = 0;
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
    this.settings.deviceId = session.deviceId;
    this.settings.contentScope = incomingScope;
    this.settings.serverMediaBypassExtensions = [
      ...normalizeMediaBypassExtensions(session.mediaBypassExtensions || [])
    ];
    this.rebuildFileScope();
    this.token = selectedToken;
    if (switching) await this.live.resetForConnection();
    const secrets = (this.app as any).secretStorage;
    let memoryOnly = !!selectedToken && !secrets?.setSecret;
    if (selectedToken && secrets?.setSecret) {
      try {
        await secrets.setSecret(SECRET_PREFIX + target.scope, selectedToken);
      } catch {
        memoryOnly = true;
      }
    }
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
        (memoryOnly ? ". Device token is held only until Obsidian closes." : ".") +
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
    if (this.status) this.status.setText("Ignis: " + status);
    // Obsidian's custom status bar doesn't exist on mobile. This reflects
    // the *actual* sync message, never treats a connected socket as a save ACK.
    this.collaborationRibbon?.setAttribute("aria-label", "Ignis: " + status +
      " · open collaborators and sync status");
    this.collaborationRibbon?.setAttribute("title", "Ignis: " + status);
    if (this.mobileConnection) {
      const projection = nativeConnectionState(
        status, this.ready(), this.socket?.readyState === WebSocket.OPEN,
        mobileUiLanguage(),
      );
      this.mobileActions?.setAttribute("data-connection", projection.kind);
      this.mobileConnection.setAttribute("aria-label",
        "Ignis: " + projection.label + " · " + mobileUiCopy().openActions);
      this.mobileConnection.setAttribute("title", "Ignis: " + status);
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
      throw new Error("Ignis Sync HTTP " + response.status);
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
            if (authorized) void this.live.handle(message);
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
              authorized = true;
              this.retryCount = 0;
              this.live.connected();
              this.schedule();
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
          if (event.code === 4003 || event.code === 4001) {
            this.authBlocked = true;
            this.showStatus("Device revoked or no longer authorized");
            return;
          }
          if (!this.stopped && this.ready() && !document.hidden) this.retryConnection();
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
    return { contentBase64: encodeBase64(
      new Uint8Array(await this.app.vault.readBinary(file))
    ) };
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
    for (const pending of [...this.settings.pending]) {
      if (!this.canShare(pending.path) ||
          (pending.toPath && !this.canShare(pending.toPath))) {
        throw new Error("An excluded file has an unsent rename/delete; review before syncing");
      }
      const result = await this.sendOperation(pending);
      acknowledgePending(this.settings, result);
      if (pending.toPath) {
        this.live.rejoinPath(pending.toPath);
      }
      await this.persistSettings();
    }
  }
  private async replayWrites() {
    const vaultId = encodeURIComponent(this.settings.vaultId);
    while (this.settings.pendingWrites.length) {
      const staged = this.settings.pendingWrites[0];
      if (!this.canShare(staged.path)) {
        throw new Error("An excluded file has an unsent write; review before syncing");
      }
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
          throw new Error("Staged write differs from current local file; review before replay: " +
            staged.path);
        }
        receipt = await this.sendOperation({
          opId: staged.opId, type: staged.type, path: staged.path,
          ...(staged.content !== undefined ? { content: staged.content } :
            { contentBase64: staged.contentBase64 }),
          ...(staged.type === "modify" ? {
            fileId: staged.fileId, generationId: staged.generationId,
            baseHash: staged.baseHash
          } : {})
        });
      } else {
        throw new Error("Could not verify staged write receipt: HTTP " + receiptResponse.status);
      }
      // Check the receipt before mutating any local tracking state.
      acknowledgeWrite(this.settings.pendingWrites, receipt);
      this.saveBase(staged.path, receipt);
      await this.persistSettings();
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

  async syncNow() {
    if (!this.ready()) return;
    if (this.syncing) { this.queued = true; return; }
    this.syncing = true;
    this.showStatus("Syncing");
    try {
      // A local operation receipt proves only that ONE operation committed,
      // not that all intervening remote changes were reconciled.
      const startingCursor = this.settings.cursor;
      await this.replayWrites();
      await this.replayPending();
      const vaultId = encodeURIComponent(this.settings.vaultId);
      const manifest = await this.api("/vaults/" + vaultId + "/manifest") as Manifest;
      const changes = await readChangesThrough(startingCursor, manifest.vaultSeq,
        (since, limit) => this.api("/vaults/" + vaultId +
          "/changes?since=" + since + "&limit=" + limit));
      const local = this.localFiles();
      const remotePaths = new Set<string>();
      const conflicts: SyncIssue[] = [];
      const report = (path: string, reason: string) =>
        conflicts.push({ path, reason });
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
          if (localDigest === remote.hash) this.saveBase(remote.path, remote);
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
          await this.stageAndSend("modify", existing, base);
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
      for (const [path, file] of local) {
        if (this.live.isManaged(path)) continue;
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
        if (this.openInEditor(path)) continue;
        await this.stageAndSend("create", file);
        await this.persistSettings();
      }
      // Only an explicit tombstone for the same file generation may trigger
      // local trash, and only after verifying the local bytes are unchanged.
      for (const path of Object.keys(this.settings.baselines)) {
        if (!this.canShare(path)) continue;
        const base = this.settings.baselines[path];
        const absence = classifyAbsence(path, base, remotePaths, changes);
        if (absence === "present") continue;
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
      if (conflicts.length) {
        this.lastError = conflicts.slice(0, 4)
          .map((issue) => issue.path + ": " + issue.reason).join("; ");
        this.showStatus(conflicts.length + " items need review");
      } else {
        this.settings.cursor = manifest.vaultSeq;
        // REST journal synchronization and live Yjs persistence are two
        // different durability planes. A successful manifest/operation sync
        // cannot prove that every open Markdown collaboration is saved.
        const live = this.live.saveState();
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
        } else {
          this.showStatus("Synced · server acknowledged");
        }
      }
      this.settings.syncIssues = conflicts;
      await this.persistSettings();
    } catch (error) {
      this.lastError = String(error);
      this.showStatus("Pending · locally retained");
      console.warn("[ignis-connector] Sync failed:", error);
    } finally {
      this.syncing = false;
      if (this.queued) { this.queued = false; this.schedule(); }
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

class SyncIssuesModal extends Modal {
  constructor(app: IgnisConnector["app"], private readonly issues: SyncIssue[],
    private readonly lastError: string) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Ignis sync review" });
    if (!this.issues.length) {
      contentEl.createEl("p", {
        text: this.lastError || "No unresolved file conflicts from the last completed sync."
      });
      return;
    }
    contentEl.createEl("p", {
      text: "No conflicting content has been overwritten. Review each local file before deciding how to reconcile it."
    });
    const list = contentEl.createEl("ul");
    for (const issue of this.issues) {
      const item = list.createEl("li");
      item.createEl("strong", { text: issue.path });
      item.appendText(" — " + issue.reason);
      if (this.app.vault.getAbstractFileByPath(issue.path) instanceof TFile) {
        new Setting(item).addButton((button) => button
          .setButtonText("Open local")
          .onClick(async () => {
            await this.app.workspace.openLinkText(issue.path, "", false);
            this.close();
          }));
      }
    }
  }
}

export class ConnectorSettings extends PluginSettingTab {
  constructor(app: any, private readonly plugin: IgnisConnector) {
    super(app, plugin);
  }
  display() {
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
          " file(s) exceed the 4 MiB transfer limit." : "")
      );
    };
    renderSharing();
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
