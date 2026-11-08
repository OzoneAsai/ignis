import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { preflightMediaOwnership } = require("./preflight");
let vault;

async function examine(changes = {}) {
  return preflightMediaOwnership({ vaultRoot: vault, roots: ["Media"], ...changes });
}

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-media-preflight-"));
  await fs.mkdir(path.join(vault, "Media"));
});

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

describe("read-only migration safety preflight", () => {
  it("admits an empty isolated media root without activating it", async () => {
    const result = await examine();
    expect(result).toMatchObject({
      mode: "read-only-preflight", safeForEmptyPilot: true,
      activationAvailable: false, issues: [],
      policy: { enabled: true, roots: ["media"] },
    });
  });

  it("refuses to reinterpret already journaled files as deletions", async () => {
    const result = await examine({
      journalPaths: [
        { path: "Media/file.mp4" }, { path: "Notes/note.md", toPath: "Media/moved.mp4" },
      ],
    });
    expect(result.safeForEmptyPilot).toBe(false);
    expect(result.issues.find((issue) => issue.code === "IGNIS_JOURNAL_HISTORY").count).toBe(2);
  });

  it("blocks any preexisting data or a Markdown file", async () => {
    await fs.writeFile(path.join(vault, "Media", "movie.mp4"), "hello");
    await fs.writeFile(path.join(vault, "Media", "notes.md"), "hello");
    const result = await examine();
    expect(result.safeForEmptyPilot).toBe(false);
    expect(result.issues.map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["ROOT_NOT_EMPTY", "MARKDOWN_IN_MEDIA"]));
  });

  it("rejects a symbolic link instead of accidentally indexing another drive", async () => {
    await fs.rm(path.join(vault, "Media"), { recursive: true });
    await fs.symlink(path.dirname(vault), path.join(vault, "Media"));
    expect((await examine()).issues.some((issue) => issue.code === "ROOT_NOT_READY")).toBe(true);
  });

  it("rejects missing roots and pending clients even when the directory is empty", async () => {
    await fs.rm(path.join(vault, "Media"), { recursive: true });
    const result = await examine({ activeDeviceCount: 2 });
    expect(result.safeForEmptyPilot).toBe(false);
    expect(result.issues.map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["ROOT_NOT_READY", "DEVICES_NOT_QUIESCED"]));
  });

  it("allows only a Syncthing folder marker and never writes during inspection", async () => {
    await fs.mkdir(path.join(vault, "Media", ".stfolder"));
    const before = await fs.readdir(path.join(vault, "Media"));
    expect((await examine()).safeForEmptyPilot).toBe(true);
    expect(await fs.readdir(path.join(vault, "Media"))).toEqual(before);
  });

  it("does not accept a media root without an explicit path", async () => {
    await expect(examine({ roots: [] })).rejects.toThrow("Invalid");
    await expect(examine({ roots: ["Media/../Notes"] })).rejects.toThrow();
    await expect(examine({ roots: ["Media", "media"] })).rejects.toThrow();
  });
});
