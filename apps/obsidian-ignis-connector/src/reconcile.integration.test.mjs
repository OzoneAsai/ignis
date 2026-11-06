// @vitest-environment jsdom
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
import { createHash } from "node:crypto";

const text = "untouched local text";
const digest = createHash("sha256").update(text).digest("hex");
const baseline = {
  fileId: "file-1", generationId: "generation-1",
  hash: digest, revision: 1
};
const journal = [
  { seq: 1, type: "create", path: "gone.md",
    fileId: baseline.fileId, generationId: baseline.generationId },
  { seq: 2, type: "delete", path: "gone.md",
    fileId: baseline.fileId, generationId: baseline.generationId }
];
function fixture({ optIn = true, localText = text, changes = journal } = {}) {
  const file = new TFile("gone.md", localText.length);
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl: "https://ignis.example", vaultId: "lab",
    scope: "https://ignis.example|lab",
    cursor: 0, baselines: { "gone.md": { ...baseline } },
    pending: [], pendingWrites: [], yjsIds: {},
    applyRemoteDeletes: optIn, archivedScopes: []
  };
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.status = { setText: vi.fn() };
  plugin.live = { isManaged: vi.fn(() => false) };
  plugin.app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      getFiles: () => [file],
      getAbstractFileByPath: (path) => path === file.path ? file : null,
      read: vi.fn(async () => localText),
      trash: vi.fn(async () => {})
    }
  };
  plugin.api = vi.fn(async (url) => {
    if (url.endsWith("/manifest")) {
      return { vaultId: "lab", vaultSeq: 2, files: [] };
    }
    if (url.includes("/changes?")) {
      return { vaultId: "lab", vaultSeq: 2, changes };
    }
    throw new Error("Unexpected URL: " + url);
  });
  plugin.saveData = vi.fn(async () => {});
  return { plugin, file };
}
afterEach(() => vi.restoreAllMocks());

describe("native Vault deletion requires explicit journal proof and opt-in", () => {
  it("moves only an unchanged, explicitly deleted file to recoverable trash", async () => {
    const { plugin, file } = fixture();
    await plugin.syncNow();
    expect(plugin.app.vault.trash).toHaveBeenCalledWith(file, false);
    expect(plugin.settings.baselines).toEqual({});
    expect(plugin.settings.cursor).toBe(2);
  });
  it("keeps a locally modified file when the server deleted its baseline", async () => {
    const { plugin } = fixture({ localText: "new local content" });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.baselines["gone.md"]).toEqual(baseline);
    expect(plugin.settings.cursor).toBe(0);
  });
  it("keeps the local file by default even with a verified tombstone", async () => {
    const { plugin } = fixture({ optIn: false });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(0);
  });
  it("keeps the local file if the journal lacks its deletion", async () => {
    const { plugin } = fixture({ changes: [
      { ...journal[0] }, { ...journal[1], type: "rename", toPath: "other.md" }
    ] });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(0);
  });
});
