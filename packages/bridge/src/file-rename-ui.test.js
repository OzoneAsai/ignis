// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class { constructor(message) { this.message = message; } },
  Modal: class {
    constructor(app) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }
    open() { document.body.append(this.contentEl); this.onOpen(); }
    close() { this.onClose?.(); this.contentEl.remove(); }
  },
}));

import { showFileRename, addFileMenuItems } from "./file-actions.js";

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
  HTMLElement.prototype.empty = function () { this.replaceChildren(); return this; };
  HTMLElement.prototype.addClass = function (name) { this.classList.add(name); return this; };
  HTMLElement.prototype.setText = function (value) { this.textContent = value; return this; };
  HTMLElement.prototype.createEl = function (tag, attributes = {}) {
    const node = document.createElement(tag);
    if ("text" in attributes) node.textContent = attributes.text;
    if ("type" in attributes) node.type = attributes.type;
    if ("cls" in attributes) node.className = attributes.cls;
    this.append(node);
    return node;
  };
  HTMLElement.prototype.createDiv = function (attributes = {}) {
    return this.createEl("div", attributes);
  };
});

function harness() {
  const files = [
    { name: "IMG_001.HEIC", path: "写真/IMG_001.HEIC", stat: { mtime: 200 } },
    { name: "旅行.HEIC", path: "写真/旅行.HEIC", stat: { mtime: 100 } },
    { name: "今日.md", path: "今日.md", stat: { mtime: 99 } },
  ];
  const rename = vi.fn(async (file, destination) => {
    file.path = destination;
    file.name = destination.split("/").pop();
  });
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath: path => files.find(file => file.path === path) || null,
    },
    fileManager: { renameFile: rename },
  };
  return { app, files, rename };
}

describe("file rename on touch-only Ignis Web", () => {
  it("finds a HEIC image, blocks duplicate names, and preserves the extension", async () => {
    const { app, files, rename } = harness();
    const modal = showFileRename(app);
    const search = modal.contentEl.querySelector(".ignis-rename-file-search");
    expect(search).not.toBeNull();
    search.value = "IMG_001";
    search.dispatchEvent(new Event("input"));
    const choice = modal.contentEl.querySelector(".ignis-rename-file-select");
    expect(choice.textContent).toBe("写真/IMG_001.HEIC");
    choice.click();
    const form = modal.contentEl.querySelector(".ignis-rename-form");
    const input = form.querySelector("input");
    expect(input.value).toBe("IMG_001");
    expect(form.textContent).toContain(".HEIC");
    input.value = "旅行";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait();
    expect(rename).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("同じ名前のファイル");
    input.value = "文化祭";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait();
    expect(rename).toHaveBeenCalledWith(files[0], "写真/文化祭.HEIC");
    expect(modal.contentEl.isConnected).toBe(false);
  });

  it("opens a specific image from the file context menu without a floating overlay", () => {
    const { app, files } = harness();
    let callback;
    const actions = [];
    const menu = { addItem(configure) {
      const item = {
        setTitle(name) { actions.push(name); return this; },
        setIcon() { return this; },
        setSection() { return this; },
        onClick(fn) { callback ||= fn; return this; },
      };
      configure(item);
    } };
    addFileMenuItems(menu, files[0], app);
    expect(actions).toContain("ファイル名を変更");
    callback();
    expect(document.querySelector(".ignis-rename-form input").value)
      .toBe("IMG_001");
  });
});
