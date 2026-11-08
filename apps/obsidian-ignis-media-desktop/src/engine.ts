import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync, realpathSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { deriveMediaHealth, type MediaHealth } from "./health";
import {
  cleanPeerName, normalizeFolderId, normalizePeerAddress,
  prepareEmptyPilotFolder,
} from "./onboarding";
import {
  encodePairingCard, decodePairingCard, tailscaleIPv4Candidates,
  configuredTcpPorts, type PairingCard,
} from "../../../packages/syncthing-control/src/pairing-card";

export type MobileSettings = {
  executablePath: string;
  homeDir: string;
  guiPort: number;
  autoStart: boolean;
  stopOnUnload: boolean;
};

export type MobileStatus = {
  state: "not-configured" | "stopped" | "running" | "starting" | "unmanaged" | "error";
  deviceId?: string;
  detail?: string;
  managedByPlugin?: boolean;
};

export type MediaOverview = {
  status: MobileStatus;
  health: MediaHealth;
  peers: Array<{
    deviceId: string;
    name: string;
    connected: boolean;
    paused: boolean;
  }>;
  folders: Array<{ id: string; label: string; paused: boolean }>;
};

export function defaultSettings(): MobileSettings {
  const local = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : path.join(os.homedir(), ".local", "share");
  return {
    executablePath: "",
    homeDir: path.join(local, "Ignis", "Syncthing-Mobile"),
    guiPort: 8386,
    autoStart: false,
    stopOnUnload: false,
  };
}

export function validateSettings(settings: MobileSettings): void {
  if (!settings || typeof settings.executablePath !== "string" ||
      typeof settings.homeDir !== "string" ||
      !path.isAbsolute(settings.homeDir) ||
      path.parse(settings.homeDir).root === path.resolve(settings.homeDir)) {
    throw new Error("Syncthing must use a dedicated absolute state directory.");
  }
  if (!Number.isInteger(settings.guiPort) || settings.guiPort < 1024 ||
      settings.guiPort > 65535) {
    throw new Error("GUI port must be between 1024 and 65535.");
  }
  if (settings.executablePath && !path.isAbsolute(settings.executablePath)) {
    throw new Error("Syncthing executable path must be absolute.");
  }
}

export function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function resolveThroughExistingParents(raw: string): string {
  let cursor = path.resolve(raw);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Could not resolve path ancestry");
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(realpathSync.native(cursor), ...missing);
}

export function privateHomeInsideVault(vault: string, home: string): boolean {
  if (pathInside(vault, home)) return true;
  // A symlink/Junction outside the Vault may actually resolve inside it.
  return pathInside(resolveThroughExistingParents(vault),
    resolveThroughExistingParents(home));
}

export function launchArguments(settings: MobileSettings): string[] {
  validateSettings(settings);
  return [
    "serve",
    `--home=${path.resolve(settings.homeDir)}`,
    `--gui-address=127.0.0.1:${settings.guiPort}`,
    "--no-browser",
    "--no-restart",
    "--no-upgrade",
  ];
}

function enrolledPath(homeDir: string): string {
  return path.join(homeDir, "ignis-mobile-instance.json");
}

type Enrollment = { deviceId: string; homeDir: string };

async function readEnrollment(homeDir: string): Promise<Enrollment | null> {
  try {
    const stat = await fs.lstat(enrolledPath(homeDir));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error("Local Syncthing enrollment file must be a regular small file.");
    }
    const value = JSON.parse(await fs.readFile(enrolledPath(homeDir), "utf8"));
    if (typeof value.deviceId === "string" && value.homeDir === path.resolve(homeDir)) {
      return value;
    }
    throw new Error("Local instance enrollment does not match this directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function apiKey(homeDir: string): Promise<string> {
  // The token stays outside the Vault, never enters Plugin.loadData()/settings.
  const filename = path.join(homeDir, "config.xml");
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new Error("Syncthing config must be a regular file inside its private home.");
  }
  const xml = await fs.readFile(filename, "utf8");
  const key = xml.match(/<apikey>\s*([^<\s]+)\s*<\/apikey>/i)?.[1];
  if (!key || key.length < 16) throw new Error("Syncthing local API key is unavailable.");
  return key;
}

