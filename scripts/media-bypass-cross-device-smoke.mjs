// Isolated, disposable REST acceptance harness for Windows and Android.
// Does not launch Syncthing, write into a real Vault, or reuse user tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express from "express";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("../apps/ignis-server/server/sync/store");
const { createSyncRouter } = require("../apps/ignis-server/server/sync/http");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, ".ignis-local-tools", "media-bypass-device-smoke-20261108");
const vault = path.join(root, "vault");
const vaultId = "MediaBypassLab";
const port = 3211;
if (process.env.IGNIS_MEDIA_BYPASS_SMOKE !== "1") {
  throw new Error("IGNIS_MEDIA_BYPASS_SMOKE=1 required");
}
if (fs.existsSync(root)) throw new Error("Isolated test root already exists");
const tailnetIps = [...new Set(
  Object.values(os.networkInterfaces()).flat()
    .filter((info) => info?.family === "IPv4" && !info.internal)
    .map((info) => info.address)
    .filter((ip) => {
      const [a, b] = ip.split(".").map(Number);
      return a === 100 && b >= 64 && b <= 127;
    })
)];
if (tailnetIps.length !== 1) throw new Error("Ambiguous Tailnet interface");

fs.mkdirSync(root, { mode: 0o700 });
fs.mkdirSync(vault, { mode: 0o700 });
fs.mkdirSync(path.join(vault, "Documents"), { mode: 0o700 });
execFileSync("python3", [path.join(repo, "scripts", "media-bypass-smoke-fixtures.py"),
  path.join(vault, "Documents")], { stdio: "pipe", timeout: 10000 });
fs.writeFileSync(path.join(vault, "WELCOME.md"), "# IGNIS Device Media Bypass\n");
fs.writeFileSync(path.join(vault, "Documents", "not-shared.jpg"), "local-only-image");

const store = new VaultSyncStore({
  dataRoot: root,
  contentScope: "markdown-only",
  getVaultPath: (id) => id === vaultId ? vault : null,
  collaboration: {
    getActive: () => null, peekDocumentId: () => null, isCollaborative: () => false,
    renameNote: async (_vault, _before, _after, fn) => fn(),
    deleteNote: async (_vault, _file, fn) => fn(),
  },
  writeCoalescer: { flushPending: async () => {} },
});
await store.setMediaBypass(vaultId, ["pdf", "docx", "xlsx", "pptx"], []);
const session = store.enrollDevice(vaultId, "Cross-device acceptance");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));
app.use("/api/sync/v1", createSyncRouter({
  store, token: randomBytes(48).toString("base64url"),
}));

// This endpoint tests the browser's built-in PDF renderer with an isolated
// fixture; the production IGNIS Web iframe is tested separately.
app.get("/pdf-device-preview", (_req, res) => {
  res.type("html").set("Cache-Control", "no-store").send(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>IGNIS isolated PDF preview</h1>
<iframe title="IGNIS acceptance PDF" src="/fixture/Acceptance.pdf" style="width:100%;height:76vh"></iframe>
<p><a href="/fixture/Acceptance.pdf">Open PDF directly</a></p>
</body></html>`
  );
});
app.get("/fixture/Acceptance.pdf", (_req, res) => {
  res.set("Cache-Control", "no-store").set("Content-Disposition", "inline; filename=\"Acceptance.pdf\"")
    .type("application/pdf")
    .sendFile(path.join(vault, "Documents", "Acceptance.pdf"));
});

const hosts = ["127.0.0.1", tailnetIps[0]];
const servers = [];
const ready = await Promise.all(hosts.map((host) => new Promise((resolve, reject) => {
  const server = app.listen(port, host);
  server.once("error", reject);
  server.once("listening", () => { servers.push(server); resolve(host); });
})));
const info = {
  url: `http://${tailnetIps[0]}:${port}/api/sync/v1`,
  localUrl: `http://127.0.0.1:${port}/api/sync/v1`,
  token: session.token,
  vaultId, port,
};
fs.writeFileSync(path.join(root, "session.json"), JSON.stringify(info),
  { flag: "wx", mode: 0o600 });
console.log("MEDIA_BYPASS_CROSS_DEVICE_READY=" + ready.join(",") + ":" + port);
console.log("FILES=md,pdf,docx,xlsx,pptx; SYNCTHING_NOT_REQUIRED");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all(servers.map((server) =>
    new Promise((resolve) => server.close(resolve))));
  store.close();
  if (fs.existsSync(path.join(root, "session.json"))) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("MEDIA_BYPASS_ISOLATED_TEST_CLEANED");
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
