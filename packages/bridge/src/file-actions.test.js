import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class {}, Modal: class {},
}));
import { uniqueUploadPath } from "./file-actions.js";

describe("cross-platform Vault file upload naming", () => {
  const vault = (paths = []) => ({
    getAbstractFileByPath(path) { return paths.includes(path) ? { path } : null; },
  });

  it("saves a new iOS camera photo to the chosen Vault folder", () => {
    expect(uniqueUploadPath(vault(), "pictures/2026", "IMG_0123.HEIC"))
      .toBe("pictures/2026/IMG_0123.HEIC");
    expect(uniqueUploadPath(vault(), "", "メモ.md")).toBe("メモ.md");
    expect(uniqueUploadPath(vault(), "/", "写真.png")).toBe("写真.png");
    expect(uniqueUploadPath(vault(), "/pictures/", "写真.png")).toBe("pictures/写真.png");
  });

  it("never overwrites a peer's file when names collide", () => {
    expect(uniqueUploadPath(
      vault(["photos/IMG_1.jpg", "photos/IMG_1 (1).jpg"]),
      "photos", "IMG_1.jpg"
    )).toBe("photos/IMG_1 (2).jpg");
    expect(uniqueUploadPath(vault(["image.png"]), "/", "image.png"))
      .toBe("image (1).png");
  });

  it("does not treat a synthetic pathname as a trusted upload folder", () => {
    expect(uniqueUploadPath(vault(), "", "C:\\fake\\photo.png")).toBe("photo.png");
    expect(uniqueUploadPath(vault(), "", "../photo.png")).toBe("photo.png");
    expect(() => uniqueUploadPath(vault(), "", "../")).toThrow("Invalid upload filename");
  });
});