async function localRequest(port: number, method: "GET" | "POST",
  endpoint: string, key: string,
  body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1", port, path: endpoint, method,
      headers: {
        "X-API-Key": key,
        ...(payload !== null ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        } : {}),
      }, timeout: 2500,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("Syncthing API response interrupted.")));
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          response.destroy(new Error("Syncthing API response exceeds the safe limit."));
        } else {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`Syncthing refused control (HTTP ${response.statusCode}).`));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve(text ? JSON.parse(text) : {}); }
        catch { reject(new Error("Syncthing returned an invalid API response.")); }
      });
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("Syncthing API timed out.")));
    request.end(payload === null ? undefined : payload);
  });
}

async function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(900);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A closed GUI port is not the same as an exited daemon: the listening socket
// may be released before Syncthing relinquishes its database locks.
async function portQuiet(port: number, quietMs = 1250, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    if (await portOccupied(port)) {
      quietSince = null;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    }
    await delay(250);
  }
  return false;
}

export class MobileSyncthingController {
  private settings: MobileSettings;
  private ownedProcess: ChildProcess | null = null;
  private state: MobileStatus = { state: "stopped" };
  private startPromise: Promise<MobileStatus> | null = null;
  private overviewPromise: Promise<MediaOverview> | null = null;
  private disposed = false;

  constructor(settings: MobileSettings) {
    validateSettings(settings);
    this.settings = { ...settings };
  }

  configure(next: MobileSettings): void {
    if (this.disposed) throw new Error("Syncthing controller has been disposed.");
    validateSettings(next);
    if ((this.ownedProcess || this.startPromise || this.state.state === "running") &&
        (next.homeDir !== this.settings.homeDir ||
         next.executablePath !== this.settings.executablePath ||
         next.guiPort !== this.settings.guiPort)) {
      throw new Error("Stop or disconnect the managed service before changing its identity or port.");
    }
    this.settings = { ...next };
  }

  getStatus(): MobileStatus {
    return { ...this.state };
  }

