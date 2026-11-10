#!/usr/bin/env node
// Snapshot a user's Vault without touching the source. Only valid UTF-8
// Markdown becomes Vault content; the manifest stays OUTSIDE the clone.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRS = new Set([
  ".obsidian", ".git", ".trash", ".ignis-connector", "node_modules",
]);
const NON_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function checkedText(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return "UTF8_BOM";
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return "INVALID_UTF8"; }
  if (NON_TEXT_CONTROL.test(text)) return "BINARY_CONTROL_CHARACTERS";
  return null;
}
async function scanMarkdown(root) {
  const accepted = [];
  const excludedMarkdown = [];
  let otherFiles = 0;
  let unsafeLinks = 0;
  const folders = [root];
  while (folders.length) {
    const dir = folders.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { unsafeLinks += 1; continue; }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) folders.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) {
        otherFiles += 1;
        continue;
      }
      // Match the IGNIS server's path restrictions before copying. Neither
      // '.' nor a hidden connector directory should enter the sync journal.
      if (rel.length > 2048 || rel.split("/").some((segment) =>
        !segment || segment === "." || segment === ".." ||
        segment.toLowerCase().startsWith(".ignis-sync-tmp-") ||
        segment.toLowerCase().startsWith(".ignis-collab-tmp-"))) {
        excludedMarkdown.push({ path: rel, reason: "UNSAFE_IGNIS_PATH" });
        continue;
      }
      const bytes = await fs.readFile(full);
      const reason = checkedText(bytes);
      if (reason) {
        excludedMarkdown.push({ path: rel, reason, bytes: bytes.length });
      } else {
        accepted.push({ path: rel, bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  accepted.sort((a, b) => a.path.localeCompare(b.path));
  excludedMarkdown.sort((a, b) => a.path.localeCompare(b.path));
  return { accepted, excludedMarkdown, otherFiles, unsafeLinks };
}

export async function inspectTextOnlySource(source) {
  const original = await fs.realpath(source);
  const stat = await fs.lstat(original);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Source must be a normal Vault directory");
  }
  const scan = await scanMarkdown(original);
  if (scan.unsafeLinks) {
    throw new Error("Source contains links: review them before cloning");
  }
  return { source: original, ...scan };
}

export async function cloneTextOnly({ source, destination, manifestPath }) {
  if (![source, destination, manifestPath].every((value) =>
    typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("Absolute source, destination and manifest paths are required");
  }
  const snapshot = await inspectTextOnlySource(source);
  const parent = await fs.realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const manifestParent = await fs.realpath(path.dirname(manifestPath));
  const report = path.join(manifestParent, path.basename(manifestPath));
  if (within(snapshot.source, target) || within(target, snapshot.source) ||
      within(target, report)) {
    throw new Error("Source, clone and external manifest must be separate");
  }
  if (snapshot.accepted.length === 0) throw new Error("No valid Markdown found");
  // Exclusive mkdir: never adopt, replace or reconcile a preexisting Vault.
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  for (const file of snapshot.accepted) {
    const original = path.join(snapshot.source, ...file.path.split("/"));
    const copy = path.join(target, ...file.path.split("/"));
    const bytes = await fs.readFile(original);
    if (digest(bytes) !== file.sha256) {
      throw new Error("Source note changed during cloning; do not sync this clone");
    }
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, bytes, { flag: "wx" });
    if (digest(await fs.readFile(copy)) !== file.sha256) {
      throw new Error("Copied Markdown hash did not match the original");
    }
  }
  // Minimal local Obsidian settings only. No source plugins, attachments,
  // sync credentials, history, cache or .obsidian contents are inherited.
  await fs.mkdir(path.join(target, ".obsidian"));
  await fs.writeFile(path.join(target, ".obsidian", "community-plugins.json"),
    "[]\n", { flag: "wx" });

  const after = await inspectTextOnlySource(snapshot.source);
  if (JSON.stringify({
    accepted: snapshot.accepted, excludedMarkdown: snapshot.excludedMarkdown,
    otherFiles: snapshot.otherFiles, unsafeLinks: snapshot.unsafeLinks,
  }) !== JSON.stringify({
    accepted: after.accepted, excludedMarkdown: after.excludedMarkdown,
    otherFiles: after.otherFiles, unsafeLinks: after.unsafeLinks,
  })) {
    throw new Error("Source Vault changed during the copy; clone requires review");
  }
  const audit = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: snapshot.source, destination: target,
    validMarkdown: snapshot.accepted.length,
    validBytes: snapshot.accepted.reduce((sum, file) => sum + file.bytes, 0),
    excludedMarkdown: snapshot.excludedMarkdown,
    excludedNonMarkdownCount: snapshot.otherFiles,
    entries: snapshot.accepted,
    contentDigest: digest(Buffer.from(JSON.stringify(snapshot.accepted))),
  };
  // The auditable path list is external, not a note uploaded by Vault Sync.
  await fs.writeFile(report, JSON.stringify(audit, null, 2) + "\n",
    { flag: "wx", mode: 0o600, encoding: "utf8" });
  return audit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, manifestPath] = process.argv.slice(2);
  cloneTextOnly({ source, destination, manifestPath }).then((audit) => {
    console.log(JSON.stringify({
      result: "CLONED", validMarkdown: audit.validMarkdown,
      validBytes: audit.validBytes, excludedMarkdown: audit.excludedMarkdown.length,
      excludedNonMarkdownCount: audit.excludedNonMarkdownCount,
      contentDigest: audit.contentDigest, destination: audit.destination,
    }));
  }).catch((e) => {
    console.error("TEXT_CLONE_FAILED=" + e.message);
    process.exitCode = 1;
  });
}
