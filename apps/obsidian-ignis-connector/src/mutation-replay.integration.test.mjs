import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  Plugin: class {}, PluginSettingTab: class {}, Modal: class {},
  Setting: class {}, Notice: class {}, TFile: class {},
  editorInfoField: null, requestUrl: vi.fn()
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));
import IgnisConnector from "./main.ts";
import { SyncHttpError } from "./operation-replay.ts";
import { queueRename } from "./pending.ts";

const file = id => ({ fileId: id, generationId: id + "-generation",
  hash: id + "-digest", revision: 1 });

describe("two-Connector independent mutation replay", () => {
  it("keeps a blocked identity chain intact while committing another file", async () => {
    const plugin = new IgnisConnector();
    plugin.settings = { scope: "https://example.invalid|shared",
      baselines: { "A.md": file("first"), "X.md": file("second") },
      pending: [], pendingWrites: [] };
    queueRename(plugin.settings, "A.md", "B.md", "first-move");
    queueRename(plugin.settings, "B.md", "C.md", "second-move");
    queueRename(plugin.settings, "X.md", "Y.md", "unrelated-move");
    plugin.canShare = () => true;
    plugin.persistSettings = vi.fn(async () => {});
    plugin.live = { rejoinPath: vi.fn() };
    plugin.sendOperation = vi.fn(async op => {
      if (op.opId === "first-move") {
        throw new SyncHttpError(409, "BASE_MISMATCH");
      }
      return { opId: op.opId, type: op.type, path: op.path,
        toPath: op.toPath, fileId: op.fileId,
        generationId: op.generationId,
        hash: op.baseHash, seq: 14 };
    });
    await plugin.replayPending();
    expect(plugin.sendOperation.mock.calls.map(([op]) => op.opId))
      .toEqual(["first-move", "unrelated-move"]);
    expect(plugin.settings.pending.map(op => op.opId))
      .toEqual(["first-move", "second-move"]);
    expect(plugin.settings.baselines["A.md"]).toEqual(file("first"));
    expect(plugin.settings.baselines["Y.md"].fileId).toBe("second");
    expect(plugin.settings.baselines["X.md"]).toBeUndefined();
  });
  it("keeps fail-closed behavior for an opId reuse or unknown server failure", async () => {
    const plugin = new IgnisConnector();
    plugin.settings = { scope: "https://example.invalid|shared",
      baselines: { "A.md": file("first") }, pending: [], pendingWrites: [] };
    queueRename(plugin.settings, "A.md", "B.md", "broken-id");
    plugin.canShare = () => true;
    plugin.sendOperation = vi.fn(async () => {
      throw new SyncHttpError(409, "OP_ID_REUSED");
    });
    await expect(plugin.replayPending()).rejects.toThrow(/OP_ID_REUSED/);
    expect(plugin.settings.pending).toHaveLength(1);
    expect(plugin.settings.baselines["A.md"]).toEqual(file("first"));
  });
});