  private async verifiedApi(allowEnroll: boolean): Promise<{
    key: string; status: Record<string, unknown>;
  }> {
    const key = await apiKey(this.settings.homeDir);
    const [status, paths] = await Promise.all([
      localRequest(this.settings.guiPort, "GET", "/rest/system/status", key),
      localRequest(this.settings.guiPort, "GET", "/rest/system/paths", key),
    ]);
    const expected = path.resolve(this.settings.homeDir);
    const rawConfig = paths["baseDir-config"];
    const rawData = paths["baseDir-data"];
    if (typeof rawConfig !== "string" || typeof rawData !== "string" ||
        path.resolve(rawConfig) !== expected || path.resolve(rawData) !== expected) {
      throw new Error("A different Syncthing instance owns this local API port.");
    }
    const id = status.myID;
    if (typeof id !== "string" || !/^[A-Z2-7-]{32,128}$/.test(id)) {
      throw new Error("Syncthing did not report a valid local device ID.");
    }
    const enrollment = await readEnrollment(this.settings.homeDir);
    if (!enrollment) {
      if (!allowEnroll || !this.ownedProcess) {
        throw new Error("Local instance is not enrolled; refusing to adopt it.");
      }
      await fs.writeFile(enrolledPath(this.settings.homeDir),
        JSON.stringify({ deviceId: id, homeDir: expected }), {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
    } else if (enrollment.deviceId !== id) {
      throw new Error("Syncthing device identity changed; refusing to control it.");
    }
    return { key, status };
  }

  async refresh(): Promise<MobileStatus> {
    try {
      const { status } = await this.verifiedApi(false);
      this.state = {
        state: "running", deviceId: String(status.myID),
        managedByPlugin: this.ownedProcess !== null,
      };
    } catch (error) {
      const occupied = await portOccupied(this.settings.guiPort);
      if (occupied) {
        this.state = {
          state: "unmanaged",
          detail: error instanceof Error ? error.message : "Local instance not verified",
        };
      } else {
        this.state = {
          state: this.settings.executablePath ? "stopped" : "not-configured",
          detail: this.settings.executablePath ? undefined : "Syncthing executable not configured",
        };
      }
    }
    return this.getStatus();
  }

  overview(): Promise<MediaOverview> {
    if (this.overviewPromise) return this.overviewPromise;
    const work = this.readOverview();
    const tracked = work.finally(() => {
      if (this.overviewPromise === tracked) this.overviewPromise = null;
    });
    this.overviewPromise = tracked;
    return tracked;
  }

  private async readOverview(): Promise<MediaOverview> {
    const status = await this.refresh();
    const checkedAt = Date.now();
    if (status.state !== "running") {
      return {
        status,
        health: deriveMediaHealth({ state: status.state, checkedAt, detail: status.detail }),
        peers: [],
        folders: [],
      };
    }
    try {
      // Re-attest before inspecting configuration or claiming data completion.
      const { key } = await this.verifiedApi(false);
      const [config, connections, completion] = await Promise.all([
        localRequest(this.settings.guiPort, "GET", "/rest/config", key),
        localRequest(this.settings.guiPort, "GET", "/rest/system/connections", key),
        localRequest(this.settings.guiPort, "GET", "/rest/db/completion", key),
      ]);
      const configDevices = Array.isArray(config.devices) ? config.devices : [];
      const configFolders = Array.isArray(config.folders) ? config.folders : [];
      const connectionMap = connections.connections &&
        typeof connections.connections === "object" && !Array.isArray(connections.connections)
        ? connections.connections as Record<string, Record<string, unknown>> : {};
      const sharedFolders = configFolders
        .filter((folder): folder is Record<string, unknown> =>
          !!folder && typeof folder === "object" && !Array.isArray(folder))
        .map((folder) => ({
          id: typeof folder.id === "string" ? folder.id : "",
          label: typeof folder.label === "string" && folder.label.trim()
            ? folder.label : String(folder.id || "未命名"),
          paused: folder.paused === true,
          devices: Array.isArray(folder.devices)
            ? folder.devices.map((device: unknown) => {
                if (!device || typeof device !== "object") return null;
                const id = (device as Record<string, unknown>).deviceID;
                return typeof id === "string" ? id : null;
              }).filter((id: string | null): id is string => !!id)
            : [],
        }));
      const folderPeers = new Set(sharedFolders.flatMap((folder) =>
        folder.devices.filter((id) => id !== status.deviceId)));
      const registeredPeers = configDevices.filter((device): device is Record<string, unknown> =>
        !!device && typeof device === "object" && !Array.isArray(device) &&
        typeof device.deviceID === "string" && device.deviceID !== status.deviceId
      ).map((device) => ({
        id: String(device.deviceID),
        name: typeof device.name === "string" && device.name.trim()
          ? device.name : "名前未設定",
        paused: device.paused === true,
        connected: connectionMap[String(device.deviceID)]?.connected === true,
      }));
      // A newly registered Mac is not yet associated with any shared folder.
      // The onboarding UI must still offer it as a folder-sharing candidate.
      const peers = registeredPeers.filter((peer) => folderPeers.has(peer.id));
      const folders = sharedFolders.map((folder) => ({ paused: folder.paused }));
      // A local "100%" can still mean the other PC has not downloaded files.
      // Require *per-shared-folder* remote completion and remoteState=valid;
      // aggregated completion cannot tell whether the peer accepted a folder.
      let remoteNeedBytes: number | null = 0;
      const remoteChecks = peers.filter((peer) => peer.connected)
        .flatMap((peer) => sharedFolders
          .filter((folder) => folder.devices.includes(peer.id))
          .map((folder) => ({ deviceId: peer.id, folderId: folder.id })));
      let remoteVerified = peers.length > 0 && folderPeers.size === peers.length &&
        remoteChecks.length > 0 && remoteChecks.length <= 24;
      if (!remoteVerified) remoteNeedBytes = null;
      if (remoteVerified) {
        await Promise.all(remoteChecks.map(async (peerFolder) => {
          try {
            const remote = await localRequest(this.settings.guiPort, "GET",
              "/rest/db/completion?device=" + encodeURIComponent(peerFolder.deviceId) +
              "&folder=" + encodeURIComponent(peerFolder.folderId), key);
            const count = remote.needBytes;
            if (remote.remoteState !== "valid" ||
                typeof count !== "number" || !Number.isFinite(count) || count < 0) {
              remoteVerified = false;
            } else if (remoteNeedBytes !== null) {
              remoteNeedBytes += count;
            }
          } catch {
            remoteVerified = false;
          }
        }));
      }
      return {
        status,
        peers: registeredPeers.map((peer) => ({
          deviceId: peer.id,
          name: peer.name,
          connected: peer.connected,
          paused: peer.paused,
        })),
        folders: sharedFolders.map((folder) => ({
          id: folder.id, label: folder.label, paused: folder.paused,
        })),
        health: deriveMediaHealth({
          state: status.state, checkedAt,
          peers, folders,
          completion: typeof completion.completion === "number" ? completion.completion : null,
          needBytes: typeof completion.needBytes === "number" ? completion.needBytes : null,
          remoteNeedBytes,
          remoteVerified,
        }),
      };
    } catch {
      return {
        status,
        peers: [],
        folders: [],
        health: deriveMediaHealth({
          state: "degraded", checkedAt,
        }),
      };
    }
  }

  async registerPeer(input: {
    deviceId: string;
    name: string;
    address: string;
  }): Promise<{ deviceId: string; alreadyPresent: boolean }> {
    if (this.disposed) throw new Error("Controller is unloaded.");
    const supplied = input.deviceId.replace(/\s/g, "").toUpperCase();
    if (supplied.length > 128 || !/^[A-Z2-7-]+$/.test(supplied)) {
      throw new Error("Device IDの形式が正しくありません。");
    }
    const name = cleanPeerName(input.name);
    const address = normalizePeerAddress(input.address);
    const { key, status } = await this.verifiedApi(false);
    const canonical = await localRequest(this.settings.guiPort, "GET",
      "/rest/svc/deviceid?id=" + encodeURIComponent(supplied), key);
    const deviceId = canonical.id;
    if (typeof deviceId !== "string" || !/^[A-Z2-7-]{63}$/.test(deviceId)) {
      throw new Error("相手のDevice IDが検証できません。コピーし直してください。");
    }
    if (deviceId === status.myID) {
      throw new Error("このPC自身のDevice IDは接続先に登録できません。");
    }
    const config = await localRequest(this.settings.guiPort, "GET", "/rest/config", key);
    const devices = Array.isArray(config.devices) ? config.devices : [];
    if (devices.some((device) => device && typeof device === "object" &&
      device.deviceID === deviceId)) {
      return { deviceId, alreadyPresent: true };
    }
    const template = await localRequest(this.settings.guiPort, "GET",
      "/rest/config/defaults/device", key);
    await localRequest(this.settings.guiPort, "POST", "/rest/config/devices", key, {
      ...template,
      deviceID: deviceId,
      name,
      addresses: [address],
      autoAcceptFolders: false,
      introducer: false,
      paused: false,
    });
    return { deviceId, alreadyPresent: false };
  }

  async makeLocalPairingCard({
    name = os.hostname(),
    address,
    folderId = "ignis-media-pilot",
  }: { name?: string; address?: string; folderId?: string } = {}): Promise<string> {
    const { status, key } = await this.verifiedApi(false);
    const config = await localRequest(this.settings.guiPort, "GET", "/rest/config", key);
    const networkAddress = address?.trim();
    let endpoint: string;
    if (networkAddress) {
      endpoint = normalizePeerAddress(networkAddress);
    } else {
      const candidates = tailscaleIPv4Candidates(os.networkInterfaces());
      const ports = configuredTcpPorts(config);
      if (candidates.length !== 1 || ports.length !== 1) {
        throw new Error(
          "TailnetのIPまたはSyncthingのTCPポートを一意に確認できません。アドレスを入力してください。"
        );
      }
      endpoint = normalizePeerAddress(`tcp://${candidates[0]}:${ports[0]}`);
    }
    return encodePairingCard({
      deviceId: String(status.myID),
      name: cleanPeerName(name),
      address: endpoint,
      folderId: normalizeFolderId(folderId),
    });
  }

  previewPairingCard(card: string): PairingCard {
    const parsed = decodePairingCard(card);
    normalizePeerAddress(parsed.address);
    normalizeFolderId(parsed.folderId);
    return parsed;
  }

  async importPairingCard(card: string): Promise<{
    peer: PairingCard;
    alreadyPresent: boolean;
  }> {
    const parsed = this.previewPairingCard(card);
    const result = await this.registerPeer({
      deviceId: parsed.deviceId, name: parsed.name, address: parsed.address,
    });
    return { peer: parsed, alreadyPresent: result.alreadyPresent };
  }

  async createPilotShare(input: {
    folderId: string;
    folderPath: string;
    peerDeviceId: string;
    vaultPath: string;
  }): Promise<{ id: string; path: string }> {
    if (this.disposed) throw new Error("Controller is unloaded.");
    const folderId = normalizeFolderId(input.folderId);
    if (!path.isAbsolute(input.vaultPath) || !path.isAbsolute(input.folderPath)) {
      throw new Error("検証フォルダとVaultは絶対パスで指定してください。");
    }
    const resolved = path.resolve(input.folderPath);
    if (privateHomeInsideVault(input.vaultPath, resolved) ||
        privateHomeInsideVault(this.settings.homeDir, resolved) ||
        privateHomeInsideVault(resolved, this.settings.homeDir)) {
      throw new Error("検証フォルダはVault・Syncthing内部データの外に作成してください。");
    }
    const { key, status } = await this.verifiedApi(false);
    const config = await localRequest(this.settings.guiPort, "GET", "/rest/config", key);
    const deviceId = input.peerDeviceId.trim();
    const devices = Array.isArray(config.devices) ? config.devices : [];
    if (deviceId === status.myID || !devices.some((device) =>
      device && typeof device === "object" && device.deviceID === deviceId)) {
      throw new Error("先にMac側のDevice IDを登録してください。");
    }
    const folders = Array.isArray(config.folders) ? config.folders : [];
    if (folders.some((folder) => folder && typeof folder === "object" &&
      folder.id === folderId)) {
      throw new Error("同じ共有IDのフォルダが既にあります。既存設定は変更しません。");
    }
    await prepareEmptyPilotFolder(resolved);
    // Syncthing will replicate files to any invited peer. Only an empty,
    // dedicated pilot directory can be enrolled through this shortcut.
    if ((await fs.readdir(resolved)).length !== 0 ||
        !(await fs.lstat(resolved)).isDirectory()) {
      throw new Error("検証フォルダが変更されたため共有を取りやめました。");
    }
    const template = await localRequest(this.settings.guiPort, "GET",
      "/rest/config/defaults/folder", key);
    await localRequest(this.settings.guiPort, "POST", "/rest/config/folders", key, {
      ...template,
      id: folderId,
      label: "IGNIS Media Pilot",
      path: resolved,
      type: "sendreceive",
      devices: [{ deviceID: String(status.myID) }, { deviceID: deviceId }],
      paused: false,
    });
    return { id: folderId, path: resolved };
  }

  start(): Promise<MobileStatus> {
    if (this.disposed) return Promise.reject(new Error("Syncthing controller has been disposed."));
    if (this.startPromise) return this.startPromise;
    const action = this.startImpl();
    this.startPromise = action.finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async startImpl(): Promise<MobileStatus> {
    if (this.ownedProcess) {
      return this.refresh();
    }
    if (await portOccupied(this.settings.guiPort)) {
      // Existing managed processes can survive Obsidian restarts. Only rejoin
      // after matching both the private home path and enrolled device ID.
      const result = await this.refresh();
      if (result.state !== "running") {
        throw new Error(result.detail || "An unrelated process uses the GUI port.");
      }
      return result;
    }
    if (!this.settings.executablePath) {
      throw new Error("Set an absolute Syncthing executable path first.");
    }
    const stat = await fs.lstat(this.settings.executablePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Syncthing executable must be a regular file.");
    }
    await fs.mkdir(this.settings.homeDir, { recursive: true, mode: 0o700 });

    // A stopped service can briefly retain its database lock after the GUI
    // closes. Model the desired running state with bounded attempts rather
    // than treating every early child exit as a different, permanent error.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.disposed) throw new Error("Syncthing controller was unloaded during startup.");
      if (attempt > 0) {
        await delay(500 * attempt);
        if (await portOccupied(this.settings.guiPort)) {
          const existing = await this.refresh();
          if (existing.state === "running") return existing;
          throw new Error(existing.detail || "Unidentified Syncthing instance owns the GUI port.");
        }
      }
      try {
        return await this.startManagedProcess();
      } catch (error) {
        if (error instanceof Error &&
            (error.message.includes("different Syncthing") ||
             error.message.includes("identity changed"))) throw error;
        if (attempt === 2) throw error;
      }
    }
    throw new Error("Syncthing startup failed after bounded attempts.");
  }

  private async startManagedProcess(): Promise<MobileStatus> {
    this.state = { state: "starting" };
    const child = spawn(this.settings.executablePath,
      launchArguments(this.settings), {
        cwd: this.settings.homeDir,
        shell: false, windowsHide: true, detached: true,
        stdio: "ignore",
      });
    child.on("error", () => {
      if (this.ownedProcess === child) {
        this.ownedProcess = null;
        this.state = { state: "error", detail: "Syncthing process failed." };
      }
    });
    child.on("exit", () => {
      if (this.ownedProcess === child) {
        this.ownedProcess = null;
        this.state = { state: "stopped" };
      }
    });
    this.ownedProcess = child;
    try {
      for (let attempt = 0; attempt < 28; attempt += 1) {
        if (this.ownedProcess !== child) throw new Error("Syncthing exited before becoming ready.");
        try {
          const { status } = await this.verifiedApi(true);
          this.state = { state: "running", deviceId: String(status.myID), managedByPlugin: true };
          return this.getStatus();
        } catch (error) {
          if (error instanceof Error &&
              (error.message.includes("different Syncthing") ||
               error.message.includes("identity changed"))) throw error;
        }
        await delay(400);
      }
      throw new Error("Syncthing did not become ready. Inspect its local logs.");
    } catch (error) {
      if (this.ownedProcess === child) {
        child.kill();
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          delay(1500),
        ]);
      }
      throw error;
    }
  }

