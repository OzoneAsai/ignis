import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.useRealTimers();
  for (const instance of testInstances.splice(0)) await instance.dispose();
});

describe("Native Obsidian offline Yjs bridge", () => {
  it("distinguishes local editor attachment, server ACK, reconnection and block state", async () => {
    const s = harness();
    expect(s.manager.saveState()).toMatchObject({
      online: false, active: 1, reconnecting: 1, awaitingServer: 0, blocked: 0
    });
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    expect(s.manager.saveState()).toMatchObject({
      online: true, active: 1, reconnecting: 0, awaitingServer: 1, blocked: 0
    });
    const room = s.manager.rooms.get("test.md");
    await s.manager.handle({
      channel: "collab", type: "saved", path: "test.md", seq: room.sentSeq
    });
    expect(s.manager.saveState().awaitingServer).toBe(0);
    room.blocked = true;
    expect(s.manager.saveState().blocked).toBe(1);
    s.manager.disconnected();
    expect(s.manager.saveState().online).toBe(false);
  });
  it("broadcasts a display-name change through identity frames without rejoining or changing Yjs history", async () => {
    const sent = [];
    let name = "Obsidian Native";
    const manager = new NativeYjs({
      vaultId: () => "lab",
      origin: () => "https://example.test/" + crypto.randomUUID(),
      pathForView: () => "test.md",
      knownId: () => null,
      rememberId: async () => {},
      displayName: () => name,
      send: frame => sent.push(frame),
      notify: () => {}
    });
    const view = makeView("test.md", "Initial");
    manager.observe(view.view);
    testInstances.push(manager);
    manager.connected();
    await manager.handle(serverInit("test.md", ID, "Initial"));
    const oldDoc = manager.rooms.get("test.md").doc;
    const joinCount = sent.filter(x => x.type === "join").length;
    name = "Yui 👋";
    manager.updateDisplayName();
    expect(sent.at(-1)).toMatchObject({
      channel: "collab", type: "identity", path: "test.md",
      documentId: ID, name: "Yui 👋"
    });
    expect(sent.filter(x => x.type === "join")).toHaveLength(joinCount);
    expect(manager.rooms.get("test.md").doc).toBe(oldDoc);
  });
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

  it("retries an uncommitted Yjs save with the complete state and backoff", async () => {
    const s = harness();
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    vi.useFakeTimers();
    await s.manager.handle({
      channel: "collab", type: "save-error", path: "test.md",
      seq: 1, error: "Temporary disk failure"
    });
    expect(room.retryCount).toBe(1);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(2);
    expect(s.sent.filter((m) => m.type === "update").at(-1).seq).toBe(2);
    await s.manager.handle({
      channel: "collab", type: "saved", path: "test.md", seq: 2
    });
    expect(room.retryCount).toBe(0);
    expect(room.retryTimer).toBeNull();
  });

  it("blocks an oversize update rather than sending broken partial Yjs history", async () => {
    const s = harness();
    s.manager.connected();
    await s.manager.handle(serverInit("test.md", ID, "Initial"));
    const room = s.manager.rooms.get("test.md");
    const before = s.sent.filter((m) => m.type === "update").length;
    const large = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(32000);
    room.text.insert(room.text.length, large);
    expect(room.text.toString()).toBe("Initial" + large);
    expect(room.blocked).toBe(true);
    expect(room.joined).toBe(false);
    expect(s.sent.filter((m) => m.type === "update")).toHaveLength(before);
    expect(s.sent.at(-1)).toMatchObject({
      channel: "collab", type: "leave", path: "test.md"
    });
    expect(s.notices.at(-1).status).toMatch(/retained on device/);
  });
});
