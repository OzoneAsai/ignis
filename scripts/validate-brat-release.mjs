// Ensures a BRAT prerelease contains precisely the native Obsidian plugin
// built from this commit. It runs on the disposable distribution branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "apps/obsidian-ignis-connector");
const output = path.join(root, "release", "brat");
const originalManifest = await readFile(path.join(source, "manifest.json"));
const originalJs = await readFile(path.join(source, "main.js"));

for (const [name, bytes] of [
  ["manifest.json", originalManifest],
  ["main.js", originalJs]
]) {
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

await mkdir(output, { recursive: true });
await writeFile(path.join(output, "main.js"), originalJs);
await writeFile(path.join(output, "manifest.json"), originalManifest);
const checksums = [
  ["main.js", originalJs],
  ["manifest.json", originalManifest]
].map(([name, bytes]) =>
  createHash("sha256").update(bytes).digest("hex") + "  " + name
).join("\n") + "\n";
await writeFile(path.join(output, "SHA256SUMS.txt"), checksums, "utf8");
console.log("BRAT " + manifest.version + ": release assets verified");
console.log(checksums);