  async pause(): Promise<void> {
    const { key } = await this.verifiedApi(false);
    await localRequest(this.settings.guiPort, "POST", "/rest/system/pause", key);
  }

  async resume(): Promise<void> {
    const { key } = await this.verifiedApi(false);
    await localRequest(this.settings.guiPort, "POST", "/rest/system/resume", key);
  }

  async stop(): Promise<void> {
    // A failed identity check must NEVER turn into a blind PID kill. On
    // Windows Syncthing can launch a monitor and a separate service process.
    const { key } = await this.verifiedApi(false);
    let acknowledgmentError: unknown;
    try {
      await localRequest(this.settings.guiPort, "POST", "/rest/system/shutdown", key);
    } catch (error) {
      // The daemon may close the socket while shutting down, before sending
      // an HTTP response. Verify the resulting state instead of guessing.
      acknowledgmentError = error;
    }
    if (await portQuiet(this.settings.guiPort)) {
      this.state = { state: "stopped" };
      return;
    }
    if (acknowledgmentError) throw acknowledgmentError;
    throw new Error("Syncthing shutdown was requested, but the process is still responding.");
  }

  async unload(): Promise<void> {
    this.disposed = true;
    try {
      if (this.startPromise) await this.startPromise.catch(() => {});
      if (this.settings.stopOnUnload && this.ownedProcess) await this.stop();
    } finally {
      this.ownedProcess?.unref();
      this.ownedProcess = null;
    }
  }
}
