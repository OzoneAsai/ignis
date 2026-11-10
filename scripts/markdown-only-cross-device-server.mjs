// An explicitly isolated, disposable cross-OS acceptance server.
// Run only with IGNIS_MARKDOWN_SMOKE=1. It binds one Tailnet IP, uses
// a random scoped token, and never exposes an existing user Vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("../apps/ignis-server/server/sync/store");
const { createSyncRouter } = require("../apps/ignis-server/server/sync/http");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".ignis-local-tools", "markdown-only-smoke-20261107");
const vault = path.join(root, "vault");

if (process.env.IGNIS_MARKDOWN_SMOKE !== "1") {
  throw new Error("Set IGNIS_MARKDOWN_SMOKE=1 to run this isolated test");
}
if (fs.existsSync(root)) throw new Error("Smoke root exists: refusing to adopt existing data");

const ipCandidates = [...new Set(
  Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && !entry.internal &&
      entry.family === "IPv4" && entry.address.startsWith("100."))
    .filter((entry) => {
      const second = Number(entry.address.split(".")[1]);
      return second >= 64 && second <= 127;
    })
    .map((entry) => entry.address)
)];
if (ipCandidates.length !== 1) throw new Error("One Tailnet IPv4 address is required");

fs.mkdirSync(root, { mode: 0o700 });
fs.mkdirSync(vault, { mode: 0o700 });
fs.mkdirSync(path.join(vault, "Media"));
fs.writeFileSync(path.join(vault, "Mac-note.md"), "# Mac Markdown-only test\nMedia is local.\n");
fs.writeFileSync(path.join(vault, "Media", "do-not-transfer.mp4"),
  "Only on Mac, not on SLS");
fs.writeFileSync(path.join(vault, "Media", "do-not-transfer.png"),
  "Only on Mac, not on SLS");
const store = new VaultSyncStore({
  dataRoot: root, contentScope: "markdown-only",
  getVaultPath: (id) => id === "MarkdownLab" ? vault : null,
  collaboration: {
    getActive: () => null, peekDocumentId: () => null,
    isCollaborative: () => false,
    deleteNote: async (_v, _path, fn) => fn(),
    renameNote: async (_v, _from, _to, fn) => fn(),
  },
  writeCoalescer: { flushPending: async () => {} },
});
const token = store.enrollDevice("MarkdownLab", "SLS isolated smoke").token;
const app = express();
app.use(express.json({ limit: "6mb" }));
app.use("/api/sync/v1", createSyncRouter({
  store, token: randomBytes(48).toString("base64url"),
}));
const port = 3197;
const server = app.listen(port, ipCandidates[0]);
fs.writeFileSync(path.join(root, "client-session.json"),
  JSON.stringify({ url: "http://" + ipCandidates[0] + ":" + port + "/api/sync/v1",
    token, vaultId: "MarkdownLab" }),
  { flag: "wx", mode: 0o600 });
server.once("listening", () => {
  console.log("MARKDOWN_ONLY_SMOKE_READY=" + ipCandidates[0] + ":" + port);
  console.log("MODE=markdown-only; SYNC_ENGINE=IGNIS; SYNCTHING=not-required");
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  store.close();
  // Only the directory that this process created with exclusive semantics.
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ISOLATED_MARKDOWN_ONLY_SMOKE_CLEANED");
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
