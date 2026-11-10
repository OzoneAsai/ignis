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
import { pdfVaultResourceUrl, showPdfPreview } from "./pdf-preview.js";

beforeEach(() => {
  document.body.replaceChildren();
  HTMLElement.prototype.empty = function () { this.replaceChildren(); return this; };
  HTMLElement.prototype.addClass = function (name) {
    this.classList.add(name); return this;
  };
  HTMLElement.prototype.createEl = function (tag, attributes = {}) {
    const node = document.createElement(tag);
    if ("text" in attributes) node.textContent = attributes.text;
    if ("cls" in attributes) node.className = attributes.cls;
    this.append(node);
    return node;
  };
});

describe("Ignis Web PDF preview", () => {
  it("constructs same-origin paths safely, preserving nested folders and Unicode", () => {
    expect(pdfVaultResourceUrl("SLS-TextClone", "資料/価格 表.PDF"))
      .toBe("/vault-files/SLS-TextClone/" +
        "%E8%B3%87%E6%96%99/%E4%BE%A1%E6%A0%BC%20%E8%A1%A8.PDF");
    for (const invalid of ["../secret.pdf", "/absolute.pdf",
      "Books/../other.pdf", ".obsidian/secrets.pdf", "a\\b.pdf",
      "sample.pdf/../../secret.pdf", "notes.md"]) {
      expect(pdfVaultResourceUrl("Vault", invalid)).toBeNull();
    }
  });
  it("offers an accessible responsive inline frame and a browser fallback", () => {
    const file = { path: "Reports/Paper.pdf", name: "Paper.pdf" };
    const modal = showPdfPreview({}, file, "SLS-TextClone");
    expect(modal).toBeTruthy();
    const iframe = modal.contentEl.querySelector("iframe");
    expect(iframe.title).toBe("PDF preview: Paper.pdf");
    expect(iframe.src).toContain("/vault-files/SLS-TextClone/Reports/Paper.pdf");
    expect(iframe.style.height).toContain("72vh");
    const link = modal.contentEl.querySelector("a");
    expect(link.getAttribute("href")).toBe(
      "/vault-files/SLS-TextClone/Reports/Paper.pdf");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    modal.close();
    expect(modal.contentEl.querySelector("iframe")).toBeNull();
  });
});
