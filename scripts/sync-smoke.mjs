// Isolated end-to-end smoke test: no installed Ignis or real Vault is touched.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-sync-smoke-"));
const token = crypto.randomBytes(32).toString("hex");
const vaultRoot = path.join(root, "vaults");
const vault = path.join(vaultRoot, "lab");
const dataRoot = path.join(root, "state");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
fs.mkdirSync(dataRoot);
fs.writeFileSync(path.join(vault, "alpha.md"), "hello");
const portServer = net.createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const { port } = portServer.address();
await new Promise((resolve) => portServer.close(resolve));
const base = "http://127.0.0.1:" + port;
let child = null;
let output = "";
let socket = null;

async function launch() {
  child = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), IGNIS_BIND_HOST: "127.0.0.1",
      VAULT_ROOT: vaultRoot, DATA_ROOT: dataRoot,
      OBSIDIAN_ASSETS_PATH: path.join(root, "nonexistent"),
      IGNIS_SYNC_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Server crashed: " + output);
    try {
      const r = await fetch(base + "/api/sync/v1/capabilities");
      if (r.ok) return;
    } catch { /* server not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start: " + output);
}

async function stop() {
  socket?.close();
  socket = null;
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  child = null;
}

async function request(url, options = {}) {
  return fetch(base + url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
}

async function recv(ws, pred) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const event = await Promise.race([
      once(ws, "message").then(([data]) => JSON.parse(data.toString())),
      new Promise((_, reject) => setTimeout(() => reject(new Error("WS timeout")), 4000))
    ]);
    if (pred(event)) return event;
  }
  throw new Error("Expected WS event not found");
}

try {
  await launch();
  const denied = await fetch(base + "/api/sync/v1/vaults/lab/manifest");
  assert.equal(denied.status, 401, "read API rejects missing auth");
  const initial = await request("/api/sync/v1/vaults/lab/manifest");
  assert.equal(initial.status, 200, await initial.text());
  // fetch response body can only be consumed once; retrieve it separately.
  const manifest = await (await request("/api/sync/v1/vaults/lab/manifest")).json();
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, "alpha.md");
  assert.equal(manifest.vaultSeq, 1);

  socket = new WebSocket("ws://127.0.0.1:" + port + "/ws?vault=lab");
  await once(socket, "open");
  socket.send(JSON.stringify({ channel: "sync", type: "auth", token }));
  const ready = await recv(socket, (msg) => msg.channel === "sync" && msg.type === "ready");
  assert.equal(ready.vaultSeq, 1);
  const op = {
    type: "create", path: "beta.md", content: "created",
    opId: crypto.randomUUID()
  };
  const notificationPromise = recv(socket,
    (msg) => msg.channel === "sync" && msg.type === "changed");
  const create = await request("/api/sync/v1/vaults/lab/operations", {
    method: "POST", body: JSON.stringify(op)
  });
  assert.equal(create.status, 200, await create.text());
  const created = await (await request("/api/sync/v1/vaults/lab/operations", {
    method: "POST", body: JSON.stringify(op)
  })).json();
  assert.equal(created.seq, 2, "idempotent retry returns first result");
  const notification = await notificationPromise;
  assert.equal(notification.vaultSeq, 2);
  const delta = await (await request("/api/sync/v1/vaults/lab/changes?since=1")).json();
  assert.equal(delta.changes.length, 1);
  const body = await (await request(
    "/api/sync/v1/vaults/lab/files/" + created.fileId)).text();
  assert.equal(body, "created");
  const stale = await request("/api/sync/v1/vaults/lab/operations", {
    method: "POST",
    body: JSON.stringify({ type: "modify", opId: crypto.randomUUID(),
      path: "beta.md", fileId: created.fileId,
      generationId: created.generationId, baseHash: "wrong", content: "overwrite" })
  });
  assert.equal(stale.status, 409);
  assert.equal(fs.readFileSync(path.join(vault, "beta.md"), "utf8"), "created");
  await stop();
  await launch();
  const reboot = await (await request("/api/sync/v1/vaults/lab/manifest")).json();
  assert.equal(reboot.vaultSeq, 2);
  assert.equal(reboot.files.find((f) => f.path === "beta.md").fileId, created.fileId);
  console.log("Sync smoke passed: auth, journal, WSS, idempotency, conflict, reboot");
} catch (e) {
  console.error("Sync smoke failed:", e.message);
  console.error(output.slice(-6000));
  process.exitCode = 1;
} finally {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
}
