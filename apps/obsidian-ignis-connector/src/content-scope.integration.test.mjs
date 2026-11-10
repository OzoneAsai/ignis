// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContentScope } from "../../../packages/sync-policy/src/content-scope";
const JOURNAL_ID = "00000000-0000-4000-8000-000000000044";

vi.mock("obsidian", () => ({
  Plugin: class {}, PluginSettingTab: class {}, Modal: class {},
  Setting: class {}, Notice: class {}, editorInfoField: null,
  requestUrl: vi.fn(),
  TFile: class TFile {
    constructor(name, bytes = 4) {
      this.path = name;
      this.stat = { size: bytes };
    }
  },
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));

import IgnisConnector from "./main.ts";
import { TFile } from "obsidian";

const files = [
  new TFile("Notes/from-sls.md", 22),
  new TFile("Media/device-local.png", 12),
  new TFile("Media/unshared-video.mp4", 24),
];

function makeConnector() {
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl: "https://ignis.example",
    vaultId: "MarkdownLab",
    scope: "https://ignis.example|MarkdownLab",
    journalLineage: JOURNAL_ID,
    authMode: "device",
    deviceId: "test-sls-device",
    contentScope: "markdown-only",
    cursor: 0, baselines: {}, pending: [], pendingWrites: [],
    yjsIds: {}, syncIssues: [], archivedScopes: [],
    applyRemoteDeletes: false,
  };
  plugin.fileScope = createContentScope("markdown-only");
  plugin.settings.deviceContentScope = "follow-server";
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.status = { setText: vi.fn() };
  plugin.live = {
    blockingPaths: vi.fn(() => []),
    isManaged: vi.fn(() => false),
    saveState: vi.fn(() => ({
      online: true, active: 0, awaitingServer: 0,
      reconnecting: 0, blocked: 0,
    })),
  };
  const readBinary = vi.fn(async () => new ArrayBuffer(24));
  plugin.app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { getFiles: () => files, readBinary },
  };
  plugin.api = vi.fn(async (url) => {
    if (url.endsWith("/manifest")) {
      return { vaultId: "MarkdownLab", vaultSeq: 0,
        journalLineage: JOURNAL_ID, files: [] };
    }
    throw new Error("Unexpected API request: " + url);
  });
  plugin.saveData = vi.fn(async () => {});
  plugin.stageAndSend = vi.fn(async () => {});
  plugin.schedule = vi.fn();
  return { plugin, readBinary };
}

afterEach(() => vi.restoreAllMocks());

