// Ensures a BRAT prerelease contains precisely the native Obsidian plugin
// built from this commit. It runs on the disposable distribution branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "apps/obsidian-ignis-connector");
const output = path.join(root, "release", "brat");
// Default mode stages the distribution snapshot. --check is deliberately
// read-only: CI checks exactly the bytes that are about to be uploaded.
const checkOnly = process.argv.length === 3 && process.argv[2] === "--check";
assert.ok(process.argv.length === 2 || checkOnly,
  "Usage: node scripts/validate-brat-release.mjs [--check]");
const assetNames = ["main.js", "manifest.json", "styles.css"];
const sourceAssets = await Promise.all(assetNames.map(async (name) => [
  name, await readFile(path.join(source, name))
]));
const originalManifest = sourceAssets.find(([name]) => name === "manifest.json")[1];
const originalJs = sourceAssets.find(([name]) => name === "main.js")[1];

for (const [name, bytes] of sourceAssets) {
  assert.ok(bytes.length > 0, "Empty " + name);
  assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    "BOM prohibited in " + name);
}
const manifest = JSON.parse(originalManifest.toString("utf8"));
assert.equal(manifest.id, "ignis-connector");
assert.equal(manifest.isDesktopOnly, false, "Mobile must remain supported");
assert.match(manifest.version, /^\d+\.\d+\.\d+-beta\.\d+$/,
  "BRAT release requires an explicit versioned beta manifest");
assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
assert.ok(originalJs.length < 1024 * 1024, "Unexpectedly large plugin bundle");
assert.ok(originalJs.toString("utf8").startsWith(
  "/* Ignis Connector v" + manifest.version + " */"
), "The compiled plugin was not built against the release manifest");

const checksums = sourceAssets.map(([name, bytes]) =>
  createHash("sha256").update(bytes).digest("hex") + "  " + name
).join("\n") + "\n";

if (checkOnly) {
  // An obsolete asset or a missing stylesheet must never pass as a release.
  assert.deepEqual((await readdir(output)).sort(),
    [...assetNames, "SHA256SUMS.txt"].sort(), "Unexpected BRAT asset set");
  for (const [name, bytes] of sourceAssets) {
    assert.deepEqual(await readFile(path.join(output, name)), bytes,
      "Staged BRAT asset differs from build output: " + name);
  }
  assert.equal(await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"),
    checksums, "BRAT checksums differ from staged assets");
} else {
  await mkdir(output, { recursive: true });
  for (const [name, bytes] of sourceAssets) {
    await writeFile(path.join(output, name), bytes);
  }
  await writeFile(path.join(output, "SHA256SUMS.txt"), checksums, "utf8");
}
console.log("BRAT " + manifest.version + ": " +
  (checkOnly ? "staged release verified" : "release assets staged"));
console.log(checksums);
