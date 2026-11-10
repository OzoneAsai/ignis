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
const JOURNAL_ID = "00000000-0000-4000-8000-000000000033";

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
    journalLineage: JOURNAL_ID,
    cursor: 0, baselines: { "gone.md": { ...baseline } },
    pending: [], pendingWrites: [], yjsIds: {},
    applyRemoteDeletes: optIn, archivedScopes: []
  };
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.status = { setText: vi.fn() };
  plugin.live = {
    blockingPaths: vi.fn(() => []),
    isManaged: vi.fn(() => false),
    saveState: vi.fn(() => ({
      online: true, active: 0, awaitingServer: 0,
      reconnecting: 0, blocked: 0
    }))
  };
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
      return { vaultId: "lab", vaultSeq: 2, journalLineage: JOURNAL_ID, files: [] };
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
  it("never claims a two-site Vault is synced while an outbound operation remains", async () => {
    const { plugin } = fixture();
    plugin.settings.pendingWrites = [{ opId: "blocked-create-123", type: "create",
      path: "Collision.md", content: "draft", localHash: "a".repeat(64) }];
    plugin.replayWrites = vi.fn(async () => {});
    await plugin.syncNow();
    expect(plugin.settings.pendingWrites).toHaveLength(1);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: 1 item needs review · 1 unsent change"
    );
    expect(plugin.status.setText).not.toHaveBeenCalledWith(
      "Ignis: Synced · server acknowledged"
    );
  });
  it("abandons a refused duplicate CREATE only after both sites have identical bytes", async () => {
    const { plugin } = fixture({ optIn: false });
    plugin.settings.baselines = {};
    plugin.settings.cursor = 0;
    const staged = { opId: "duplicate-create-123", type: "create", path: "gone.md",
      content: text, localHash: digest };
    plugin.settings.pendingWrites = [staged];
    plugin.replayWrites = vi.fn(async () => {});
    const server = { path: "gone.md", ...baseline, size: Buffer.byteLength(text) };
    const durable = [];
    plugin.api = vi.fn(async (path, method) => {
      if (path.endsWith("/manifest")) return { vaultId: "lab", vaultSeq: 0,
        journalLineage: JOURNAL_ID,
        files: [server] };
      if (path.endsWith("/abandon")) {
        expect(plugin.settings.pendingWrites).toHaveLength(1);
        expect(method).toBe("POST");
        durable.push(staged.opId);
        return { status: "abandoned", opId: staged.opId };
      }
      throw Error("Unexpected path: " + path);
    });
    await plugin.syncNow();
    expect(durable).toEqual([staged.opId]);
    expect(plugin.settings.pendingWrites).toEqual([]);
    expect(plugin.settings.baselines["gone.md"].fileId).toBe(baseline.fileId);
    expect(plugin.status.setText)
      .toHaveBeenCalledWith("Ignis: Synced · server acknowledged");
  });
  it("reports a blocked native editor beside file-journal conflicts without discarding either", async () => {
    const { plugin } = fixture({ optIn: false });
    plugin.live.blockingPaths = () => ["opened-unrelated.md"];
    await plugin.syncNow();
    expect(plugin.settings.syncIssues).toEqual([
      { path: "gone.md", reason: "Remote missing; retained locally" },
      { path: "opened-unrelated.md", reason: "Live editor blocked; local draft retained" }
    ]);
    expect(plugin.status.setText).toHaveBeenCalledWith("Ignis: 2 items need review");
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.settings.tombstoneProofs["gone.md"].seq).toBe(2);
  });
  it("moves only an unchanged, explicitly deleted file to recoverable trash", async () => {
    const { plugin, file } = fixture();
    await plugin.syncNow();
    expect(plugin.app.vault.trash).toHaveBeenCalledWith(file, false);
    expect(plugin.settings.baselines).toEqual({});
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.status.setText)
      .toHaveBeenCalledWith("Ignis: Synced · server acknowledged");
  });
  it("does not label file-journal success a complete sync while Yjs is unacknowledged", async () => {
    const { plugin } = fixture();
    plugin.live.saveState = () => ({
      online: true, active: 1, awaitingServer: 1,
      reconnecting: 0, blocked: 0
    });
    await plugin.syncNow();
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Files synced · 1 collaborative notes await server save");
  });
  it("reports the live collaboration plane offline even when REST files synced", async () => {
    const { plugin } = fixture();
    plugin.live.saveState = () => ({
      online: false, active: 1, awaitingServer: 0,
      reconnecting: 1, blocked: 0
    });
    await plugin.syncNow();
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Files synced · live collaboration offline");
  });
  it("keeps a locally modified file when the server deleted its baseline", async () => {
    const { plugin } = fixture({ localText: "new local content" });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.baselines["gone.md"]).toEqual(baseline);
    expect(plugin.settings.cursor).toBe(2);
  });
  it("keeps the local file by default even with a verified tombstone", async () => {
    const { plugin } = fixture({ optIn: false });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(2);
  });
  it("keeps the local file if the journal lacks its deletion", async () => {
    const { plugin } = fixture({ changes: [
      { ...journal[0] }, { ...journal[1], type: "rename", toPath: "other.md" }
    ] });
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(2);
  });
  it("retains a durable deletion proof after cursor advance and applies opt-in later", async () => {
    const { plugin, file } = fixture({ optIn: false });
    await plugin.syncNow();
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.settings.tombstoneProofs["gone.md"]).toEqual({
      seq: 2, fileId: baseline.fileId, generationId: baseline.generationId
    });
    plugin.settings.applyRemoteDeletes = true;
    await plugin.syncNow();
    expect(plugin.app.vault.trash).toHaveBeenCalledWith(file, false);
    expect(plugin.settings.baselines).toEqual({});
  });
  it("advances verified journal despite a protected conflict and syncs a separate document", async () => {
    const { plugin } = fixture({ optIn: false });
    const remoteData = "unrelated synced file";
    const imported = { path: "Other.md", fileId: "other-file",
      generationId: "other-generation", revision: 1,
      hash: createHash("sha256").update(remoteData).digest("hex"),
      size: Buffer.byteLength(remoteData) };
    plugin.api = vi.fn(async url => {
      if(url.endsWith("/manifest")) return {
        vaultId: "lab", vaultSeq: 2, journalLineage: JOURNAL_ID, files: [imported]
      };
      if(url.includes("/changes?")) return {
        vaultId: "lab", vaultSeq: 2, changes: journal
      };
      throw Error("unexpected API path");
    });
    plugin.remoteBytes = vi.fn(async () => new TextEncoder().encode(remoteData).buffer);
    plugin.writeLocal = vi.fn(async () => {});
    await plugin.syncNow();
    expect(plugin.writeLocal).toHaveBeenCalledWith("Other.md", remoteData);
    expect(plugin.settings.baselines["Other.md"].hash).toBe(imported.hash);
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.settings.syncIssues).toEqual([
      { path: "gone.md", reason: "Remote missing; retained locally" }
    ]);
  });
  it("does not re-create an independently originated note when its remote peer disappears", async () => {
    const { plugin } = fixture({ optIn: false });
    plugin.settings.baselines = {};
    plugin.settings.syncIssues = [{ path: "gone.md", reason: "Existing on both devices" }];
    plugin.stageAndSend = vi.fn();
    await plugin.syncNow();
    expect(plugin.stageAndSend).not.toHaveBeenCalled();
    expect(plugin.settings.syncIssues).toEqual([
      { path: "gone.md", reason: "Remote missing; retained locally" }
    ]);
    expect(plugin.settings.cursor).toBe(2);
    await plugin.syncNow();
    expect(plugin.stageAndSend).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(2);
  });
  it("does not report a false remote deletion after uploading a file beyond the manifest frontier", async () => {
    const { plugin, file } = fixture({ changes: [] });
    plugin.settings.baselines = {};
    plugin.settings.cursor = 0;
    let manifestSeq = 0;
    plugin.api = vi.fn(async (url) => {
      if (url.endsWith("/manifest")) {
        const seq = manifestSeq;
        return { vaultId: "lab", vaultSeq: seq, journalLineage: JOURNAL_ID, files: seq ? [
          { path: file.path, size: file.stat.size, ...baseline }
        ] : [] };
      }
      if (url.includes("/changes?")) {
        return { vaultSeq: manifestSeq, changes: [
          { seq: 1, type: "create", path: file.path,
            fileId: baseline.fileId, generationId: baseline.generationId }
        ] };
      }
      throw new Error("Unexpected URL: " + url);
    });
    plugin.schedule = vi.fn();
    plugin.stageAndSend = vi.fn(async (type, local) => {
      expect(type).toBe("create");
      expect(local).toBe(file);
      // This is the server operation receipt that arrives after the
      // manifest snapshot. The remote manifest cannot contain it yet.
      plugin.settings.baselines[local.path] = { ...baseline };
      plugin.latestOperationReceipt = { scope: plugin.settings.scope, seq: 1 };
      manifestSeq = 1;
    });
    await plugin.syncNow();
    expect(plugin.stageAndSend).toHaveBeenCalledOnce();
    expect(plugin.settings.baselines[file.path]).toEqual(baseline);
    expect(plugin.settings.syncIssues).toEqual([]);
    expect(plugin.settings.cursor).toBe(0);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Confirming recent server writes");
    expect(plugin.schedule).toHaveBeenCalledOnce();
    await plugin.syncNow();
    expect(plugin.settings.cursor).toBe(1);
    expect(plugin.settings.syncIssues).toEqual([]);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Synced · server acknowledged");
  });
  it("does not carry a receipt frontier from another server into this Vault", async () => {
    const { plugin } = fixture();
    plugin.latestOperationReceipt = {
      scope: "https://old-server.example|lab", seq: 900
    };
    await plugin.syncNow();
    expect(plugin.settings.cursor).toBe(2);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Synced · server acknowledged");
  });
});
