// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  });
  HTMLElement.prototype.empty = function () { this.replaceChildren(); return this; };
  HTMLElement.prototype.createEl = function (tag, attrs = {}) {
    const element = this.ownerDocument.createElement(tag);
    if ("text" in attrs) element.textContent = attrs.text;
    if ("cls" in attrs) element.className = attrs.cls;
    this.append(element);
    return element;
  };
  HTMLElement.prototype.createDiv = function (attrs = {}) {
    return this.createEl("div", attrs);
  };
  HTMLElement.prototype.setText = function (value) { this.textContent = value; return this; };
  HTMLElement.prototype.setAttr = function (key, value) {
    this.setAttribute(key, value); return this;
  };
});

vi.mock("obsidian", () => ({
  Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {},
  Modal: class {
    constructor(app) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.contentEl = document.createElement("div");
      this.modalEl.append(this.contentEl);
    }
    open() { document.body.append(this.modalEl); this.onOpen(); }
    close() { this.onClose(); this.modalEl.remove(); }
  },
  TFile: class TFile { constructor(path) { this.path = path; } },
  editorInfoField: null, requestUrl: vi.fn()
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));
import IgnisConnector from "./main.ts";
import { TFile } from "obsidian";
import { migrationReason } from "./migration-ui-copy.ts";