describe("Obsidian Connector respects server-selected Markdown-only scope", () => {
  it("downloads and uploads only explicitly bypassed PDFs/Office files under a narrow device scope", async () => {
    const { plugin, readBinary } = makeConnector();
    plugin.app.vault.getFiles = () => [
      new TFile("Notes/from-sls.md", 22),
      new TFile("Documents/presentation.pptx", 12),
      new TFile("Documents/report.pdf", 15),
      new TFile("Media/photo.png", 20),
    ];
    plugin.settings.serverMediaBypassExtensions = ["pdf", "pptx"];
    plugin.settings.deviceMediaBypassExtensions = [];
    plugin.settings.deviceContentScope = "markdown-only";
    plugin.rebuildFileScope();
    expect(plugin.fileScope.allowsPath("Documents/report.pdf")).toBe(false);
    const enabled = await plugin.setDeviceMediaBypassExtensions(["PDF", "pptx"]);
    expect(enabled.ok).toBe(true);
    expect(plugin.settings.deviceMediaBypassExtensions).toEqual(["pdf", "pptx"]);
    expect(plugin.fileScope.allowsPath("Documents/report.pdf")).toBe(true);
    expect(plugin.fileScope.allowsPath("Documents/presentation.pptx")).toBe(true);
    expect(plugin.fileScope.allowsPath("Media/photo.png")).toBe(false);
    await plugin.syncNow();
    expect(plugin.stageAndSend.mock.calls.map(([, file]) => file.path))
      .toEqual(["Notes/from-sls.md", "Documents/presentation.pptx",
        "Documents/report.pdf"]);
    // The staged write implementation is separately tested with a real
    // binary payload. Never rely on Syncthing's status here.
    expect(readBinary).not.toHaveBeenCalled();
  });
  it("refuses a PDF bypass when the server's verified allowance excludes it", async () => {
    const { plugin } = makeConnector();
    plugin.settings.deviceContentScope = "markdown-only";
    plugin.settings.serverMediaBypassExtensions = [];
    const denied = await plugin.setDeviceMediaBypassExtensions(["pdf"]);
    expect(denied.ok).toBe(false);
    expect(plugin.settings.deviceMediaBypassExtensions || []).toEqual([]);
    expect(plugin.fileScope.allowsPath("Documents/report.pdf")).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });
  it("preserves an unsent PDF operation when disabling a formerly allowed bypass", async () => {
    const { plugin } = makeConnector();
    plugin.settings.deviceContentScope = "markdown-only";
    plugin.settings.serverMediaBypassExtensions = ["pdf"];
    plugin.settings.deviceMediaBypassExtensions = ["pdf"];
    plugin.settings.pendingWrites.push({
      path: "Documents/report.pdf", type: "create", opId: "unsent-pdf-00001",
      contentBase64: "JVBERg==", localHash: "a".repeat(64),
    });
    plugin.rebuildFileScope();
    const change = await plugin.setDeviceMediaBypassExtensions([]);
    expect(change.ok).toBe(false);
    expect(plugin.settings.deviceMediaBypassExtensions).toEqual(["pdf"]);
    expect(plugin.settings.pendingWrites).toHaveLength(1);
  });
  it("lets a single device opt out of media when the server allows media", async () => {
    const { plugin, readBinary } = makeConnector();
    plugin.settings.contentScope = "all";
    plugin.rebuildFileScope();
    const outcome = await plugin.setDeviceContentScope("markdown-only");
    expect(outcome.ok).toBe(true);
    expect(plugin.settings.deviceContentScope).toBe("markdown-only");
    expect(plugin.fileScope.allowsPath("Media/device-local.png")).toBe(false);
    expect(plugin.saveData).toHaveBeenCalled();
    await plugin.syncNow();
    expect(plugin.stageAndSend).toHaveBeenCalledTimes(1);
    expect(plugin.stageAndSend).toHaveBeenCalledWith("create", files[0]);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("keeps the previous setting if media writes are still queued", async () => {
    const { plugin } = makeConnector();
    plugin.settings.contentScope = "all";
    plugin.settings.pendingWrites.push({
      path: "Media/device-local.png", type: "create",
      opId: "unsent-attachment", contentBase64: "YQ==",
      localHash: "a".repeat(64),
    });
    const response = await plugin.setDeviceContentScope("markdown-only");
    expect(response.ok).toBe(false);
    expect(plugin.settings.deviceContentScope).toBe("follow-server");
    expect(plugin.settings.pendingWrites).toHaveLength(1);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("restores the old device choice when settings persistence fails", async () => {
    const { plugin } = makeConnector();
    plugin.settings.contentScope = "all";
    plugin.rebuildFileScope();
    plugin.saveData.mockRejectedValueOnce(new Error("Disk temporarily unavailable"));
    const outcome = await plugin.setDeviceContentScope("markdown-only");
    expect(outcome.ok).toBe(false);
    expect(plugin.settings.deviceContentScope).toBe("follow-server");
    expect(plugin.fileScope.allowsPath("Media/device-local.png")).toBe(true);
  });

  it("does not change file scope while a transfer is running", async () => {
    const { plugin } = makeConnector();
    plugin.settings.contentScope = "all";
    plugin.syncing = true;
    const response = await plugin.setDeviceContentScope("markdown-only");
    expect(response.ok).toBe(false);
    expect(plugin.settings.deviceContentScope).toBe("follow-server");
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("only widens up to the server's limit even if user unchecks the switch", async () => {
    const { plugin } = makeConnector();
    plugin.settings.deviceContentScope = "markdown-only";
    plugin.rebuildFileScope();
    expect((await plugin.setDeviceContentScope("follow-server")).ok).toBe(true);
    expect(plugin.fileScope.allowsPath("Media/device-local.png")).toBe(false);
  });

  it("rechecks server policy using the verified session without restarting collaboration", async () => {
    const { plugin } = makeConnector();
    plugin.settings.contentScope = "all";
    plugin.rebuildFileScope();
    plugin.deviceRequest = vi.fn(async () => ({
      json: { vaultId: "MarkdownLab", deviceId: "test-sls-device",
        contentScope: "markdown-only" },
    }));
    const response = await plugin.recheckSharingScope();
    expect(response.ok).toBe(true);
    expect(plugin.settings.contentScope).toBe("markdown-only");
    expect(plugin.fileScope.allowsPath("Media/device-local.png")).toBe(false);
    expect(plugin.deviceRequest).toHaveBeenCalledWith(
      "/vaults/MarkdownLab/session",
    );
  });
  it("only queues Markdown for transfer and never reads binary file contents", async () => {
    const { plugin, readBinary } = makeConnector();
    await plugin.syncNow();
    expect(plugin.stageAndSend).toHaveBeenCalledTimes(1);
    expect(plugin.stageAndSend).toHaveBeenCalledWith(
      "create", files[0],
    );
    expect(readBinary).not.toHaveBeenCalled();
    expect(plugin.settings.cursor).toBe(0);
    expect(plugin.settings.syncIssues).toEqual([]);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Synced · server acknowledged",
    );
  });

  it("keeps a legacy binary baseline without treating exclusion as a deletion", async () => {
    const { plugin } = makeConnector();
    plugin.settings.baselines["Media/device-local.png"] = {
      fileId: "old-binary", generationId: "old-generation",
      hash: "a".repeat(64), revision: 1,
    };
    plugin.settings.applyRemoteDeletes = true;
    plugin.app.vault.trash = vi.fn(async () => {});
    await plugin.syncNow();
    expect(plugin.app.vault.trash).not.toHaveBeenCalled();
    expect(plugin.settings.baselines["Media/device-local.png"].fileId)
      .toBe("old-binary");
    expect(plugin.settings.syncIssues).toEqual([]);
  });

  it("does not replay an excluded binary staged write after mode selection", async () => {
    const { plugin } = makeConnector();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    plugin.settings.pendingWrites = [{
      opId: "pending-binary-1", type: "create",
      path: "Media/device-local.png", contentBase64: "YQ==",
      localHash: "a".repeat(64),
    }];
    plugin.deviceRequest = vi.fn(async () => ({
      status: 404,
    }));
    await plugin.syncNow();
    expect(plugin.deviceRequest).not.toHaveBeenCalled();
    expect(plugin.stageAndSend).not.toHaveBeenCalled();
    expect(plugin.settings.pendingWrites).toHaveLength(1);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Pending · locally retained",
    );
  });
});
