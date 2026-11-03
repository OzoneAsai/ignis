import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";

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
    const savedFiles = await fs.promises.readdir(path.join(root, "data", "collaboration"));
    expect(savedFiles.filter((name) => name.endsWith(".yjs"))).toHaveLength(1);
    expect(savedFiles.filter((name) => name.endsWith(".baseline.json"))).toHaveLength(1);
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

  it("does not claim remote sync until the canonical Markdown file is durable", async () => {
    const ws = await connect();
    const doc = await join(ws);
    const before = Y.encodeStateVector(doc);
    doc.getText("content").insert(0, "Saved ");
    const saved = waitFor(ws, "saved");
    ws.send(JSON.stringify({
      channel: "collab", type: "update", path: "test.md", seq: 71,
      update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
    }));

    const confirmation = await saved;
    expect(confirmation.seq).toBe(71);
    expect(await fs.promises.readFile(path.join(vaultPath, "test.md"), "utf-8"))
      .toBe("Saved Start\n");

    const unchanged = waitFor(ws, "saved");
    ws.send(JSON.stringify({
      channel: "collab", type: "update", path: "test.md", seq: 72,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    }));
    expect((await unchanged).seq).toBe(72);
  });

  it("recovers a Yjs update committed before a crash without reverting to stale Markdown", async () => {
    const room = await manager.openRoom("test", "test.md");
    room.text.insert(0, "Initial saved ");
    await manager.flushAll();
    const directory = path.join(root, "data", "collaboration");
    const fileName = (await fs.promises.readdir(directory)).find((name) => name.endsWith(".yjs"));
    const sidecar = path.join(directory, fileName);
    const afterCrash = new Y.Doc();
    Y.applyUpdate(afterCrash, await fs.promises.readFile(sidecar));
    afterCrash.getText("content").insert(0, "CRASH RECOVERY ");
    // Simulate the crash window: CRDT snapshot written; Markdown and the
    // commit watermark still contain the preceding successfully saved text.
    await fs.promises.writeFile(sidecar, Y.encodeStateAsUpdate(afterCrash));

    const recreated = createCollaborationManager({
      wss,
      getVaultPath: (id) => (id === "test" ? vaultPath : null),
      dataRoot: path.join(root, "data"),
    });
    const reopened = await recreated.openRoom("test", "test.md");
    expect(reopened.text.toString()).toBe("CRASH RECOVERY Initial saved Start\n");
    expect(await fs.promises.readFile(path.join(vaultPath, "test.md"), "utf-8"))
      .toBe(reopened.text.toString());
  });

  it("treats a disk change after the last successful watermark as an independent edit", async () => {
    const room = await manager.openRoom("test", "test.md");
    room.text.insert(0, "Collaborative ");
    await manager.flushAll();
    const external = "External Collaborative Start\n";
    await fs.promises.writeFile(path.join(vaultPath, "test.md"), external);
    const recreated = createCollaborationManager({
      wss,
      getVaultPath: (id) => (id === "test" ? vaultPath : null),
      dataRoot: path.join(root, "data"),
    });
    const reopened = await recreated.openRoom("test", "test.md");
    expect(reopened.text.toString()).toBe(external);
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

    const away = waitFor(bob, "cursor");
    alice.send(JSON.stringify({ channel: "collab", type: "cursor-away", path: "test.md" }));
    const cleared = await away;
    expect(cleared.id).toBe(aInfo.self.id);
    expect(cleared.anchor).toBeNull();
    expect(cleared.head).toBeNull();

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

  function historyPath(notePath) {
    const name = crypto.createHash("sha256")
      .update(JSON.stringify(["test", notePath])).digest("hex");
    return path.join(root, "data", "collaboration", `${name}.yjs`);
  }

  async function createHistoricalState(notePath, content = "Start\n") {
    const note = new Y.Doc();
    note.getText("content").insert(0, content);
    const sidecar = historyPath(notePath);
    await fs.promises.mkdir(path.dirname(sidecar), { recursive: true });
    await fs.promises.writeFile(sidecar, Y.encodeStateAsUpdate(note));
    await fs.promises.writeFile(`${sidecar}.baseline.json`, JSON.stringify({
      digest: crypto.createHash("sha256").update(content).digest("hex"),
    }));
    note.destroy();
  }

  it("migrates CRDT history with an inactive note rename instead of losing revisions", async () => {
    await createHistoricalState("test.md");
    const before = path.join(vaultPath, "test.md");
    const after = path.join(vaultPath, "new-title.md");
    await manager.renameNote("test", "test.md", "new-title.md",
      () => fs.promises.rename(before, after),
      () => fs.promises.rename(after, before));

    await expect(fs.promises.stat(historyPath("test.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.promises.stat(historyPath("new-title.md"))).isFile()).toBe(true);
    expect((await fs.promises.stat(`${historyPath("new-title.md")}.baseline.json`)).isFile()).toBe(true);
    expect((await manager.openRoom("test", "new-title.md")).text.toString()).toBe("Start\n");
  });

  it("removes historical state on deletion so a recreated note has fresh identity", async () => {
    await createHistoricalState("test.md");
    const note = path.join(vaultPath, "test.md");
    await manager.deleteNote("test", "test.md", () => fs.promises.unlink(note));
    expect(fs.existsSync(historyPath("test.md"))).toBe(false);
    expect(fs.existsSync(`${historyPath("test.md")}.baseline.json`)).toBe(false);
    await fs.promises.writeFile(note, "Unrelated new note\n");
    const fresh = await manager.openRoom("test", "test.md");
    expect(fresh.text.toString()).toBe("Unrelated new note\n");
  });

  it("refuses to rename a note currently joined by another participant", async () => {
    const client = await connect();
    await join(client);
    await expect(manager.renameNote("test", "test.md", "moved.md",
      () => fs.promises.rename(path.join(vaultPath, "test.md"), path.join(vaultPath, "moved.md"))))
      .rejects.toMatchObject({ code: "COLLABORATIVE_FILE_OPERATION_CONFLICT" });
    expect(fs.existsSync(path.join(vaultPath, "test.md"))).toBe(true);
  });

  it("rejects a directory move containing historical collaborative notes", async () => {
    const directory = path.join(vaultPath, "notes");
    await fs.promises.mkdir(directory);
    await fs.promises.writeFile(path.join(directory, "older.md"), "Earlier\n");
    await createHistoricalState("notes/older.md", "Earlier\n");
    await expect(manager.assertSafeSubtree("test", "notes", directory))
      .rejects.toMatchObject({ code: "COLLABORATIVE_FILE_OPERATION_CONFLICT" });
  });

  it("locks the identity path during a long rename operation", async () => {
    let begin;
    let finish;
    const underway = new Promise((resolve) => { begin = resolve; });
    const held = new Promise((resolve) => { finish = resolve; });
    const operation = manager.renameNote("test", "test.md", "moved.md", async () => {
      begin();
      await held;
      await fs.promises.rename(path.join(vaultPath, "test.md"), path.join(vaultPath, "moved.md"));
    });
    await underway;
    await expect(manager.openRoom("test", "test.md"))
      .rejects.toMatchObject({ code: "COLLABORATIVE_FILE_OPERATION_CONFLICT" });
    finish();
    await operation;
    expect(fs.existsSync(path.join(vaultPath, "moved.md"))).toBe(true);
  });
});
