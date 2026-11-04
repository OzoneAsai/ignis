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
import * as Y from "yjs";

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

async function recv(ws, pred, label = "WS event") {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("WS timeout: " + label));
    }, 4000);
    function onMessage(data) {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (!pred(event)) return;
      clearTimeout(deadline);
      ws.off("message", onMessage);
      resolve(event);
    }
    ws.on("message", onMessage);
  });
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
  // Both Sync and Yjs now share one document generation. A native client
  // joining the existing collaboration channel must observe the SAME ID
  // as the Vault manifest, not a second randomly generated generation.
  const initWait = recv(socket,
    (msg) => msg.channel === "collab" && msg.type === "init" &&
      msg.path === "alpha.md", "collab init");
  socket.send(JSON.stringify({
    channel: "collab", type: "join", path: "alpha.md"
  }));
  const init = await initWait;
  assert.equal(init.documentId, manifest.files[0].generationId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(init.state, "base64"));
  assert.equal(doc.getText("content").toString(), "hello");
  const stateVector = Y.encodeStateVector(doc);
  doc.getText("content").insert(5, " via CRDT");
  const savedWait = recv(socket,
    (msg) => msg.channel === "collab" && msg.type === "saved" &&
      msg.path === "alpha.md" && msg.seq === 42, "collab saved");
  socket.send(JSON.stringify({
    channel: "collab", type: "update", path: "alpha.md",
    seq: 42,
    update: Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)).toString("base64")
  }));
  await savedWait;
  assert.equal(fs.readFileSync(path.join(vault, "alpha.md"), "utf8"), "hello via CRDT");
  const collaborationSaved = await (
    await request("/api/sync/v1/vaults/lab/manifest")
  ).json();
  assert.equal(collaborationSaved.files[0].generationId, init.documentId);
  assert.equal(collaborationSaved.files[0].fileId, manifest.files[0].fileId);
  assert.equal(collaborationSaved.vaultSeq, 2,
    "Yjs durability ACK requires the matching Vault journal entry");
  const crdtDelta = await (
    await request("/api/sync/v1/vaults/lab/changes?since=1")
  ).json();
  assert.deepEqual(crdtDelta.changes.map((x) => x.type), ["modify"]);
  doc.destroy();
  socket.send(JSON.stringify({
    channel: "collab", type: "leave", path: "alpha.md"
  }));
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
  assert.equal(created.seq, 3, "idempotent retry returns first result");
  const notification = await notificationPromise;
  assert.equal(notification.vaultSeq, 3);
  const delta = await (await request("/api/sync/v1/vaults/lab/changes?since=2")).json();
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
  const attachment = Buffer.from([0, 255, 137, 80, 78, 71, 0, 10, 13, 26]);
  const assetOp = {
    type: "create", path: "media/picture.png",
    contentBase64: attachment.toString("base64"), opId: crypto.randomUUID()
  };
  const assetResponse = await request("/api/sync/v1/vaults/lab/operations", {
    method: "POST", body: JSON.stringify(assetOp)
  });
  assert.equal(assetResponse.status, 200);
  const asset = await assetResponse.json();
  assert.equal(asset.seq, 4);
  assert.deepEqual(
    fs.readFileSync(path.join(vault, "media", "picture.png")), attachment);
  const downloaded = Buffer.from(await (
    await request("/api/sync/v1/vaults/lab/files/" + asset.fileId)
  ).arrayBuffer());
  assert.deepEqual(downloaded, attachment);
  const updatedAsset = Buffer.from([0, 254, 80, 78, 71, 1, 13, 10]);
  const changedAsset = await request("/api/sync/v1/vaults/lab/operations", {
    method: "POST",
    body: JSON.stringify({
      type: "modify", path: "media/picture.png",
      fileId: asset.fileId, generationId: asset.generationId,
      baseHash: asset.hash, contentBase64: updatedAsset.toString("base64"),
      opId: crypto.randomUUID()
    })
  });
  assert.equal(changedAsset.status, 200);
  assert.equal((await changedAsset.json()).seq, 5);

  // A mobile device can rename the same tracked file twice while offline.
  // Replaying each durable path transition must preserve the original
  // fileId/generation and the idempotent operation receipts.
  const chained = [
    { type: "rename", path: "beta.md", toPath: "gamma.md" },
    { type: "rename", path: "gamma.md", toPath: "delta.md" },
    { type: "delete", path: "delta.md" }
  ];
  for (let i = 0; i < chained.length; i++) {
    const operation = {
      ...chained[i], fileId: created.fileId,
      generationId: created.generationId,
      baseHash: created.hash, opId: crypto.randomUUID()
    };
    const send = () => request("/api/sync/v1/vaults/lab/operations", {
      method: "POST", body: JSON.stringify(operation)
    });
    const response = await send();
    assert.equal(response.status, 200, "chained mutation must succeed");
    const receipt = await response.json();
    assert.equal(receipt.seq, 6 + i);
    assert.equal(receipt.opId, operation.opId);
    assert.equal((await (await send()).json()).seq, receipt.seq,
      "a retry cannot create a second change");
  }
  assert.equal(fs.existsSync(path.join(vault, "beta.md")), false);
  assert.equal(fs.existsSync(path.join(vault, "gamma.md")), false);
  assert.equal(fs.existsSync(path.join(vault, "delta.md")), false);

  // An authenticated client must not force a huge out-of-band file into RAM
  // through a preview GET: the 4 MiB mobile bound is checked at the server.
  fs.writeFileSync(path.join(vault, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
  const oversizedManifest = await (
    await request("/api/sync/v1/vaults/lab/manifest")
  ).json();
  const oversized = oversizedManifest.files.find((f) => f.path === "large.bin");
  assert.ok(oversized);
  assert.equal((await request(
    "/api/sync/v1/vaults/lab/files/" + oversized.fileId
  )).status, 413);

  await stop();
  await launch();
  const reboot = await (await request("/api/sync/v1/vaults/lab/manifest")).json();
  assert.equal(reboot.vaultSeq, 9);
  assert.equal(reboot.files.some((f) => f.fileId === created.fileId), false);
  assert.equal(reboot.files.find((f) => f.path === "media/picture.png").fileId, asset.fileId);
  assert.deepEqual(fs.readFileSync(path.join(vault, "media", "picture.png")), updatedAsset);
  assert.equal(reboot.files.find((f) => f.path === "alpha.md").generationId,
    init.documentId);
  console.log("Sync smoke passed: shared Yjs/Sync generation, persisted CRDT ACK, binary attachments, chained offline renames/deletion, bounded download, auth, WSS, idempotency, conflicts, reboot");
} catch (e) {
  console.error("Sync smoke failed:", e.message);
  console.error(output.slice(-6000));
  process.exitCode = 1;
} finally {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
}
