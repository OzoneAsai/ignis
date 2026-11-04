import {
  Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, editorInfoField, requestUrl
} from "obsidian";
import { NativeYjs } from "./live";
import {
  queueRename, queueDelete, acknowledgePending, localPaths,
  type TrackedFile, type PendingMutation
} from "./pending";
import {
  stageWrite, acknowledgeWrite, type StagedWrite
} from "./writes";
import { classifyAbsence, readChangesThrough } from "./reconcile";

// The same Web APIs and Obsidian Vault APIs run on macOS, Windows, Linux,
// Android and iOS. Never import Node/Electron into this plugin bundle.
type Base = TrackedFile;
type Pending = PendingMutation;
type SyncIssue = { path: string; reason: string };
type Settings = {
  serverUrl: string;
  discoveryUrl: string;
  serverDeviceId: string;
  vaultId: string;
  deviceId: string;
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
  serverUrl: "", discoveryUrl: "", serverDeviceId: "", vaultId: "", deviceId: "",
  cursor: 0, baselines: {}, pending: [], pendingWrites: [],
  applyRemoteDeletes: false, syncIssues: [], yjsIds: {},
  scope: "", archivedScopes: []
};
const SECRET_PREFIX = "ignis-connector-vault-";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

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
  const url = new URL(input);
  if ((url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTPS server origin without a path, query or credentials");
  }
  return url.origin;
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

export default class IgnisConnector extends Plugin {
  declare settings: Settings;
  private token = "";
  private socket: WebSocket | null = null;
  private syncing = false;
  private queued = false;
  private quiet = new Set<string>();
  private status!: HTMLElement;
  private timer: number | null = null;
  private lastError = "";
  private live!: NativeYjs;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private needsReload = false;
  private authBlocked = false;
  private retryCount = 0;
  private persistTail: Promise<void> = Promise.resolve();

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
      baselines: saved?.baselines || {},
      pending: saved?.pending || [],
      pendingWrites: saved?.pendingWrites || [],
      applyRemoteDeletes: saved?.applyRemoteDeletes === true,
      syncIssues: saved?.syncIssues || [],
      yjsIds: saved?.yjsIds || {},
      archivedScopes: saved?.archivedScopes || []
    };
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
    this.status = this.addStatusBarItem();
    this.showStatus("Not connected");
    this.addSettingTab(new ConnectorSettings(this.app, this));
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
      callback: () => new SyncIssuesModal(
        this.app, this.settings.syncIssues, this.lastError
      ).open()
    });
    this.addCommand({
      id: "archive-and-switch-server",
      name: "Archive old connector state and switch server or Vault",
      callback: () => void this.archiveAndSwitch()
    });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && isSyncablePath(file.path) && !this.quiet.has(file.path)) {
        this.schedule();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || this.quiet.has(file.path) ||
          !isSyncablePath(oldPath) || !isSyncablePath(file.path)) return;
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
          !isSyncablePath(file.path)) return;
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

  onunload() {
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
  async saveToken(token: string) {
    if (this.needsReload) {
      new Notice("Restart Ignis Connector to change the server or Vault");
      return;
    }
    if (!/^ignis_dev_[A-Za-z0-9_-]{43}$/.test(token)) {
      new Notice("Use an Ignis device token, not the server administrator token");
      return;
    }
    const secrets = (this.app as any).secretStorage;
    if (!this.settings.scope) this.settings.scope = this.currentScope();
    if (!this.matchesScope()) {
      new Notice("Server/Vault changed: archive the old sync state before entering a new token");
      return;
    }
    // Verify the *selected* origin and Vault before ever persisting a
    // credential. Discovery only advertises candidate addresses.
    const scope = this.settings.scope;
    let session: { deviceId: string; vaultId: string; label: string };
    try {
      const response = await requestUrl({
        url: this.url("/vaults/" + encodeURIComponent(this.settings.vaultId) + "/session"),
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        throw: false
      });
      if (response.status !== 200 || response.json?.vaultId !== this.settings.vaultId ||
          typeof response.json?.deviceId !== "string") {
        new Notice("This device token was rejected or belongs to another Vault");
        return;
      }
      session = response.json;
    } catch {
      new Notice("Could not verify the device token via HTTPS; it was not saved");
      return;
    }
    if (this.stopped || !this.matchesScope() || this.settings.scope !== scope) return;
    if (!secrets?.setSecret || !this.settings.vaultId) {
      new Notice("Obsidian SecretStorage is required; token kept only until app exit");
    } else {
      secrets.setSecret(SECRET_PREFIX + this.settings.scope, token);
    }
    this.token = token;
    this.settings.deviceId = session.deviceId;
    await this.persistSettings();
    this.authBlocked = false;
    this.retryCount = 0;
    this.connectSocket();
    this.schedule();
    new Notice("Ignis device linked: " + session.label);
  }

  async saveSettings() {
    await this.persistSettings();
    // SecretStorage is not guaranteed on every supported mobile build.
    // A token held only in memory must survive an unrelated settings edit,
    // but it must never carry over to a different server/Vault identity.
    const sameScope = this.matchesScope();
    const storedToken = this.getSavedSecret();
    this.token = sameScope ? (storedToken || this.token) : "";
    this.live.disconnected();
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    if (!this.matchesScope()) {
      this.showStatus("Server/Vault changed · archive old state before switching");
      return;
    }
    if (this.ready()) this.connectSocket();
    this.schedule();
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
      /^ignis_dev_[A-Za-z0-9_-]{43}$/.test(this.token));
  }
  async archiveAndSwitch() {
    const newScope = this.currentScope();
    if (newScope === this.settings.scope) {
      new Notice("The current server and Vault are already selected");
      return;
    }
    this.settings.archivedScopes.push({
      scope: this.settings.scope,
      cursor: this.settings.cursor,
      baselines: this.settings.baselines,
      pending: this.settings.pending,
      pendingWrites: this.settings.pendingWrites,
      syncIssues: this.settings.syncIssues,
      yjsIds: this.settings.yjsIds
    });
    this.settings.scope = newScope;
    this.settings.cursor = 0;
    this.settings.baselines = {};
    this.settings.pending = [];
    this.settings.pendingWrites = [];
    this.settings.syncIssues = [];
    this.settings.yjsIds = {};
    this.settings.deviceId = "";
    this.token = "";
    this.authBlocked = false;
    this.retryCount = 0;
    this.needsReload = true;
    this.live.disconnected();
    this.socket?.close();
    await this.persistSettings();
    this.showStatus("Archived old state · restart plugin before connecting");
    new Notice("Old pending work was archived, not deleted. Disable and re-enable Ignis Connector before entering a token.");
  }
  private showStatus(status: string) {
    if (this.status) this.status.setText("Ignis: " + status);
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
        Authorization: "Bearer " + this.token,
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
        socket.send(JSON.stringify({ channel: "sync", type: "auth", token }));
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
      .filter((file) => isSyncablePath(file.path)).map((file) => [file.path, file]));
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
        if (!isSyncablePath(remote.path)) continue;
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
        this.showStatus("Synced · server acknowledged");
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

