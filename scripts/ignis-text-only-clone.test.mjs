import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloneTextOnly, inspectTextOnlySource } from "./ignis-text-only-clone.mjs";

const roots = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-clone-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "clone");
  const manifestPath = path.join(root, "audit.json");
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, "nested"));
  await fs.mkdir(path.join(source, ".obsidian"));
  await fs.writeFile(path.join(source, "nested", "hello.md"), "日本語のノート\n");
  await fs.writeFile(path.join(source, "nested", "PHOTO.md"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await fs.writeFile(path.join(source, "nested", "photo.jpg"), "image");
  await fs.writeFile(path.join(source, ".obsidian", "private.md"), "not shared");
  return { root, source, destination, manifestPath };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe("source Vault remains immutable during text-only cloning", () => {
  it("copies only valid UTF-8 Markdown and writes an external audit", async () => {
    const { source, destination, manifestPath } = await fixture();
    const before = await fs.readFile(path.join(source, "nested", "hello.md"));
    const result = await cloneTextOnly({ source, destination, manifestPath });
    expect(result).toMatchObject({ validMarkdown: 1,
      excludedNonMarkdownCount: 1 });
    expect(result.excludedMarkdown).toMatchObject([{ reason: "INVALID_UTF8" }]);
    expect(await fs.readFile(path.join(destination, "nested", "hello.md")))
      .toEqual(before);
    expect(await fs.readdir(path.join(destination, "nested"))).toEqual(["hello.md"]);
    expect(await fs.readFile(path.join(source, "nested", "PHOTO.md")))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    expect(await fs.readFile(path.join(destination, ".obsidian",
      "community-plugins.json"), "utf8")).toBe("[]\n");
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8")).entries)
      .toHaveLength(1);
    await expect(cloneTextOnly({ source, destination, manifestPath }))
      .rejects.toThrow("EEXIST");
  });
  it("rejects creating the clone inside the source Vault", async () => {
    const { source, manifestPath } = await fixture();
    await expect(cloneTextOnly({ source,
      destination: path.join(source, "child"),
      manifestPath,
    })).rejects.toThrow("separate");
  });
  it("rejects linked folders rather than following out-of-Vault content", async () => {
    const { root, source, destination, manifestPath } = await fixture();
    await fs.symlink(root, path.join(source, "backdoor"), "dir");
    await expect(cloneTextOnly({ source, destination, manifestPath }))
      .rejects.toThrow("contains links");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a BOM-marked Markdown note", async () => {
    const { source } = await fixture();
    await fs.writeFile(path.join(source, "marked.md"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("test")]));
    const report = await inspectTextOnlySource(source);
    expect(report.excludedMarkdown).toMatchObject([
      { path: "marked.md", reason: "UTF8_BOM" },
      { path: "nested/PHOTO.md", reason: "INVALID_UTF8" },
    ]);
  });
});
