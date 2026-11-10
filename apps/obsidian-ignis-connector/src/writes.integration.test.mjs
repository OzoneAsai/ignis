import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  Setting: class {},
  Notice: class {},
  TFile: class TFile {
    constructor(path, size) {
      this.path = path;
      this.stat = { size };
    }
  },
  editorInfoField: null,
  requestUrl: vi.fn()
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));
import IgnisConnector from "./main.ts";
import { TFile } from "obsidian";
import { SyncHttpError } from "./operation-replay.ts";

const DIGEST = "a".repeat(64);
function fixture(content = "first version") {
  const file = new TFile("draft.md", content.length);
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl: "https://ignis.example", vaultId: "lab",
    scope: "https://ignis.example|lab",
    pending: [], pendingWrites: [], baselines: {},
    yjsIds: {}, archivedScopes: [], cursor: 0
  };
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.app = { vault: {
    getAbstractFileByPath: vi.fn(() => file),
    read: vi.fn(() => Promise.resolve(content))
  }};
  plugin.saveData = vi.fn(async () => {});
  plugin.deviceRequest = vi.fn(async () => ({ status: 404 }));
  plugin.sendOperation = vi.fn(async (request) => ({
    opId: request.opId, type: request.type, path: request.path,
    fileId: "file-1", generationId: "generation-1",
    hash: await plugin.localHash(file), seq: 1
  }));
  return { plugin, file };
}
afterEach(() => vi.restoreAllMocks());

describe("outbound operation crash recovery", () => {
  it("does not block an unrelated draft when another Connector won a create race", async () => {
    const { plugin } = fixture();
    const stuck = { opId: "blocked-create-123", type: "create", path: "collision.md",
      content: "local original", localHash: "a".repeat(64) };
    const safe = { opId: "safe-create-123", type: "create", path: "other.md",
      content: "unrelated draft", localHash: "b".repeat(64) };
    plugin.settings.pendingWrites = [stuck, safe];
    plugin.app.vault.getAbstractFileByPath = vi.fn(path => new TFile(path, 16));
    plugin.localHash = vi.fn(async file => file.path === stuck.path ? stuck.localHash : safe.localHash);
    plugin.sendOperation = vi.fn(async operation => {
      if (operation.opId === stuck.opId) throw new SyncHttpError(409, "CREATE_CONFLICT");
      return { opId: operation.opId, type: operation.type, path: operation.path,
        fileId: "safe-file", generationId: "safe-generation", hash: safe.localHash, seq: 8 };
    });
    await plugin.replayWrites();
    expect(plugin.sendOperation).toHaveBeenCalledTimes(2);
    expect(plugin.settings.pendingWrites.map(x => x.opId)).toEqual([stuck.opId]);
    expect(plugin.settings.baselines["other.md"].fileId).toBe("safe-file");
    expect(plugin.settings.baselines["collision.md"]).toBeUndefined();
    const rendered = [];
    plugin.migrationModal = { refresh: items => rendered.push(items) };
    plugin.openSyncIssues();
    expect(rendered[0].find(item => item.path === "collision.md").reason)
      .toContain("server conflict: CREATE_CONFLICT");
  });
  it("persists exact bytes and opId before sending the first request", async () => {
    const { plugin, file } = fixture();
    plugin.sendOperation.mockImplementation(async (request) => {
      expect(plugin.saveData).toHaveBeenCalled();
      expect(plugin.settings.pendingWrites).toHaveLength(1);
      expect(plugin.settings.pendingWrites[0].opId).toBe(request.opId);
      expect(plugin.settings.pendingWrites[0].content).toBe("first version");
      return {
        opId: request.opId, type: request.type, path: request.path,
        fileId: "file-1", generationId: "generation-1",
        hash: plugin.settings.pendingWrites[0].localHash, seq: 1
      };
    });
    await plugin.stageAndSend("create", file);
    expect(plugin.settings.pendingWrites).toEqual([]);
    expect(plugin.settings.baselines["draft.md"].fileId).toBe("file-1");
    expect(plugin.saveData).toHaveBeenCalledTimes(2);
  });

  it("recovers an acknowledged request without retransmitting changed local text", async () => {
    const { plugin, file } = fixture("second version");
    const staged = {
      opId: "lost-ack-123", type: "create", path: "draft.md",
      content: "first version", localHash: DIGEST
    };
    plugin.settings.pendingWrites.push(staged);
    plugin.deviceRequest.mockResolvedValue({ status: 200, json: {
      opId: staged.opId, type: "create", path: staged.path,
      fileId: "file-1", generationId: "generation-1",
      hash: DIGEST, seq: 4
    } });
    await plugin.replayWrites();
    expect(plugin.sendOperation).not.toHaveBeenCalled();
    expect(plugin.settings.pendingWrites).toEqual([]);
    expect(plugin.settings.cursor).toBe(0);
    expect(plugin.settings.baselines["draft.md"].hash).toBe(DIGEST);
    expect(file.path).toBe("draft.md");
  });

  it("does not replay stale staged content after local text changes", async () => {
    const { plugin } = fixture("changed since staging");
    plugin.api = vi.fn(async() => {
      throw new Error("Durable abandonment unavailable");
    });
    plugin.settings.pendingWrites.push({
      opId: "lost-ack-123", type: "create", path: "draft.md",
      content: "first version", localHash: DIGEST
    });
    await expect(plugin.replayWrites()).rejects.toThrow(/Durable abandonment unavailable/);
    expect(plugin.sendOperation).not.toHaveBeenCalled();
    expect(plugin.settings.pendingWrites).toHaveLength(1);
  });
});
