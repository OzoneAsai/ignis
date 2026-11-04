import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";

import { NativeYjs, encodeYjs, decodeYjs } from "./live.ts";

function makeView(path, value) {
  let content = value;
  let currentPath = path;
  const view = {
    dom: { isConnected: false },
    composing: false,
    state: {
      field: () => ({ file: { path: currentPath } }),
      doc: { toString: () => content }
    },
    dispatch: () => {}
  };
  return {
    view, set(value) { content = value; },
    setPath(next) { currentPath = next; }
  };
}

function serverInit(path, id, text) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const message = {
    channel: "collab", type: "init", path, documentId: id,
    state: encodeYjs(Y.encodeStateAsUpdate(doc))
  };
  doc.destroy();
  return message;
}

const ID = "00000000-0000-4000-8000-000000000001";
const NEW_ID = "00000000-0000-4000-8000-000000000002";
const testInstances = [];

function harness(initialId = null, value = "Initial") {
  const sent = [], notices = [];
  const origin = "https://example.test/" + crypto.randomUUID();
  const ids = initialId ? { "test.md": initialId } : {};
  const manager = new NativeYjs({
    vaultId: () => "lab",
    origin: () => origin,
    pathForView: (view) => view.state.field().file?.path || null,
    knownId: (path) => ids[path] || null,
    rememberId: async (path, id) => { ids[path] = id; },
    send: (m) => { sent.push(m); },
    notify: (path, status) => { notices.push({ path, status }); }
  });
  const view = makeView("test.md", value);
  manager.observe(view.view);
  testInstances.push(manager);
  return { manager, view, ids, sent, notices };
}

afterEach(async () => {
  for (const instance of testInstances.splice(0)) await instance.dispose();
});

describe("Native Obsidian offline Yjs bridge", () => {
  it("joins with the server identity, sends full state and local operations", async () => {
    const s = harness();
    s.manager.connected();
    expect(s.sent.find((m) => m.type === "join")).toMatchObject({ path: "test.md" });
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    expect(s.ids["test.md"]).toBe(ID);
    const joined = s.manager.rooms.get("test.md");
    expect(joined.hydrated).toBe(true);
    expect(joined.joined).toBe(true);
    const full = s.sent.find((m) => m.type === "update");
    expect(full.seq).toBe(1);
    const target = new Y.Doc();
    Y.applyUpdate(target, decodeYjs(full.update));
    expect(target.getText("content").toString()).toBe("Initial");
    target.destroy();
    joined.text.insert(joined.text.length, " + native");
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(2);
    expect(s.sent.at(-1).seq).toBe(2);
    await s.manager.handle({
      channel: "collab", type: "saved", path: "test.md", seq: 2
    });
    expect(s.notices.at(-1).status).toMatch(/persisted/);
  });

  it("retains local Yjs edits while disconnected, then merges remote edits on reconnect", async () => {
    const s = harness();
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    const before = s.sent.length;
    s.manager.disconnected();
    room.text.insert(room.text.length, " local");
    expect(s.sent).toHaveLength(before);
    // Simulate the native editor autosave that Obsidian performs.
    s.view.set("Initial local");
    const other = new Y.Doc();
    Y.applyUpdate(other, decodeYjs(s.sent.find((x) => x.type === "update").update));
    other.getText("content").insert(0, "remote ");
    s.manager.connected();
    await s.manager.handle({
      channel: "collab", type: "init", path: "test.md", documentId: ID,
      state: encodeYjs(Y.encodeStateAsUpdate(other))
    });
    expect(room.text.toString()).toBe("remote Initial local");
    const outbound = s.sent.filter((x) => x.type === "update").at(-1);
    Y.applyUpdate(other, decodeYjs(outbound.update));
    expect(other.getText("content").toString()).toBe("remote Initial local");
    other.destroy();
  });

  it("rejects a recreated note and cannot replay the old generation", async () => {
    const s = harness();
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    s.manager.disconnected();
    room.text.insert(0, "Offline ");
    s.view.set("Offline Initial");
    s.manager.connected();
    const lengthBefore = s.sent.filter((x) => x.type === "update").length;
    await s.manager.handle(serverInit("test.md", NEW_ID, "Replacement"));
    expect(room.blocked).toBe(true);
    expect(room.text.toString()).toBe("Offline Initial");
    expect(s.sent.filter((x) => x.type === "update")).toHaveLength(lengthBefore);
    expect(s.notices.at(-1).status).toMatch(/replaced/);
    expect(s.ids["test.md"]).toBe(ID);
  });

  it("refuses to overwrite an unsynced native editor on first connection", async () => {
    const s = harness(null, "Unsent native draft");
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Remote text"));
    const room = s.manager.rooms.get("test.md");
    expect(room.blocked).toBe(true);
    expect(s.view.view.state.doc.toString()).toBe("Unsent native draft");
    expect(s.sent.filter((x) => x.type === "update")).toHaveLength(0);
    expect(s.notices.at(-1).status).toMatch(/not merged/);
  });

  it("defers remote state while an IME composition is active", async () => {
    const s = harness();
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    s.manager.setComposing(s.view.view, true);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, decodeYjs(
      s.sent.find((x) => x.type === "update").update
    ));
    remote.getText("content").insert(0, "日本語");
    await s.manager.handle({
      channel: "collab", type: "update", path: "test.md",
      update: encodeYjs(Y.encodeStateAsUpdate(remote))
    });
    expect(room.text.toString()).toBe("Initial");
    s.manager.setComposing(s.view.view, false);
    expect(room.text.toString()).toBe("日本語Initial");
    remote.destroy();
  });
  it("carries an offline CRDT generation across a native file rename", async () => {
    const s = harness();
    s.manager.connected();
    const initialServerState = serverInit("test.md", ID, "Initial");
    await s.manager.handle(initialServerState);
    const room = s.manager.rooms.get("test.md");
    s.manager.disconnected();
    room.text.insert(room.text.length, " draft");
    s.view.set("Initial draft");
    s.view.setPath("moved.md");
    expect(s.manager.relocate("test.md", "moved.md")).toBe(true);
    expect(s.manager.rooms.get("moved.md")).toBe(room);
    expect(s.manager.rooms.has("test.md")).toBe(false);
    expect(room.text.toString()).toBe("Initial draft");
    const oldUpdateCount = s.sent.filter((m) => m.type === "update").length;
    s.manager.connected();
    // A rename relocates the *same* Yjs history, not a separately initialized
    // Y.Doc with an unrelated client ID.
    await s.manager.handle({ ...initialServerState, path: "moved.md" });
    expect(room.joined).toBe(true);
    expect(room.blocked).toBe(false);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(oldUpdateCount + 1);
    const merged = new Y.Doc();
    Y.applyUpdate(merged, decodeYjs(s.sent.at(-1).update));
    expect(merged.getText("content").toString()).toBe("Initial draft");
    merged.destroy();
  });
  it("sends an initial full-state ACK only after composition is committed", async () => {
    const s = harness();
    s.manager.connected();
    s.manager.setComposing(s.view.view, true);
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    expect(room.pendingHandshake).toBe(true);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(0);
    s.manager.setComposing(s.view.view, false);
    expect(room.pendingHandshake).toBe(false);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(1);
  });
});
