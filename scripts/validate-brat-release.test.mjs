import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const roots = [];
const fixtureScript = new URL("./validate-brat-release.mjs", import.meta.url);
const version = "0.1.5-beta.2";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ignis-brat-test-"));
  roots.push(root);
  const src = path.join(root, "apps/obsidian-ignis-connector");
  const scripts = path.join(root, "scripts");
  await mkdir(src, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(scripts, "validate-brat-release.mjs"),
    await readFile(fixtureScript));
  await writeFile(path.join(src, "manifest.json"),
    JSON.stringify({ id: "ignis-connector", isDesktopOnly: false,
      version, minAppVersion: "1.9.0" }));
  await writeFile(path.join(src, "main.js"), "/* Ignis Connector v" +
    version + " */\nmodule.exports = {};");
  await writeFile(path.join(src, "styles.css"),
    ".ignis-migration-modal { display: grid; }\n");
  const run = (args = []) => spawnSync(process.execPath,
    [path.join(scripts, "validate-brat-release.mjs"), ...args],
    { cwd: root, encoding: "utf8" });
  return { root, src, output: path.join(root, "release/brat"), run };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("immutable BRAT asset staging and verification", () => {
  it("stages JavaScript, manifest, CSS and three matching hashes", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    expect(f.run(["--check"]).status).toBe(0);
    const sums = await readFile(path.join(f.output, "SHA256SUMS.txt"), "utf8");
    expect(sums.trim().split("\n").map((line) => line.slice(66)))
      .toEqual(["main.js", "manifest.json", "styles.css"]);
  });

  it("refuses a release whose CSS has disappeared", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    await rm(path.join(f.output, "styles.css"));
    expect(f.run(["--check"]).status).not.toBe(0);
  });

  it("refuses release CSS that differs from source", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    await writeFile(path.join(f.output, "styles.css"), "corrupted");
    expect(f.run(["--check"]).status).not.toBe(0);
  });

  it("refuses forged checksum records and unexpected release files", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    await writeFile(path.join(f.output, "SHA256SUMS.txt"), "incorrect");
    expect(f.run(["--check"]).status).not.toBe(0);
    expect(f.run().status).toBe(0);
    await writeFile(path.join(f.output, "obsolete.js"), "stale");
    expect(f.run(["--check"]).status).not.toBe(0);
  });

  it("rejects source CSS with UTF-8 BOM and never stages it", async () => {
    const f = await fixture();
    await writeFile(path.join(f.src, "styles.css"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("body{}")]));
    expect(f.run().status).not.toBe(0);
  });

  it("rejects unknown command modes rather than silently rebuilding", async () => {
    const f = await fixture();
    expect(f.run(["--anything"]).status).not.toBe(0);
  });
});
