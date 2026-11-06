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
    plugin.settings.pendingWrites.push({
      opId: "lost-ack-123", type: "create", path: "draft.md",
      content: "first version", localHash: DIGEST
    });
    await expect(plugin.replayWrites()).rejects.toThrow(/review before replay/);
    expect(plugin.sendOperation).not.toHaveBeenCalled();
    expect(plugin.settings.pendingWrites).toHaveLength(1);
  });
});
