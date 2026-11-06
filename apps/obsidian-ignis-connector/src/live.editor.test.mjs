// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncFacet, yUndoManagerKeymap } from "y-codemirror.next";
import { NativeYjs, encodeYjs, decodeYjs } from "./live.ts";
import { remoteSelectionField } from "./selection-decorations.ts";

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
    state: EditorState.create({ doc: "Initial", extensions: [
      EditorState.allowMultipleSelections.of(true), ...manager.extension()
    ] })
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
  it("refuses unrelated CRDT histories reusing a known generation instead of duplicating text", async () => {
    const origin = "https://example.test/lineage-" + crypto.randomUUID();
    const old = new Y.Doc();
    old.getText("content").insert(0, "Same baseline");
    const storage = new IndexeddbPersistence([
      "ignis-connector-yjs-v2", origin, "lab", ID
    ].join("|"), old);
    await storage.whenSynced;
    await tick();
    await storage.destroy();
    old.destroy();

    // A server rebuilding the same generation from Markdown creates a new
    // Yjs client ID; merging this independently reconstructed history with
    // the native IndexedDB state would duplicate identical baseline bytes.
    const independent = new Y.Doc();
    independent.getText("content").insert(0, "Same baseline");
    const sent = [], notices = [];
    const manager = new NativeYjs({
      vaultId: () => "lab", origin: () => origin,
      pathForView: () => "test.md",
      knownId: () => ID,
      rememberId: async () => {},
      send: (message) => sent.push(message),
      notify: (_path, status) => notices.push(status)
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const editor = new EditorView({
      parent, state: EditorState.create({
        doc: "Same baseline", extensions: manager.extension()
      })
    });
    cleanup.push(async () => {
      editor.destroy();
      await manager.dispose();
      independent.destroy();
    });
    manager.connected();
    await manager.handle({
      channel: "collab", type: "init", path: "test.md", documentId: ID,
      state: encodeYjs(Y.encodeStateAsUpdate(independent))
    });
    await tick();
    expect(manager.rooms.get("test.md").blocked).toBe(true);
    expect(editor.state.doc.toString()).toBe("Same baseline");
    expect(manager.rooms.get("test.md").text.toString()).toBe("Same baseline");
    expect(sent.some((msg) => msg.type === "update")).toBe(false);
    expect(notices.some((status) => /lineage/i.test(status))).toBe(true);
  });
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

  it("publishes every CodeMirror selection and ignores stale-document cursor notifications", async () => {
    const { manager, editor, sent, server } = await mount();
    editor.focus();
    editor.dispatch({ selection: EditorSelection.create([
      EditorSelection.range(0, 2),
      EditorSelection.range(4, 6),
      EditorSelection.cursor(7)
    ], 1) });
    await new Promise(resolve => setTimeout(resolve, 105));
    const shared = sent.filter((m) => m.type === "cursor").at(-1);
    expect(shared?.documentId).toBe(ID);
    expect(shared?.selections).toHaveLength(3);
    expect(shared.mainIndex).toBe(1);
    const room = manager.rooms.get("test.md");
    await manager.handle({ channel: "collab", type: "presence",
      path: "test.md", documentId: ID, people: [
        { id: room.selfId, name: "Self", color: "#ee6b72" },
        { id: "other", name: "Remote", color: "#59baf2", selections: [] }
      ]
    });
    expect(room.peers.get("other").selections).toHaveLength(0);
    await manager.handle({ channel: "collab", type: "cursor",
      path: "test.md", documentId: crypto.randomUUID(), id: "other",
      selections: shared.selections, mainIndex: 1 });
    expect(room.peers.get("other").selections).toHaveLength(0);
    await manager.handle({ channel: "collab", type: "cursor",
      path: "test.md", documentId: ID, id: "other",
      selections: shared.selections, mainIndex: 1 });
    expect(room.peers.get("other").selections).toHaveLength(3);
    expect(room.peers.get("other").mainIndex).toBe(1);
    await manager.handle({ channel: "collab", type: "cursor",
      path: "test.md", documentId: ID, id: "other",
      selections: [], anchor: null, head: null, mainIndex: 0 });
    expect(room.peers.get("other").selections).toEqual([]);
    server.destroy();
  });
  it("projects remote Yjs positions into native CM6 marks and removes them on away", async () => {
    const { manager, editor, server } = await mount();
    const room = manager.rooms.get("test.md");
    await manager.handle({channel:"collab", type:"presence",
      path:"test.md", documentId:ID,
      people:[{id:"peer", name:"Alice", color:"#59baf2", selections:[]}]
    });
    const from = 1, to = 5;
    const selections = (await import("./presence.ts")).encodeSelection(room.text, from, to);
    await manager.handle({channel:"collab", type:"cursor", path:"test.md",
      documentId:ID, id:"peer", selections:[selections], mainIndex:0});
    await tick();
    const positions = [];
    editor.state.field(remoteSelectionField).between(0,editor.state.doc.length,
      (a,b)=>positions.push([a,b]));
    expect(positions).toEqual([[from,to]]);
    expect(editor.dom.querySelector(".ignis-native-remote-highlight")?.textContent)
      .toBe("niti");
    expect(editor.dom.querySelector(".ignis-native-remote-selection")).toBeNull();
    await manager.handle({channel:"collab", type:"cursor", path:"test.md",
      documentId:ID, id:"peer", selections:[], anchor:null, head:null,mainIndex:0});
    await tick();
    expect(editor.dom.querySelector(".ignis-native-remote-highlight")).toBeNull();
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

  it("bounds deferred remote updates during long iOS IME composition", async () => {
    const { manager, editor, sent, notifications, server } = await mount();
    const room = manager.rooms.get("test.md");
    manager.setComposing(editor, true);
    manager.deferRemote(room, new Uint8Array(4 * 1024 * 1024 + 1));
    expect(room.blocked).toBe(true);
    expect(room.joined).toBe(false);
    expect(room.waiting).toEqual([]);
    expect(room.waitingBytes).toBe(0);
    expect(editor.state.doc.toString()).toBe("Initial");
    expect(sent.some((message) => message.type === "leave")).toBe(true);
    expect(notifications.some((item) => item.status.includes("IME buffer")))
      .toBe(true);
    server.destroy();
  });
});
