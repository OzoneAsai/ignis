import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSyncPolicy, canonicalPath } = require("./index.js");

describe("persisted Vault synchronization ownership", () => {
  it("defaults to IGNIS regardless of whether Syncthing is installed", () => {
    const policy = createSyncPolicy();
    expect(policy.ownerFor("Media/large-video.mp4")).toBe("ignis");
    expect(policy.ownerFor("Notes/today.md")).toBe("ignis");
  });

  it("recognizes only configured path-boundary media subtrees", () => {
    const policy = createSyncPolicy({ enabled: true, roots: ["Media"] });
    expect(policy.ownerFor("Media/movie.mkv")).toBe("syncthing");
    expect(policy.ownerFor("Media/Sub/photo.jpg")).toBe("syncthing");
    expect(policy.ownerFor("Mediastore/movie.mkv")).toBe("ignis");
    expect(policy.ownerFor("Notes/movie.mkv")).toBe("ignis");
  });

  it("keeps ownership when the external process is unavailable", () => {
    const policy = createSyncPolicy({ enabled: true, roots: ["Media"] });
    expect(policy.ownerFor("Media/file.mp4")).toBe("syncthing");
    expect(policy.ownerFor("Media/file.mp4")).toBe("syncthing");
  });

  it("marks Markdown in a Syncthing subtree as an explicit conflict", () => {
    const policy = createSyncPolicy({ enabled: true, roots: ["Media"] });
    expect(policy.ownerFor("Media/captions.md")).toBe("conflict");
    expect(policy.ownerFor("Notes/captions.md")).toBe("ignis");
  });

  it("excludes existing IGNIS internal folders in both modes", () => {
    for (const enabled of [true, false]) {
      const policy = createSyncPolicy({ enabled, roots: ["Media"] });
      expect(policy.ownerFor(".obsidian/workspace.json")).toBe("internal");
      expect(policy.ownerFor("Media/.git/index")).toBe("internal");
      expect(policy.ownerFor("Media/.ignis-sync-tmp-1/foo")).toBe("internal");
    }
  });

  it("normalizes NFC and case to prevent duplicate ownership on Mac and Windows", () => {
    const policy = createSyncPolicy({ enabled: true, roots: ["Média"] });
    expect(policy.ownerFor("me\u0301dia/clip.mp4")).toBe("syncthing");
    expect(policy.ownerFor("MÉDIA/clip.mp4")).toBe("syncthing");
    expect(canonicalPath("me\u0301dia/file")).toBe("média/file");
  });

  it("rejects traversal, absolute paths and backslashes", () => {
    for (const relative of ["../Media", "/Media", "Media/../x", "Media\\file", "Media//x"]) {
      expect(() => canonicalPath(relative)).toThrow();
    }
  });

  it("rejects nested or duplicate managed roots rather than inventing precedence", () => {
    expect(() => createSyncPolicy({ enabled: true, roots: ["Media", "media/sub"] }))
      .toThrow("Overlapping");
    expect(() => createSyncPolicy({ enabled: true, roots: ["Media", "MEDIA"] }))
      .toThrow("Overlapping");
  });

  it("rejects internal or Markdown directories as managed roots", () => {
    for (const root of [".obsidian", "Media/.git", "Notes.md", "../Media"]) {
      expect(() => createSyncPolicy({ enabled: true, roots: [root] })).toThrow();
    }
  });
});
