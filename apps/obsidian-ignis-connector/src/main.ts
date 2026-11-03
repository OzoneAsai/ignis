import {
  Plugin, PluginSettingTab, Setting, Notice, TFile, requestUrl
} from "obsidian";

// The same Web APIs and Obsidian Vault APIs run on macOS, Windows, Linux,
// Android and iOS. Never import Node/Electron into this plugin bundle.
type Base = {
  fileId: string;
  generationId: string;
  hash: string;
  revision: number;
};
type Pending = {
  opId: string;
  type: "rename" | "delete";
  path: string;
  toPath?: string;
  fileId: string;
  generationId: string;
  baseHash: string;
};
type Settings = {
  serverUrl: string;
  discoveryUrl: string;
  serverDeviceId: string;
  vaultId: string;
  cursor: number;
  baselines: Record<string, Base>;
  pending: Pending[];
};
type RemoteFile = Base & { path: string; size: number };
type Manifest = { vaultId: string; vaultSeq: number; files: RemoteFile[] };
type OperationResult = {
  vaultId: string;
  seq: number;
  fileId: string;
  generationId: string;
  type: string;
  hash: string | null;
  path: string;
  toPath?: string | null;
};

const DEFAULT: Settings = {
  serverUrl: "", discoveryUrl: "", serverDeviceId: "", vaultId: "",
  cursor: 0, baselines: {}, pending: []
};
const SECRET_PREFIX = "ignis-connector-vault-";
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md") &&
    !path.split("/").some((part) =>
      [".obsidian", ".git", ".ignis-connector"].includes(part));
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
  settings!: Settings;
  private token = "";
  private socket: WebSocket | null = null;
  private syncing = false;
  private queued = false;
  private quiet = new Set<string>();
  private status!: HTMLElement;
  private timer: number | null = null;
  private lastError = "";

  async onload() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = {
      ...DEFAULT, ...saved,
      baselines: saved?.baselines || {},
      pending: saved?.pending || []
    };
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
      name: "Show last Ignis sync issue",
      callback: () => new Notice(this.lastError || "No sync issue recorded")
    });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && isMarkdown(file.path) && !this.quiet.has(file.path)) {
        this.schedule();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || this.quiet.has(file.path) ||
          !isMarkdown(oldPath) || !isMarkdown(file.path)) return;
      const base = this.settings.baselines[oldPath];
      if (base) this.settings.pending.push({
        opId: crypto.randomUUID(), type: "rename", path: oldPath,
        toPath: file.path, fileId: base.fileId,
        generationId: base.generationId, baseHash: base.hash
      });
      void this.saveData(this.settings).then(() => this.schedule());
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFile) || this.quiet.has(file.path) ||
          !isMarkdown(file.path)) return;
      const base = this.settings.baselines[file.path];
      if (base) this.settings.pending.push({
        opId: crypto.randomUUID(), type: "delete", path: file.path,
        fileId: base.fileId, generationId: base.generationId,
        baseHash: base.hash
      });
      void this.saveData(this.settings).then(() => this.schedule());
    }));
    this.registerInterval(window.setInterval(() => this.schedule(), 45000));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    this.token = this.getSavedSecret();
    if (this.ready()) {
      this.connectSocket();
      this.schedule();
    }
  }

  onunload() {
    this.socket?.close();
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  private getSavedSecret(): string {
    const secrets = (this.app as any).secretStorage;
    if (!secrets || !this.settings.vaultId) return "";
    return secrets.getSecret(SECRET_PREFIX + this.settings.vaultId) || "";
  }
  async saveToken(token: string) {
    const secrets = (this.app as any).secretStorage;
    if (!secrets?.setSecret || !this.settings.vaultId) {
      new Notice("Obsidian SecretStorage is required; token kept only until app exit");
    } else {
      secrets.setSecret(SECRET_PREFIX + this.settings.vaultId, token);
    }
    this.token = token;
    this.connectSocket();
    this.schedule();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.token = this.getSavedSecret() || this.token;
    this.socket?.close();
    if (this.ready()) this.connectSocket();
    this.schedule();
  }
  private ready(): boolean {
    try { validServerUrl(this.settings.serverUrl); }
    catch { return false; }
    return !!(this.settings.vaultId && this.token);
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
  private async api(path: string, method = "GET", body?: unknown) {
    const response = await requestUrl({
      url: this.url(path),
      method,
      headers: {
        Authorization: "Bearer " + this.token,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return response.json;
  }
  private async sendOperation(body: object): Promise<OperationResult> {
    return this.api(
      "/vaults/" + encodeURIComponent(this.settings.vaultId) + "/operations",
      "POST", body
    );
  }

  private connectSocket() {
    this.socket?.close();
    if (!this.ready()) return;
    try {
      const base = new URL(validServerUrl(this.settings.serverUrl));
      base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      base.pathname = "/ws";
      base.searchParams.set("vault", this.settings.vaultId);
      const socket = new WebSocket(base.toString());
      this.socket = socket;
      socket.onopen = () => socket.send(JSON.stringify({
        channel: "sync", type: "auth", token: this.token
      }));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.channel !== "sync") return;
          if (message.type === "ready" || message.type === "changed") this.schedule();
          if (message.type === "auth-error") {
            this.showStatus("Authorization failed");
            socket.close();
          }
        } catch { /* Other Ignis websocket messages are not sync data. */ }
      };
      socket.onerror = () => this.showStatus("Offline · local Vault retained");
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
      };
    } catch (error) {
      this.lastError = String(error);
    }
  }

  private openInEditor(path: string): boolean {
    return this.app.workspace.getLeavesOfType("markdown").some((leaf) =>
      (leaf.view as any).file?.path === path);
  }
  private localFiles(): Map<string, TFile> {
    return new Map(this.app.vault.getFiles()
      .filter((file) => isMarkdown(file.path)).map((file) => [file.path, file]));
  }
  private async localHash(file: TFile): Promise<string | null> {
    if (file.stat.size > MAX_TEXT_BYTES) return null;
    const content = await this.app.vault.read(file);
    return sha256(textEncoder.encode(content));
  }
  private async remoteText(remote: RemoteFile): Promise<string> {
    if (remote.size > MAX_TEXT_BYTES) throw new Error("Note exceeds mobile-safe sync limit");
    const response = await requestUrl({
      url: this.url("/vaults/" + encodeURIComponent(this.settings.vaultId) +
        "/files/" + encodeURIComponent(remote.fileId)),
      method: "GET",
      headers: { Authorization: "Bearer " + this.token }
    });
    const bytes = new Uint8Array(response.arrayBuffer);
    if (await sha256(bytes) !== remote.hash) throw new Error("Remote content hash mismatch");
    return new TextDecoder().decode(bytes);
  }
  private async writeLocal(path: string, text: string) {
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
      if (file instanceof TFile) await this.app.vault.modify(file, text);
      else if (file === null) await this.app.vault.create(path, text);
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
      if (pending.type === "delete") delete this.settings.baselines[pending.path];
      else if (pending.toPath) {
        const old = this.settings.baselines[pending.path];
        delete this.settings.baselines[pending.path];
        if (old) this.settings.baselines[pending.toPath] = old;
      }
      this.settings.cursor = Math.max(this.settings.cursor, result.seq);
      this.settings.pending.shift();
      await this.saveData(this.settings);
    }
  }

  async syncNow() {
    if (!this.ready()) return;
    if (this.syncing) { this.queued = true; return; }
    this.syncing = true;
    this.showStatus("Syncing");
    try {
      await this.replayPending();
      const vaultId = encodeURIComponent(this.settings.vaultId);
      const manifest = await this.api("/vaults/" + vaultId + "/manifest") as Manifest;
      const local = this.localFiles();
      const remotePaths = new Set<string>();
      const conflicts: string[] = [];
      for (const remote of manifest.files) {
        if (!isMarkdown(remote.path)) continue;
        remotePaths.add(remote.path);
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
            conflicts.push(remote.path + " (remote move requires review)");
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
          conflicts.push(remote.path + " (replaced generation)");
          continue;
        }
        if (!existing) {
          if (base) { conflicts.push(remote.path + " (local deletion unresolved)"); continue; }
          if (remote.size > MAX_TEXT_BYTES) continue;
          await this.writeLocal(remote.path, await this.remoteText(remote));
          this.saveBase(remote.path, remote);
        } else if (!base) {
          if (localDigest === remote.hash) this.saveBase(remote.path, remote);
          else conflicts.push(remote.path + " (existing on both devices)");
        } else if (localDigest === null) {
          conflicts.push(remote.path + " (size limit)");
        } else if (localDigest === remote.hash) {
          this.saveBase(remote.path, remote);
        } else if (localDigest !== base.hash && remote.hash !== base.hash) {
          conflicts.push(remote.path + " (concurrent edit)");
        } else if (localDigest !== base.hash) {
          if (this.openInEditor(remote.path)) {
            // The native editor may have unsaved changes. CM6/Yjs binding
            // comes in the next phase; do not overwrite the open editor.
            conflicts.push(remote.path + " (open editor, pending Yjs integration)");
            continue;
          }
          const content = await this.app.vault.read(existing);
          const result = await this.sendOperation({
            type: "modify", path: remote.path, content,
            opId: crypto.randomUUID(), fileId: remote.fileId,
            generationId: remote.generationId, baseHash: base.hash
          });
          this.saveBase(remote.path, result);
        } else {
          if (this.openInEditor(remote.path)) {
            conflicts.push(remote.path + " (open editor)");
            continue;
          }
          await this.writeLocal(remote.path, await this.remoteText(remote));
          this.saveBase(remote.path, remote);
        }
        await this.saveData(this.settings);
      }
      for (const [path, file] of local) {
        if (remotePaths.has(path) || this.settings.baselines[path] ||
            this.settings.pending.some((op) => op.toPath === path)) continue;
        const bytes = file.stat.size;
        if (bytes > MAX_TEXT_BYTES || this.openInEditor(path)) continue;
        const content = await this.app.vault.read(file);
        const result = await this.sendOperation({
          type: "create", path, content, opId: crypto.randomUUID()
        });
        this.saveBase(path, result);
        await this.saveData(this.settings);
      }
      // Missing server files are never inferred to be a safe local deletion.
      for (const path of Object.keys(this.settings.baselines)) {
        if (!remotePaths.has(path)) conflicts.push(path + " (remote missing; retained locally)");
      }
      if (conflicts.length) {
        this.lastError = conflicts.slice(0, 4).join("; ");
        this.showStatus(conflicts.length + " items need review");
      } else {
        this.settings.cursor = Math.max(this.settings.cursor, manifest.vaultSeq);
        this.showStatus("Synced · server acknowledged");
      }
      await this.saveData(this.settings);
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
    new Setting(containerEl).setName("Sync access token")
      .setDesc("Stored in Obsidian SecretStorage if available; never in plugin data.json.")
      .addText((t) => t.setPlaceholder("Paste IGNIS_SYNC_TOKEN")
        .onChange(async (value) => {
          if (value.length >= 32) {
            await this.plugin.saveToken(value);
            t.setValue("");
          }
        }));
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
      .setDesc("Markdown-only experimental preview. Local conflicts are never overwritten.")
      .addButton((b) => b.setButtonText("Sync").onClick(() => void this.plugin.syncNow()));
  }
}
