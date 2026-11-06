// Exercises the actual Ignis HTTP/WebSocket server using an isolated temporary vault.
// Usage: npm run build && node scripts/collab-e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as Y from "yjs";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-collab-e2e-"));
const vaultRoot = path.join(temporary, "vaults");
const dataRoot = path.join(temporary, "data");
const vaultId = "Lab";
const vaultPath = path.join(vaultRoot, vaultId);
const note = path.join(vaultPath, "Shared.md");
const sockets = new Set();
let child;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function message(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 10000);

    function handler(raw) {
      const msg = JSON.parse(raw.toString());

      if (msg.channel === "collab" && msg.type === type && msg.path === "Shared.md") {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }

    ws.on("message", handler);
  });
}

function send(ws, type, payload = {}) {
  ws.send(JSON.stringify({ channel: "collab", type, path: "Shared.md", ...payload }));
}

async function poll(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out polling condition");
}

async function startServer(port) {
  child = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      VAULT_ROOT: vaultRoot,
      DATA_ROOT: dataRoot,
      OBSIDIAN_ASSETS_PATH:
        process.env.OBSIDIAN_ASSETS_PATH ||
        path.join(root, "investigation", "obsidian_1.14.4_unpacked"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  await poll(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Ignis terminated unexpectedly:\n${logs}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/vault/info`);
      return response.ok;
    } catch {
      return false;
    }
  });
}

async function stopServer() {
  for (const ws of sockets) {
    ws.terminate();
  }

  sockets.clear();

  if (child && child.exitCode === null) {
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await stopped;
  }

  child = null;
}

async function join(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?vault=Lab`);
  sockets.add(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const init = message(ws, "init");
  send(ws, "join");
  const initial = await init;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(initial.state, "base64"));
  return { ws, doc };
}

try {
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(note, "Initial\n", "utf-8");
  const port = await freePort();
  await startServer(port);

  const alice = await join(port);
  const bob = await join(port);
  const receiveAlice = message(alice.ws, "update");
  const receiveBob = message(bob.ws, "update");
  const beforeAlice = Y.encodeStateVector(alice.doc);
  const beforeBob = Y.encodeStateVector(bob.doc);

  alice.doc.getText("content").insert(0, "Alice ");
  bob.doc.getText("content").insert(0, "Bob ");
  send(alice.ws, "update", {
    update: Buffer.from(Y.encodeStateAsUpdate(alice.doc, beforeAlice)).toString("base64"),
  });
  send(bob.ws, "update", {
    update: Buffer.from(Y.encodeStateAsUpdate(bob.doc, beforeBob)).toString("base64"),
  });

  Y.applyUpdate(alice.doc, Buffer.from((await receiveAlice).update, "base64"));
  Y.applyUpdate(bob.doc, Buffer.from((await receiveBob).update, "base64"));
  const expected = alice.doc.getText("content").toString();

  assert(expected === bob.doc.getText("content").toString(), "Clients diverged");
  assert(expected.includes("Alice ") && expected.includes("Bob "), "Concurrent inserts lost");

  const ordinaryWrite = await fetch(`http://127.0.0.1:${port}/api/fs/writeFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: "Lab", path: "Shared.md", content: "STALE", encoding: "utf-8" }),
  });
  const acknowledgement = await ordinaryWrite.json();
  assert(acknowledgement.collaborative === true, "Stale autosave was not intercepted");

  await poll(async () => (await fs.readFile(note, "utf-8")) === expected);
  console.log("PASS: concurrent inserts converge, stale native writes are suppressed, Markdown saved");

  await stopServer();
  await startServer(port);
  const inactiveWrite = await fetch(`http://127.0.0.1:${port}/api/fs/writeFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: "Lab", path: "Shared.md", content: "LOST EDIT", encoding: "utf-8" }),
  });
  assert(inactiveWrite.status === 409, "Inactive CRDT note silently accepted a conventional write");
  assert((await inactiveWrite.json()).code === "COLLABORATIVE_WRITE_CONFLICT",
    "Server failed to explain the conflicting write");
  assert(await fs.readFile(note, "utf-8") === expected, "Inactive file write corrupted Markdown");
  console.log("PASS: inactive collaborative note rejects silent whole-file overwrite");
  const restored = await join(port);
  assert(restored.doc.getText("content").toString() === expected, "Saved CRDT state did not survive restart");
  console.log("PASS: full CRDT state survives process restart");

  const post = async (endpoint, body) => fetch(`http://127.0.0.1:${port}/api/fs/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: "Lab", ...body }),
  });
  const activeRename = await post("rename", {
    oldPath: "Shared.md", newPath: "Moved.md",
  });
  assert(activeRename.status === 409, "Active collaborative room allowed a destructive rename");
  const activeDelete = await fetch(`http://127.0.0.1:${port}/api/fs/unlink?vault=Lab&path=Shared.md`, {
    method: "DELETE",
  });
  assert(activeDelete.status === 409, "Active collaborative room allowed a destructive delete");
  console.log("PASS: active note rename/delete fail explicitly without losing edits");

  await stopServer();
  await startServer(port);
  const renamed = await post("rename", { oldPath: "Shared.md", newPath: "Moved.md" });
  assert(renamed.status === 200, `Inactive collaborative rename failed: ${renamed.status}`);
  const renamedBack = await post("rename", { oldPath: "Moved.md", newPath: "Shared.md" });
  assert(renamedBack.status === 200, "Inactive collaborative rename back to original path failed");
  assert(await fs.readFile(note, "utf-8") === expected, "Rename altered collaborative note body");
  console.log("PASS: historical CRDT state follows inactive note renames");

  const deleted = await fetch(`http://127.0.0.1:${port}/api/fs/unlink?vault=Lab&path=Shared.md`, {
    method: "DELETE",
  });
  assert(deleted.status === 200, `Inactive collaborative delete failed: ${deleted.status}`);
  await fs.writeFile(note, "Brand-new unrelated note\n");
  const staleAfterRecreate = await fetch(`http://127.0.0.1:${port}/api/fs/writeFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: "Lab", path: "Shared.md", content: "STALE SNAPSHOT", encoding: "utf-8" }),
  });
  assert(staleAfterRecreate.status === 409,
    "Recreated note accepted an old-generation native whole-file autosave");
  const recreated = await join(port);
  assert(recreated.doc.getText("content").toString() === "Brand-new unrelated note\n",
    "Deleted note's CRDT history contaminated the new note");
  console.log("PASS: deleting then recreating the same note path does not resurrect old CRDT text");
  await stopServer();
} finally {
  await stopServer();
  await fs.rm(temporary, { recursive: true, force: true });
}
