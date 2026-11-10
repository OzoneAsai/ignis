import { describe, expect, it } from "vitest";
import { fileBaseName, fileExtension, renameDestination } from "./file-rename-path.js";

const file = path => ({ path, name: path.split("/").pop() });
const vault = (paths = []) => ({
  getAbstractFileByPath: path => paths.includes(path) ? file(path) : null,
});

describe("safe cross-platform file rename", () => {
  it("renames iOS image files without changing extensions or parent folders", () => {
    expect(renameDestination(vault(), file("写真/IMG_3214.HEIC"), "旅行"))
      .toBe("写真/旅行.HEIC");
    expect(renameDestination(vault(), file("画材/線画.png"), "清書.png"))
      .toBe("画材/清書.png");
    expect(renameDestination(vault(), file("slides/final.v2.pdf"), "draft.v3"))
      .toBe("slides/draft.v3.pdf");
    expect(renameDestination(vault(), file("図.md"), "図の説明"))
      .toBe("図の説明.md");
    expect(fileBaseName(file("IMG_0123.HEIC"))).toBe("IMG_0123");
    expect(fileExtension(file("IMG_0123.HEIC"))).toBe(".HEIC");
  });

  it("cannot overwrite a different file", () => {
    expect(() => renameDestination(vault(["写真/旅行.png"]),
      file("写真/IMG_3214.png"), "旅行"))
      .toThrow("同じ名前のファイル");
    expect(renameDestination(vault(["写真/IMG_3214.png"]),
      file("写真/IMG_3214.png"), "IMG_3214"))
      .toBe("写真/IMG_3214.png");
  });

  it("rejects invalid names without interpreting paths or OS-specific separators", () => {
    for (const name of ["", "   ", ".", "..", "../other", "\\other", "x/y", "bad:name", "x\0z", "x?", "name."]) {
      expect(() => renameDestination(vault(), file("photo.png"), name)).toThrow();
    }
  });
});
