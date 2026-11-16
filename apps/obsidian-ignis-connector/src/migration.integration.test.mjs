// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";

vi.mock("obsidian", () => ({
  Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, Setting: class {},
  Notice: class {}, editorInfoField: null, requestUrl: vi.fn(),
  TFile: class TFile {
    constructor(path, size) { this.path = path; this.stat = { size, mtime: 1 }; }
  }
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));

import IgnisConnector from "./main.ts";
import { TFile } from "obsidian";
import { SyncHttpError } from "./operation-replay.ts";

const hash = (content) => createHash("sha256").update(content).digest("hex");
const ORIGINAL = "Project/Shared.md";
const DEVICE = "12345678-1234-1234-1234-123456789abc";
const SOURCE = "# Device branch\n\nPrivate local changes.\n";
const SERVER = "# Server branch\n\nEdited somewhere else.\n";

function fixture({ server = SERVER, source = SOURCE, issue = "Existing on both devices", open = false } = {}) {
  vi.stubGlobal("crypto", webcrypto);
  const content = new Map();
  const files = new Map();
  const serverFiles = [];
  const original = new TFile(ORIGINAL, Buffer.byteLength(source));
  files.set(ORIGINAL, original);
  content.set(ORIGINAL, source);
  let sequence = 1;
  if (server !== null) {
    serverFiles.push({ path: ORIGINAL, hash: hash(server), size: Buffer.byteLength(server),
      fileId: "file-server", generationId: "generation-server", revision: 1 });
  }
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl: "https://ignis.example", vaultId: "lab", deviceId: DEVICE,
    scope: "https://ignis.example|lab", contentScope: "all",
    deviceContentScope: "follow-server", serverMediaBypassExtensions: [],
    deviceMediaBypassExtensions: [], pending: [], pendingWrites: [],
    baselines: {}, yjsIds: {}, archivedScopes: [], migrations: {}, cursor: 0,
    syncIssues: [{ path: ORIGINAL, reason: issue }]
  };
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.syncing = false;
  plugin.live = {
    blockingPaths: vi.fn(() => []), isManaged: vi.fn(() => false),
    retireDocument: vi.fn(async () => {})
  };
  const pane = {
    view: { file: { path: ORIGINAL }, editor: { getValue: () => "# Unsaved native editor draft\n" } }
  };
  plugin.app = {
    workspace: { getLeavesOfType: vi.fn(() => open ? [pane] : []) },
    vault: {
      getAbstractFileByPath: (path) => files.get(path) ?? null,
      getFiles: () => [...files.values()],
      create: vi.fn(async (path, value) => {
        if (files.has(path)) throw new Error("Already exists");
        const file = new TFile(path, Buffer.byteLength(value));
        files.set(path, file); content.set(path, value);
        return file;
      }),
      createBinary: vi.fn(async (path, value) => {
        const file = new TFile(path, value.byteLength);
        files.set(path, file); content.set(path, value);
        return file;
      }),
      read: vi.fn(async (file) => content.get(file.path)),
      readBinary: vi.fn(async (file) => content.get(file.path)),
      modify: vi.fn(async (file, value) => {
        content.set(file.path, value);
        file.stat.size = Buffer.byteLength(value);
      }),
      modifyBinary: vi.fn(async (file, value) => {
        content.set(file.path, value);
        file.stat.size = value.byteLength;
      }),
      createFolder: vi.fn(async () => {})
    }
  };
  plugin.api = vi.fn(async (url) => {
    if (url.endsWith("/manifest")) {
      return { vaultId: "lab", vaultSeq: sequence, files: serverFiles.map(x => ({ ...x })) };
    }
    throw Error("Unexpected URL");
  });
  plugin.deviceRequest = vi.fn(async (url) => {
    if (url.endsWith("/files/file-server")) {
      return { arrayBuffer: new TextEncoder().encode(server).buffer };
    }
    return { status: 404 };
  });
  plugin.sendOperation = vi.fn(async (request) => {
    if (serverFiles.some(f => f.path === request.path)) throw Error("CREATE_CONFLICT");
    const localHash = hash(request.content ?? Buffer.from(request.contentBase64, "base64"));
    const saved = { path: request.path, hash: localHash,
      fileId: "copy-" + (sequence + 1), generationId: "gen-" + (sequence + 1),
      size: Buffer.byteLength(request.content ?? ""), revision: 1 };
    serverFiles.push(saved);
    return { opId: request.opId, type: request.type, path: request.path,
      fileId: saved.fileId, generationId: saved.generationId,
      hash: localHash, seq: ++sequence };
  });
  plugin.saveData = vi.fn(async () => {});
  plugin.schedule = vi.fn();
  return { plugin, original, content, serverFiles, files, pane };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native iPhone/desktop preserve-first document migration", () => {
  it("waits for a running background sync before saving independent version copies", async () => {
    const { plugin, content } = fixture();
    plugin.syncing = true;
    let release;
    plugin.syncDrain = new Promise(resolve => { release = resolve; });
    const work = plugin.preserveMigration(ORIGINAL);
    await Promise.resolve();
    expect(plugin.migrationBusy).toBe(false);
    expect(plugin.settings.migrations[ORIGINAL]).toBeUndefined();
    plugin.syncing = false;
    release();
    const saved = await work;
    expect(saved.sourceCopy).toBeTruthy();
    expect(saved.remoteCopy).toBeTruthy();
    expect(content.get(ORIGINAL)).toBe(SOURCE);
  });
  it("preserves both Connector originals despite a blocked create, then durably retires it before switching", async () => {
    const { plugin, content, serverFiles } = fixture();
    const staged = { opId: "blocked-original-create-123", type: "create",
      path: ORIGINAL, content: SOURCE, localHash: hash(SOURCE) };
    plugin.settings.pendingWrites.push(staged);
    const send = plugin.sendOperation;
    plugin.sendOperation = vi.fn(async request => {
      if (request.opId === staged.opId) throw new SyncHttpError(409, "CREATE_CONFLICT");
      return send(request);
    });
    const api = plugin.api;
    let abandoned = false;
    plugin.api = vi.fn(async (path, method) => {
      if (path.endsWith("/operations/" + staged.opId + "/abandon")) {
        expect(method).toBe("POST");
        abandoned = true;
        return { status: "abandoned", opId: staged.opId };
      }
      return api(path, method);
    });
    const preserved = await plugin.preserveMigration(ORIGINAL);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    expect(content.get(preserved.sourceCopy)).toBe(SOURCE);
    expect(content.get(preserved.remoteCopy)).toBe(SERVER);
    expect(plugin.settings.pendingWrites.map(x => x.opId)).toEqual([staged.opId]);
    await plugin.finishMigration(ORIGINAL);
    expect(abandoned).toBe(true);
    expect(plugin.settings.pendingWrites).toEqual([]);
    expect(content.get(ORIGINAL)).toBe(SERVER);
    expect(serverFiles).toHaveLength(3);
  });

  it("does not switch the local original when a staged operation won the server race", async () => {
    const { plugin, content } = fixture();
    const staged = { opId: "ambiguous-create-123", type: "create",
      path: ORIGINAL, content: SOURCE, localHash: hash(SOURCE) };
    plugin.settings.pendingWrites.push(staged);
    const send = plugin.sendOperation;
    plugin.sendOperation = vi.fn(async request => request.opId === staged.opId ?
      Promise.reject(new SyncHttpError(409, "CREATE_CONFLICT")) : send(request));
    const api = plugin.api;
    plugin.api = vi.fn(async (path, method) => path.endsWith("/abandon") ?
      { status: "committed", opId: staged.opId } : api(path, method));
    const saved = await plugin.preserveMigration(ORIGINAL);
    await expect(plugin.finishMigration(ORIGINAL)).rejects.toThrow(/reached the server/);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    expect(content.get(saved.sourceCopy)).toBe(SOURCE);
    expect(content.get(saved.remoteCopy)).toBe(SERVER);
    expect(plugin.settings.pendingWrites).toHaveLength(1);
  });
  it("saves two differently named versions with server receipts before any original overwrite", async () => {
    const { plugin, original, content, serverFiles } = fixture();
    const result = await plugin.preserveMigration(ORIGINAL);
    expect(result.sourceCopy).not.toBe(ORIGINAL);
    expect(result.remoteCopy).not.toBe(ORIGINAL);
    expect(result.sourceCopy).not.toBe(result.remoteCopy);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    expect(content.get(result.sourceCopy)).toBe(SOURCE);
    expect(content.get(result.remoteCopy)).toBe(SERVER);
    expect(plugin.settings.baselines[result.sourceCopy].hash).toBe(hash(SOURCE));
    expect(plugin.settings.baselines[result.remoteCopy].hash).toBe(hash(SERVER));
    expect(serverFiles).toHaveLength(3);
    expect(plugin.sendOperation).toHaveBeenCalledTimes(2);
    expect(plugin.settings.pendingWrites).toHaveLength(0);
    expect(original.path).toBe(ORIGINAL);
  });

  it("does not create duplicate saved files on repeated migration", async () => {
    const { plugin, files, serverFiles } = fixture();
    const first = await plugin.preserveMigration(ORIGINAL);
    const second = await plugin.preserveMigration(ORIGINAL);
    expect(second).toEqual(first);
    expect(files.size).toBe(3);
    expect(serverFiles).toHaveLength(3);
    expect(plugin.sendOperation).toHaveBeenCalledTimes(2);
  });

  it("re-establishes a deleted server backup without claiming stale copies are saved", async () => {
    const { plugin, content, serverFiles } = fixture();
    const previous = await plugin.preserveMigration(ORIGINAL);
    const remoteCopyIndex = serverFiles.findIndex(x => x.path === previous.remoteCopy);
    serverFiles.splice(remoteCopyIndex, 1);
    const current = await plugin.preserveMigration(ORIGINAL);
    expect(current.remoteCopy).toBe(previous.remoteCopy);
    expect(serverFiles.find(x => x.path === current.remoteCopy)?.hash).toBe(hash(SERVER));
    expect(content.get(current.sourceCopy)).toBe(SOURCE);
    expect(plugin.sendOperation).toHaveBeenCalledTimes(3);
  });

  it("retains both saved files when the original is explicitly migrated", async () => {
    const { plugin, content, files } = fixture();
    const state = await plugin.preserveMigration(ORIGINAL);
    await plugin.finishMigration(ORIGINAL);
    expect(plugin.live.retireDocument).toHaveBeenCalledExactlyOnceWith(ORIGINAL);
    expect(content.get(ORIGINAL)).toBe(SERVER);
    expect(content.get(state.sourceCopy)).toBe(SOURCE);
    expect(content.get(state.remoteCopy)).toBe(SERVER);
    expect(files.size).toBe(3);
    expect(plugin.settings.baselines[ORIGINAL].hash).toBe(hash(SERVER));
    expect(plugin.schedule).toHaveBeenCalledOnce();
  });

  it("never overwrites the original if the old Yjs generation cannot retire",async()=>{
    const {plugin,content}=fixture();
    const record=await plugin.preserveMigration(ORIGINAL);
    plugin.live.retireDocument.mockRejectedValueOnce(new Error("pending collaboration writes"));
    await expect(plugin.finishMigration(ORIGINAL)).rejects.toThrow(/pending collaboration writes/);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    expect(content.get(record.sourceCopy)).toBe(SOURCE);
    expect(content.get(record.remoteCopy)).toBe(SERVER);
  });

  it("preserves independent binary attachments byte-for-byte without text conversion", async () => {
    const { plugin, content, files, serverFiles } = fixture();
    const name = "Media/recording.pdf";
    const localBytes = Uint8Array.from([0, 255, 12, 128, 1]);
    const remoteBytes = Uint8Array.from([15, 0, 66, 200]);
    files.set(name, new TFile(name, localBytes.length));
    content.set(name, localBytes.buffer);
    serverFiles.push({ path: name, hash: hash(remoteBytes), size: remoteBytes.length,
      fileId: "binary-server", generationId: "binary-generation", revision: 1 });
    plugin.settings.syncIssues = [{ path: name, reason: "Existing on both devices" }];
    const originalDeviceRequest = plugin.deviceRequest;
    plugin.deviceRequest = vi.fn(async (url, ...args) => {
      if (url.endsWith("/files/binary-server")) {
        return { arrayBuffer: remoteBytes.buffer };
      }
      return originalDeviceRequest(url, ...args);
    });
    const result = await plugin.preserveMigration(name);
    const actualLocal = new Uint8Array(content.get(result.sourceCopy));
    const actualRemote = new Uint8Array(content.get(result.remoteCopy));
    expect(actualLocal).toEqual(localBytes);
    expect(actualRemote).toEqual(remoteBytes);
    expect(new Uint8Array(content.get(name))).toEqual(localBytes);
    expect(plugin.settings.baselines[result.sourceCopy].hash).toBe(hash(localBytes));
    expect(plugin.settings.baselines[result.remoteCopy].hash).toBe(hash(remoteBytes));
  });

  it("refuses migration when the local source changed after backup", async () => {
    const { plugin, content } = fixture();
    await plugin.preserveMigration(ORIGINAL);
    content.set(ORIGINAL, "new unsaved changes after backup");
    await expect(plugin.finishMigration(ORIGINAL)).rejects.toThrow(/version changed/i);
    expect(content.get(ORIGINAL)).toBe("new unsaved changes after backup");
  });

  it("copies the actual native editor text and refuses to replace an open editor", async () => {
    const { plugin, content } = fixture({ open: true,
      issue: "Live editor blocked; local draft retained" });
    const state = await plugin.preserveMigration(ORIGINAL);
    expect(content.get(state.sourceCopy)).toBe("# Unsaved native editor draft\n");
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    await expect(plugin.finishMigration(ORIGINAL)).rejects.toThrow(/close the original editor/i);
  });

  it("keeps a deleted server original absent but preserves the local version", async () => {
    const { plugin, content } = fixture({ server: null,
      issue: "Remote missing; retained locally" });
    const state = await plugin.preserveMigration(ORIGINAL);
    expect(state.remoteCopy).toBeNull();
    expect(state.remoteHash).toBeNull();
    expect(content.get(state.sourceCopy)).toBe(SOURCE);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
    await expect(plugin.finishMigration(ORIGINAL)).rejects.toThrow(/Save both versions/i);
  });

  it("does not mark a second copy saved if its server write fails", async () => {
    const { plugin, content } = fixture();
    const originalSend = plugin.sendOperation;
    plugin.sendOperation = vi.fn(async (request) => {
      if (request.path.includes("Ignis server")) throw Error("network interrupted");
      return originalSend(request);
    });
    await expect(plugin.preserveMigration(ORIGINAL)).rejects.toThrow(/network interrupted/);
    expect(plugin.settings.migrations[ORIGINAL]).toBeUndefined();
    expect(plugin.settings.pendingWrites).toHaveLength(1);
    expect(content.get(ORIGINAL)).toBe(SOURCE);
  });

  it("defers REST reconciliation while version copies are being committed", async () => {
    const { plugin } = fixture();
    const originalSend = plugin.sendOperation;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    plugin.sendOperation = vi.fn(async request => {
      if (request.path.includes("Ignis device")) await gate;
      return originalSend(request);
    });
    const protecting = plugin.preserveMigration(ORIGINAL);
    for (let attempt = 0; attempt < 20 && !plugin.migrationBusy; attempt++) {
      await Promise.resolve();
    }
    expect(plugin.migrationBusy).toBe(true);
    await plugin.syncNow();
    expect(plugin.queued).toBe(true);
    release();
    await protecting;
    expect(plugin.migrationBusy).toBe(false);
    expect(plugin.queued).toBe(false);
    expect(plugin.schedule).toHaveBeenCalledOnce();
  });
});
