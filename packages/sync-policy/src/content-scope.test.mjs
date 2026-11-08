import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createContentScope } = require("./content-scope");

describe("transport-independent content scope", () => {
  it("bypasses only the explicitly selected document/media extensions", () => {
    const scope = createContentScope("markdown-only", ["PDF", "docx", "XLSX", "pptx"]);
    for (const path of ["Docs/paper.pdf", "Docs/presentation.PPTX",
      "Docs/report.docx", "Data/book.Xlsx", "Notes/normal.md"]) {
      expect(scope.allowsPath(path)).toBe(true);
    }
    for (const path of ["Media/movie.mp4", "Images/photo.png",
      "Documents/secret.pdf.exe", ".obsidian/page.pdf",
      "../outside.pdf", "Docs/.ignis-sync-tmp-private/c.pdf"]) {
      expect(scope.allowsPath(path)).toBe(false);
    }
    expect(scope.bypassExtensions).toEqual(["docx", "pdf", "pptx", "xlsx"]);
  });
  it("rejects executable/config extensions instead of granting arbitrary bypass", () => {
    expect(() => createContentScope("markdown-only", ["exe"])).toThrow();
    expect(() => createContentScope("markdown-only", ["pdf", "../evil"])).toThrow();
    expect(() => createContentScope("markdown-only", "pdf")).toThrow();
  });
  it("supports existing full synchronization by default", () => {
    const scope = createContentScope();
    expect(scope.allowsPath("Notes/hello.md")).toBe(true);
    expect(scope.allowsPath("Media/photo.jpg")).toBe(true);
    expect(scope.allowsPath("Videos/large.mp4")).toBe(true);
  });

  it("accepts Markdown and rejects every other file type, regardless of folder", () => {
    const scope = createContentScope("markdown-only");
    for (const file of ["Today.md", "Notes/plan.MD", "Media/caption.md"]) {
      expect(scope.allowsPath(file)).toBe(true);
    }
    for (const file of [
      "Media/photo.jpg", "Media/video.mp4", "Data/index.json",
      "image.md.png", "Notes/notebook.canvas", "Media",
      ".obsidian/config.md", "../outside.md", "Notes//bad.md",
      "Notes/.ignis-sync-tmp-32/foo.md",
    ]) {
      expect(scope.allowsPath(file)).toBe(false);
    }
    expect(() => createContentScope("active")).toThrow("Unknown");
  });
});