const path = "Drafts/shared.md";
function fixture() {
  const p = new IgnisConnector();
  const file = new TFile(path);
  p.app = {
    vault: { getAbstractFileByPath: name => name === path ? file : null },
    workspace: { openLinkText: vi.fn(async () => {}) }
  };
  p.settings = {
    scope: "https://example.test|lab", migrations: {},
    syncIssues: [{ path, reason: "Existing on both devices" }],
    pending: [], pendingWrites: []
  };
  p.live = { blockingPaths: vi.fn(() => []) };
  p.previewMigration = vi.fn(async () => ({
    local: "# Independently created on iOS", remote: "# Another version from Mac",
    saved: null
  }));
  p.preserveMigration = vi.fn(async () => {
    const record = {
      scope: p.settings.scope, path, sourceHash: "a".repeat(64),
      sourceCopy: "Drafts/shared (iPhone).md", remoteHash: "b".repeat(64),
      remoteCopy: "Drafts/shared (Mac).md", remoteFileId: "file-id",
      remoteGenerationId: "gen-id"
    };
    p.settings.migrations[path] = record;
    return record;
  });
  p.finishMigration = vi.fn(async () => {});
  return p;
}
const button = text => [...document.querySelectorAll(".ignis-migration-modal button")]
  .find(item => item.textContent === text);
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
afterEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("accessible migration review in native Obsidian", () => {
  it("separates a lost server history from ordinary file conflicts and offers only a safe recheck",async()=>{
    localStorage.setItem("ignis-migration-language","ja");
    const plugin=fixture();
    plugin.historyHold="changed";
    plugin.settings.syncIssues=[{
      path,reason:"Server journal identity requires review; local original retained"
    }];
    plugin.recheckJournal=vi.fn(async()=>({ok:false,message:
      "Previous journal is still unavailable"}));
    plugin.openSyncIssues();
    const panel=document.querySelector(".ignis-migration-history-review");
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toMatch(/サーバーの同期履歴を確認できません/);
    expect(button("すべての版を保存").disabled).toBe(true);
    expect(button("この2つの版を保存")).toBeUndefined();
    button("履歴を再確認して同期を再開").click();
    await tick();
    expect(plugin.recheckJournal).toHaveBeenCalledOnce();
    expect(document.querySelector(".ignis-migration-feedback").textContent)
      .toContain("Previous journal is still unavailable");
    expect(plugin.preserveMigration).not.toHaveBeenCalled();
    expect(plugin.finishMigration).not.toHaveBeenCalled();
  });
  it("translates protected bootstrap drafts, oversized files and unsent operations into actionable messages",()=>{
    expect(migrationReason("Open editor has uncommitted or unverified text", "ja"))
      .toMatch(/保存後/);
    expect(migrationReason("Attachment exceeds preview size limit", "ja"))
      .toMatch(/4MiB/);
    expect(migrationReason("Unsent create; staged bytes retained", "ja"))
      .toMatch(/サーバーの保存確認/);
  });
  it("presents independent originals without automatically uploading or replacing them", async () => {
    localStorage.setItem("ignis-migration-language", "en");
    const plugin = fixture();
    plugin.openSyncIssues();
    await tick();
    expect(document.querySelector(".ignis-migration-modal h2").textContent)
      .toMatch(/Keep every version/);
    expect(document.querySelectorAll(".ignis-migration-version")).toHaveLength(2);
    expect(document.querySelector(".ignis-migration-comparison").getAttribute("aria-label"))
      .toBe("Version comparison");
    expect(document.querySelectorAll(".ignis-migration-version pre")[0].textContent)
      .toContain("Independently created");
    expect(plugin.preserveMigration).not.toHaveBeenCalled();
    expect(plugin.finishMigration).not.toHaveBeenCalled();
  });
  it("requires preservation before exposing the two-step original migration action", async () => {
    localStorage.setItem("ignis-migration-language", "en");
    const plugin = fixture();
    plugin.openSyncIssues();
    expect(button("Finish with both versions kept")).toBeUndefined();
    button("Save separate copies").click();
    await tick();
    expect(plugin.preserveMigration).toHaveBeenCalledWith(path);
    expect(document.querySelectorAll(".ignis-migration-path")).toHaveLength(2);
    expect(button("Finish with both versions kept")).toBeTruthy();
    button("Finish with both versions kept").click();
    expect(plugin.finishMigration).not.toHaveBeenCalled();
    expect(button("Confirm: use server version at original name")).toBeTruthy();
    button("Go back").click();
    expect(plugin.finishMigration).not.toHaveBeenCalled();
  });
  it("announces a completed original switch rather than saying it was unchanged", async () => {
    localStorage.setItem("ignis-migration-language", "ja");
    const plugin = fixture();
    plugin.openSyncIssues();
    button("この2つの版を保存").click();
    await tick();
    button("両方残して移行する").click();
    button("確認：元の名前をサーバー版へ切り替える").click();
    await tick();
    expect(plugin.finishMigration).toHaveBeenCalledWith(path);
    const status = document.querySelector(".ignis-migration-feedback").textContent;
    expect(status).toContain("移行完了");
    expect(status).not.toContain("元の文書はそのまま");
  });
  it("switches Japanese/English without changing the host app's language", async () => {
    localStorage.setItem("language", "en");
    const plugin = fixture();
    plugin.openSyncIssues();
    expect(button("日本語")).toBeTruthy();
    button("日本語").click();
    expect(document.querySelector(".ignis-migration-modal h2").textContent)
      .toMatch(/すべて残して/);
    expect(button("すべての版を保存")).toBeTruthy();
    expect(localStorage.getItem("language")).toBe("en");
    expect(localStorage.getItem("ignis-migration-language")).toBe("ja");
  });
  it("does not leave duplicate active migration dialogs when reopened", () => {
    const plugin = fixture();
    plugin.openSyncIssues();
    const first = document.querySelector(".ignis-migration-modal");
    plugin.openSyncIssues();
    expect(document.querySelectorAll(".ignis-migration-modal")).toHaveLength(1);
    expect(document.querySelector(".ignis-migration-modal")).toBe(first);
    plugin.migrationModal.close();
    expect(document.querySelectorAll(".ignis-migration-modal")).toHaveLength(0);
    plugin.openSyncIssues();
    expect(document.querySelectorAll(".ignis-migration-modal")).toHaveLength(1);
    expect(document.querySelector(".ignis-migration-modal")).not.toBe(first);
  });
});
