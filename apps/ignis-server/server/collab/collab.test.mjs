import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const Y = require("yjs");
const { WebSocket } = require("ws");
const { setupWebSocket } = require("../../../../packages/server-core/src/ws.js");
const watcher = require("../../../../packages/server-core/src/watcher.js");
const {
  applyTextChange,
  createCollaborationManager,
  normalizeNotePath,
} = require("./index.js");

describe("collaboration room", () => {
  let root;
  let vaultPath;
  let server;
  let wss;
  let manager;
  let url;
  let clients;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ignis-collab-"));
    vaultPath = path.join(root, "vault");
    await fs.promises.mkdir(vaultPath);
    await fs.promises.writeFile(path.join(vaultPath, "test.md"), "Start\n");

    server = http.createServer();
    wss = setupWebSocket(server, {
      getVaultPath: (id) => (id === "test" ? vaultPath : null),
    });
    manager = createCollaborationManager({
      wss,
      getVaultPath: (id) => (id === "test" ? vaultPath : null),
      dataRoot: path.join(root, "data"),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${server.address().port}/ws?vault=test`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) {
      client.terminate();
    }

    await manager.flushAll();
    await watcher._reset();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function connect() {
    const client = new WebSocket(url);
    clients.push(client);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    return client;
  }

  function waitFor(ws, type, file = "test.md") {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", listener);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 4000);

      function listener(raw) {
        const msg = JSON.parse(raw.toString());

        if (msg.channel === "collab" && msg.type === type && msg.path === file) {
          clearTimeout(timeout);
          ws.off("message", listener);
          resolve(msg);
        }
      }

      ws.on("message", listener);
    });
  }

  async function join(ws) {
    const response = waitFor(ws, "init");
    ws.send(JSON.stringify({ channel: "collab", type: "join", path: "test.md" }));
    const data = await response;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(data.state, "base64"));
    return doc;
  }

  it("merges independent simultaneous insertions and persists the result", async () => {
    const a = await connect();
    const b = await connect();
    const da = await join(a);
    const db = await join(b);
    const fromB = waitFor(a, "update");
    const fromA = waitFor(b, "update");

    const initialA = Y.encodeStateVector(da);
    const initialB = Y.encodeStateVector(db);
    da.getText("content").insert(0, "Alpha ");
    db.getText("content").insert(0, "Beta ");
    const changeA = Y.encodeStateAsUpdate(da, initialA);
    const changeB = Y.encodeStateAsUpdate(db, initialB);

    a.send(JSON.stringify({ channel: "collab", type: "update", path: "test.md", update: Buffer.from(changeA).toString("base64") }));
    b.send(JSON.stringify({ channel: "collab", type: "update", path: "test.md", update: Buffer.from(changeB).toString("base64") }));

    Y.applyUpdate(da, Buffer.from((await fromB).update, "base64"));
    Y.applyUpdate(db, Buffer.from((await fromA).update, "base64"));
    expect(da.getText("content").toString()).toBe(db.getText("content").toString());

    const merged = da.getText("content").toString();
    expect(merged).toContain("Alpha ");
    expect(merged).toContain("Beta ");
    expect(merged).toContain("Start\n");

    await manager.flushAll();
    expect(await fs.promises.readFile(path.join(vaultPath, "test.md"), "utf-8")).toBe(merged);
    expect((await fs.promises.readdir(path.join(root, "data", "collaboration"))).length).toBe(1);
  });

  it("rejects a traversal and ignores updates from clients who have not joined", async () => {
    const a = await connect();
    const error = waitFor(a, "error", "../secrets.md");
    a.send(JSON.stringify({ channel: "collab", type: "join", path: "../secrets.md" }));
    expect((await error).error).toBe("Unable to join note");

    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Malicious");
    a.send(JSON.stringify({ channel: "collab", type: "update", path: "test.md", update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await fs.promises.readFile(path.join(vaultPath, "test.md"), "utf-8")).toBe("Start\n");
  });

  it("reconciles external text while retaining CRDT identity", async () => {
    expect(normalizeNotePath("/folder/note.md")).toBe("folder/note.md");
    expect(normalizeNotePath("folder/note.png")).toBe(null);
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "abc");
    applyTextChange(text, "abc", "abXYZc", "external");
    expect(text.toString()).toBe("abXYZc");
  });

  it("tracks distinct named cursors, selections, and removes departed peers", async () => {
    const alice = await connect();
    const bob = await connect();
    const aReady = waitFor(alice, "init");
    alice.send(JSON.stringify({ channel: "collab", type: "join", path: "test.md", name: "Alice" }));
    const aInfo = await aReady;
    const aPresence = waitFor(alice, "presence");
    const bReady = waitFor(bob, "init");
    bob.send(JSON.stringify({ channel: "collab", type: "join", path: "test.md", name: "Bob" }));
    const bInfo = await bReady;
    const nowPresent = await aPresence;

    expect(aInfo.self.name).toBe("Alice");
    expect(bInfo.self.name).toBe("Bob");
    expect(aInfo.self.id).not.toBe(bInfo.self.id);
    expect(aInfo.self.color).not.toBe(bInfo.self.color);
    expect(nowPresent.people).toHaveLength(2);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(aInfo.state, "base64"));
    const text = doc.getText("content");
    const relative = (offset) => Buffer.from(Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, offset),
    )).toString("base64");
    const cursor = waitFor(bob, "cursor");
    alice.send(JSON.stringify({
      channel: "collab", type: "cursor", path: "test.md",
      anchor: relative(1), head: relative(4),
    }));
    const received = await cursor;
    expect(received.id).toBe(aInfo.self.id);
    expect(received.anchor).toBe(relative(1));
    expect(received.head).toBe(relative(4));

    const updated = waitFor(bob, "presence");
    alice.send(JSON.stringify({ channel: "collab", type: "identity", path: "test.md", name: "Alice New" }));
    const list = await updated;
    expect(list.people.find((person) => person.id === aInfo.self.id).name).toBe("Alice New");

    const left = waitFor(bob, "presence");
    alice.send(JSON.stringify({ channel: "collab", type: "leave", path: "test.md" }));
    const reduced = await left;
    expect(reduced.people).toHaveLength(1);
    expect(reduced.people[0].id).toBe(bInfo.self.id);
  });
});
