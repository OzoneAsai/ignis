// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncFacet, yUndoManagerKeymap } from "y-codemirror.next";
import { NativeYjs, encodeYjs, decodeYjs } from "./live.ts";

globalThis.ResizeObserver ||= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ID = "00000000-0000-4000-8000-000000000001";
let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  document.body.replaceChildren();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function mount() {
  const sent = [], notifications = [], ids = {};
  let currentPath = "test.md";
  const manager = new NativeYjs({
    vaultId: () => "lab",
    origin: () => "https://example.test/" + crypto.randomUUID(),
    pathForView: () => currentPath,
    knownId: (path) => ids[path] || null,
    rememberId: async (path, id) => { ids[path] = id; },
    send: (message) => sent.push(message),
    notify: (path, status) => notifications.push({ path, status })
  });
  const mountpoint = document.createElement("div");
  document.body.appendChild(mountpoint);
  const editor = new EditorView({
    parent: mountpoint,
    state: EditorState.create({ doc: "Initial", extensions: manager.extension() })
  });
  cleanup.push(async () => {
    editor.destroy();
    await manager.dispose();
  });
  const server = new Y.Doc();
  server.getText("content").insert(0, "Initial");
  manager.connected();
  await manager.handle({
    channel: "collab", type: "init", path: "test.md", documentId: ID,
    state: encodeYjs(Y.encodeStateAsUpdate(server))
  });
  await tick();
  return {
    manager, editor, sent, notifications, server,
    renamePath(to) {
      const from = currentPath;
      currentPath = to;
      manager.relocate(from, to);
      editor.dispatch({});
    }
  };
}

describe("real CodeMirror 6 native binding", () => {
  it("keeps the same bound CM6 Y.Doc through a native file rename", async () => {
    const { manager, editor, sent, server, renamePath } = await mount();
    editor.dispatch({ changes: { from: 7, insert: " offline" } });
    const local = sent.filter((m) => m.type === "update").at(-1);
    Y.applyUpdate(server, decodeYjs(local.update));
    const doc = manager.rooms.get("test.md").doc;
    renamePath("renamed.md");
    expect(manager.rooms.has("test.md")).toBe(false);
    expect(manager.rooms.get("renamed.md").doc).toBe(doc);
    expect(editor.state.facet(ySyncFacet).ytext.doc).toBe(doc);
    manager.rejoinPath("renamed.md");
    expect(sent.some((m) => m.type === "join" && m.path === "renamed.md"))
      .toBe(true);
    await manager.handle({
      channel: "collab", type: "init", path: "renamed.md", documentId: ID,
      state: encodeYjs(Y.encodeStateAsUpdate(server))
    });
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " again" } });
    expect(editor.state.doc.toString()).toBe("Initial offline again");
    expect(sent.filter((m) => m.type === "update").at(-1).path).toBe("renamed.md");
    server.destroy();
  });

  it("rehydrates a renamed offline Yjs history by generation before merging remote text", async () => {
    const origin = "https://example.test/offline-" + crypto.randomUUID();
    const server = new Y.Doc();
    server.getText("content").insert(0, "Initial");
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(server));
    offline.getText("content").insert(7, " offline");
    const storage = new IndexeddbPersistence([
      "ignis-connector-yjs-v2", origin, "lab", ID
    ].join("|"), offline);
    await storage.whenSynced;
    await tick();
    await storage.destroy();
    offline.destroy();

    const sent = [], notices = [];
    const manager = new NativeYjs({
      vaultId: () => "lab", origin: () => origin,
      pathForView: () => "renamed.md",
      knownId: () => ID,
      rememberId: async () => {},
      send: (message) => sent.push(message),
      notify: (path, status) => notices.push({ path, status })
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: "Initial offline", extensions: manager.extension()
      })
    });
    cleanup.push(async () => {
      editor.destroy();
      await manager.dispose();
      server.destroy();
    });
    manager.connected();
    server.getText("content").insert(0, "remote ");
    await manager.handle({
      channel: "collab", type: "init", path: "renamed.md", documentId: ID,
      state: encodeYjs(Y.encodeStateAsUpdate(server))
    });
    await tick();
    expect(editor.state.doc.toString()).toBe("remote Initial offline");
    expect(manager.rooms.get("renamed.md").blocked).toBe(false);
    const outbound = sent.filter((m) => m.type === "update").at(-1);
    Y.applyUpdate(server, decodeYjs(outbound.update));
    expect(server.getText("content").toString()).toBe("remote Initial offline");
  });

  it("binds only after exact initial match; native edits become Yjs updates", async () => {
    const { manager, editor, sent, server } = await mount();
    const room = manager.rooms.get("test.md");
    expect(editor.state.facet(ySyncFacet).ytext).toBe(room.text);
    editor.dispatch({ changes: { from: 7, insert: " native" } });
    expect(room.text.toString()).toBe("Initial native");
    const outgoing = sent.filter((m) => m.type === "update").at(-1);
    Y.applyUpdate(server, decodeYjs(outgoing.update));
    expect(server.getText("content").toString()).toBe("Initial native");
    server.destroy();
  });

  it("remote edits update native editor; collaborative Undo preserves peer edits", async () => {
    const { manager, editor, sent, server } = await mount();
    editor.dispatch({ changes: { from: 7, insert: " local" } });
    const outbound = sent.filter((m) => m.type === "update").at(-1);
    Y.applyUpdate(server, decodeYjs(outbound.update));
    server.getText("content").insert(0, "remote ");
    await manager.handle({
      channel: "collab", type: "update", path: "test.md",
      update: encodeYjs(Y.encodeStateAsUpdate(server))
    });
    expect(editor.state.doc.toString()).toBe("remote Initial local");
    const undo = yUndoManagerKeymap.find((k) => k.key === "Mod-z");
    expect(undo.run(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("remote Initial");
    expect(manager.rooms.get("test.md").text.toString()).toBe("remote Initial");
    server.destroy();
  });

  it("does not apply remote changes over an ongoing composition", async () => {
    const { manager, editor, server } = await mount();
    manager.setComposing(editor, true);
    server.getText("content").insert(0, "あいう");
    await manager.handle({
      channel: "collab", type: "update", path: "test.md",
      update: encodeYjs(Y.encodeStateAsUpdate(server))
    });
    expect(editor.state.doc.toString()).toBe("Initial");
    manager.setComposing(editor, false);
    expect(editor.state.doc.toString()).toBe("あいうInitial");
    server.destroy();
  });
});