class ConnectorSettings extends PluginSettingTab {
  constructor(app: any, private readonly plugin: IgnisConnector) {
    super(app, plugin);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Ignis HTTPS origin")
      .setDesc("Manually trusted origin. Discovery cannot silently replace it.")
      .addText((t) => t.setPlaceholder("https://ignis.example.org")
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("Vault ID")
      .addText((t) => t.setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("This device's Ignis token")
      .setDesc("Have the server administrator enroll this device and paste its ignis_dev_ token. Never enter IGNIS_SYNC_TOKEN here.")
      .addText((t) => t.setPlaceholder("ignis_dev_…")
        .onChange(async (value) => {
          if (/^ignis_dev_[A-Za-z0-9_-]{43}$/.test(value)) {
            await this.plugin.saveToken(value);
            t.setValue("");
          }
        }));
    new Setting(containerEl).setName("Registered device ID")
      .setDesc(this.plugin.settings.deviceId || "No device credential verified");
    new Setting(containerEl).setName("Syncthing Discovery URL")
      .setDesc("Optional private stdiscosrv /v2/ HTTPS endpoint")
      .addText((t) => t.setValue(this.plugin.settings.discoveryUrl)
        .onChange(async (value) => {
          this.plugin.settings.discoveryUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("Ignis Syncthing Device ID")
      .addText((t) => t.setValue(this.plugin.settings.serverDeviceId)
        .onChange(async (value) => {
          this.plugin.settings.serverDeviceId = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("Sync now")
      .setDesc("Experimental preview. Conflicting local content is never overwritten.")
      .addButton((b) => b.setButtonText("Sync").onClick(() => void this.plugin.syncNow()));
    new Setting(containerEl).setName("Move verified remote deletions to local trash")
      .setDesc("Off by default. Only a server tombstone for the same file ID and unchanged local content can move a file into Obsidian's recoverable .trash.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.applyRemoteDeletes)
        .onChange(async (value) => {
          this.plugin.settings.applyRemoteDeletes = value;
          await this.plugin.saveSettings();
        }));
  }
}
