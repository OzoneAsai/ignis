import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prepareEmptyPilotFolder, assertEmptyPilotFolder } = require("./pilot-folder");

let temporary;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "ignis-pilot-policy-")));
});
afterEach(async () => { await rm(temporary, { force: true, recursive: true }); });

describe("cross-platform pilot folder safety policy", () => {
  it("creates a private empty folder and safely reuses it", async () => {
    const folder = path.join(temporary, "Media", "Empty-Pilot");
    expect(await prepareEmptyPilotFolder(folder)).toBe(true);
    await expect(assertEmptyPilotFolder(folder)).resolves.toBeUndefined();
    expect(await prepareEmptyPilotFolder(folder)).toBe(false);
  });

  it("rejects relative paths, filesystem root, and existing files", async () => {
    await expect(prepareEmptyPilotFolder("Media")).rejects.toThrow("absolute");
    await expect(prepareEmptyPilotFolder(path.parse(temporary).root))
      .rejects.toThrow("roots");
    const file = path.join(temporary, "occupied");
    await writeFile(file, "test");
    await expect(prepareEmptyPilotFolder(file)).rejects.toThrow("通常ファイル");
  });

  it("refuses nonempty directories and links in the path ancestry", async () => {
    const collection = path.join(temporary, "Existing");
    await mkdir(collection);
    await writeFile(path.join(collection, "content.txt"), "must not share");
    await expect(prepareEmptyPilotFolder(collection)).rejects.toThrow("空でない");
    const link = path.join(temporary, "redirect");
    await symlink(collection, link, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareEmptyPilotFolder(path.join(link, "child")))
      .rejects.toThrow("リンク");
  });
});
