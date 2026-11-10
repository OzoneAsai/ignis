// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { createHash } from "node:crypto";
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

async function mount(initialText = "Initial") {
  const sent = [], notifications = [], compositionEvents = [], ids = {};
  let currentPath = "test.md";
  const manager = new NativeYjs({
    vaultId: () => "lab",
    origin: () => "https://example.test/" + crypto.randomUUID(),
    pathForView: () => currentPath,
    knownId: (path) => ids[path] || null,
    rememberId: async (path, id) => { ids[path] = id; },
    send: (message) => sent.push(message),
    notify: (path, status) => notifications.push({ path, status }),
    compositionChanged: path => compositionEvents.push({
      path, ...manager.compositionState(path)
    })
  });
  const mountpoint = document.createElement("div");
  document.body.appendChild(mountpoint);
  const editor = new EditorView({
    parent: mountpoint,
    state: EditorState.create({ doc: initialText, extensions: [
      EditorState.allowMultipleSelections.of(true), ...manager.extension()
    ] })
  });
  cleanup.push(async () => {
    editor.destroy();
    await manager.dispose();
  });
  const server = new Y.Doc();
  server.getText("content").insert(0, initialText);
  manager.connected();
  await manager.handle({
    channel: "collab", type: "init", path: "test.md", documentId: ID,
    state: encodeYjs(Y.encodeStateAsUpdate(server))
  });
  await tick();
  return {
    manager, editor, sent, notifications, compositionEvents, server,
    renamePath(to) {
      const from = currentPath;
      currentPath = to;
      manager.relocate(from, to);
      editor.dispatch({});
    }
  };
}

describe("real CodeMirror 6 native binding", () => {
  it("requests an idempotent full-state repair when a dependent remote Yjs update arrives before its ancestor", async () => {
    const initial="Shared baseline from the server.\n";
    const {manager,editor,server,sent}=await mount(initial);
    const remoteUpdates=[];
    server.on("update",update=>remoteUpdates.push(update));
    server.getText("content").insert(initial.length,"Remote first operation.\n");
    server.getText("content").insert(server.getText("content").length,
      "Remote dependent second operation.\n");
    expect(remoteUpdates).toHaveLength(2);
    const room=manager.rooms.get("test.md");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(remoteUpdates[1])});
    expect(room.text.toString()).toBe(initial);
    expect(room.doc.store.pendingStructs?.missing?.size).toBeGreaterThan(0);
    const before=sent.filter(message=>message.type==="join").length;
    await vi.waitFor(()=>expect(sent.filter(message=>message.type==="join").length)
      .toBeGreaterThan(before),{timeout:2300});
    const reply={channel:"collab",type:"init",path:"test.md",documentId:ID,
      state:encodeYjs(Y.encodeStateAsUpdate(server))};
    await manager.handle(reply);
    await tick();
    expect(room.blocked).toBe(false);
    expect(room.doc.store.pendingStructs?.missing?.size||0).toBe(0);
    expect(room.text.toString()).toBe(server.getText("content").toString());
    expect(editor.state.doc.toString()).toBe(room.text.toString());
    expect(room.causalRepairAttempts).toBe(0);
    expect(room.causalRepairTimer).toBeNull();
  });
  it("does not report a newly joined native room until its CM6 binding can carry edits while persistence ACK is pending", async () => {
    const baseline="Native first generation with late server identity persistence.\n";
    const server=new Y.Doc();
    server.getText("content").insert(0,baseline);
    const frames=[], review=[];
    let finishRemember;
    const remember=new Promise(resolve=>{finishRemember=resolve});
    const manager=new NativeYjs({
      vaultId:()=>"lab",origin:()=>"https://example.test/atomic-firstjoin-"+crypto.randomUUID(),
      pathForView:()=>"atomic-firstjoin.md",knownId:()=>null,
      rememberId:async()=>remember,send:frame=>frames.push(frame),
      notify:(_path,text)=>review.push(text),
    });
    const parent=document.createElement("div");document.body.appendChild(parent);
    const editor=new EditorView({parent,state:EditorState.create({
      doc:baseline,extensions:manager.extension()
    })});
    cleanup.push(async()=>{finishRemember();editor.destroy();await manager.dispose();server.destroy()});
    manager.connected();
    const joining=manager.handle({channel:"collab",type:"init",path:"atomic-firstjoin.md",
      documentId:ID,state:encodeYjs(Y.encodeStateAsUpdate(server))});
    const room=manager.rooms.get("atomic-firstjoin.md");
    await vi.waitFor(()=>expect(room.joined).toBe(true),{timeout:2000});
    expect(room.blocked).toBe(false);
    expect(manager.bound.get(editor)).toBe(room);
    editor.dispatch({changes:{from:baseline.length,insert:"A keystroke before ID persistence.\n"}});
    expect(room.text.toString()).toBe(editor.state.doc.toString());
    expect(frames.some(frame=>frame.type==="update")).toBe(true);
    finishRemember();
    await joining;
    expect(review).toEqual([]);
    expect(room.sentSeq).toBeGreaterThan(0);
  });
  it("rebases native typing before Yjs init onto concurrent Web and mobile Web edits from a verified file generation", async () => {
    const baseline="Initial server snapshot.\n";
    const server=new Y.Doc();
    server.getText("content").insert(0,baseline);
    server.getText("content").insert(baseline.length,"Desktop Web.\nMobile Web.\n");
    const sent=[], notices=[];
    const manager=new NativeYjs({
      vaultId:()=>"lab",origin:()=>"https://example.test/verified-prejoin-"+ID,
      pathForView:()=>"prejoin.md",knownId:()=>null,
      fileBaseline:()=>({generationId:ID,hash:createHash("sha256")
        .update(baseline).digest("hex")}),
      rememberId:async()=>{},send:x=>sent.push(x),
      notify:(_,status)=>notices.push(status)
    });
    const parent=document.createElement("div");
    document.body.appendChild(parent);
    const editor=new EditorView({parent,state:EditorState.create({
      doc:baseline,extensions:manager.extension()
    })});
    cleanup.push(async()=>{editor.destroy();await manager.dispose();server.destroy()});
    manager.connected();
    // Native typing occurs while its first server init is delayed.
    editor.dispatch({changes:{from:0,insert:"Native initial typing.\n"}});
    await manager.handle({channel:"collab",type:"init",path:"prejoin.md",
      documentId:ID,state:encodeYjs(Y.encodeStateAsUpdate(server))});
    await tick();
    const expected="Native initial typing.\n"+baseline+"Desktop Web.\nMobile Web.\n";
    expect(manager.rooms.get("prejoin.md").blocked).toBe(false);
    expect(manager.rooms.get("prejoin.md").joined).toBe(true);
    expect(editor.state.doc.toString()).toBe(expected);
    expect(manager.rooms.get("prejoin.md").text.toString()).toBe(expected);
    expect(notices.filter(x=>x.includes("review"))).toEqual([]);
    expect(sent.filter(x=>x.type==="update").length).toBeGreaterThan(0);
  });

  it("protects pre-join overlapping native and Web changes even with a shared file-generation baseline", async () => {
    const baseline="Question: baseline\n";
    const source=new Y.Doc();
    source.getText("content").insert(0,"Question: web wins?\n");
    const manager=new NativeYjs({vaultId:()=>"lab",
      origin:()=>"https://example.test/conflict-"+ID,
      pathForView:()=>"prejoin.md",knownId:()=>null,
      fileBaseline:()=>({generationId:ID,hash:createHash("sha256")
        .update(baseline).digest("hex")}),
      rememberId:async()=>{},send:()=>{},notify:()=>{}
    });
    const parent=document.createElement("div");
    document.body.appendChild(parent);
    const editor=new EditorView({parent,state:EditorState.create({
      doc:baseline,extensions:manager.extension()
    })});
    cleanup.push(async()=>{editor.destroy();await manager.dispose();source.destroy()});
    manager.connected();
    editor.dispatch({changes:{from:0,to:baseline.length,insert:"Question: native wins?\n"}});
    await manager.handle({channel:"collab",type:"init",path:"prejoin.md",
      documentId:ID,state:encodeYjs(Y.encodeStateAsUpdate(source))});
    expect(manager.rooms.get("prejoin.md").blocked).toBe(true);
    expect(editor.state.doc.toString()).toBe("Question: native wins?\n");
  });
  it("retires a closed, blocked Yjs generation without losing the preserved file",async()=>{
    const {manager,editor,server}=await mount("Original local note");
    const room=manager.rooms.get("test.md");
    room.blocked=true;
    await expect(manager.retireDocument("test.md")).rejects.toThrow(/Close the old editor/);
    expect(manager.rooms.get("test.md")).toBe(room);
    editor.destroy();
    expect(room.views.size).toBe(0);
    // An actual preserve-first migration requires the server's ACK before
    // closing its original; this fixture does not simulate save receipts.
    room.pendingHandshake=false;
    room.savedSeq=room.sentSeq;
    const releaseDoc=vi.spyOn(room.doc,"destroy");
    await manager.retireDocument("test.md");
    expect(manager.rooms.has("test.md")).toBe(false);
    expect(releaseDoc).toHaveBeenCalledOnce();
    server.destroy();
  });
  it("tracks the physical IME candidate separately from a server ACK and pending peer conflict", async()=>{
    const initial="Q: IMEですか？\n\nA: ";
    const {manager,editor,server,sent,compositionEvents}=await mount(initial);
    expect(manager.compositionState("test.md")).toEqual({
      composing:false,peerEditWaiting:false
    });
    editor.dispatch({selection:{anchor:initial.length}});
    manager.setComposing(editor,true);
    expect(manager.compositionState("test.md")).toEqual({
      composing:true,peerEditWaiting:false
    });
    editor.dispatch({changes:{from:initial.length,insert:"未確定"}});
    Y.applyUpdate(server,decodeYjs(sent.filter(x=>x.type==="update").at(-1).update));
    server.getText("content").insert(initial.length,"別担当");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(manager.compositionState("test.md")).toEqual({
      composing:true,peerEditWaiting:true
    });
    manager.setComposing(editor,false);
    expect(manager.compositionState("test.md")).toEqual({
      composing:false,peerEditWaiting:false
    });
    expect(compositionEvents.map(x=>[x.composing,x.peerEditWaiting]))
      .toEqual([[true,false],[true,true],[false,false]]);
    server.destroy();
  });
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
  it("restores an overdeleted FAQ separator after a peer rewrites adjacent question text", async () => {
    const initial = "Q: 複数端末で安全に共同編集できますか？\n\nA: 回答本文";
    const {manager, editor, sent, server} = await mount(initial);
    const original = editor.state.doc.toString();
    const gap = original.indexOf("\n\nA: ");
    expect(gap).toBeGreaterThan(0);
    editor.dispatch({changes:{from:gap,to:gap+2,insert:""}});
    const room=manager.rooms.get("test.md");
    expect(room.undoIntent?.deleted).toBe("\n\n");
    const aUpdate = sent.filter(m=>m.type==="update").at(-1);
    Y.applyUpdate(server, decodeYjs(aUpdate.update));
    const question = "安全に共同編集できますか？";
    const qAt = server.getText("content").toString().indexOf(question);
    server.getText("content").delete(qAt,question.length);
    server.getText("content").insert(qAt,"競合を起こさず共同編集できますか？");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(editor.state.doc.toString()).toContain("か？A: 回答本文");
    expect(manager.undoNative(editor)).toBe(true);
    const expected = "Q: 複数端末で競合を起こさず共同編集できますか？\n\nA: 回答本文";
    expect(editor.state.doc.toString()).toBe(expected);
    expect(room.text.toString()).toBe(expected);
    expect(manager.redoNative(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(
      "Q: 複数端末で競合を起こさず共同編集できますか？A: 回答本文");
    expect(manager.undoNative(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(expected);
    server.destroy();
  });

  it.each([
    {
      name:"question prefix insertion", from:"", to:"[確認済み] ",
      expected:"[確認済み] Q: 安全に同期できますか？\n\nA: はい"
    },
    {
      name:"question suffix replacement",
      from:"安全に同期できますか？",to:"端末を跨いで利用できますか？",
      expected:"Q: 端末を跨いで利用できますか？\n\nA: はい"
    },
    {
      name:"answer text replacement",from:"はい",to:"可能です",
      expected:"Q: 安全に同期できますか？\n\nA: 可能です"
    },
    {
      name:"shared word replacement within question",from:"同期",to:"共同編集",
      expected:"Q: 安全に共同編集できますか？\n\nA: はい"
    },
    {
      name:"peer inserts inside the answer",from:"はい",to:"根拠: はい",
      expected:"Q: 安全に同期できますか？\n\nA: 根拠: はい"
    }
  ])("restores exact FAQ boundary after simultaneous $name",async ({from,to,expected})=>{
    const initial="Q: 安全に同期できますか？\n\nA: はい";
    const {manager,editor,sent,server}=await mount(initial);
    const room=manager.rooms.get("test.md");
    const index=initial.indexOf("\n\nA: ");
    editor.dispatch({changes:{from:index,to:index+2,insert:""}});
    Y.applyUpdate(server,decodeYjs(sent.filter(m=>m.type==="update").at(-1).update));
    const remote=server.getText("content");
    if(!from)remote.insert(0,to);
    else{
      const pos=remote.toString().indexOf(from);
      expect(pos).toBeGreaterThanOrEqual(0);
      remote.delete(pos,from.length);
      remote.insert(pos,to);
    }
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(manager.undoNative(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(expected);
    expect(room.text.toString()).toBe(expected);
    server.destroy();
  });

  it("does not reinterpret a deleted right-hand anchor as a surviving boundary",async()=>{
    const initial="Q: 更新しても回答は残りますか？\n\nA: はい";
    const {manager,editor,sent,server,notifications}=await mount(initial);
    const room=manager.rooms.get("test.md");
    const gap=initial.indexOf("\n\nA: ");
    editor.dispatch({changes:{from:gap,to:gap+2,insert:""}});
    Y.applyUpdate(server,decodeYjs(sent.filter(m=>m.type==="update").at(-1).update));
    const marker=room.undoIntent.right;
    const remote=server.getText("content"),before=remote.toString();
    const at=before.indexOf("A: ");
    remote.delete(at,3);
    remote.insert(at,"Answer: ");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(Y.getItem(room.doc.store,marker.item).deleted).toBe(true);
    const beforeUndo=editor.state.doc.toString();
    const updatesBefore=sent.filter(x=>x.type==="update").length;
    expect(manager.undoNative(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(beforeUndo);
    expect(sent.filter(x=>x.type==="update")).toHaveLength(updatesBefore);
    expect(notifications.some(x=>x.status.includes("Undo needs review"))).toBe(true);
    expect(manager.pendingUndoReviews()).toMatchObject([{
      path:"test.md", documentId:ID,
      operation:"undo", deleted:"\n\n", reason:"boundary-removed"
    }]);
    expect(manager.pendingUndoReviews()[0].context).toContain("Answer: はい");
    expect(manager.dismissUndoReview("another.md",ID)).toBe(false);
    expect(manager.pendingUndoReviews()).toHaveLength(1);
    expect(manager.dismissUndoReview("test.md",ID)).toBe(true);
    expect(manager.pendingUndoReviews()).toHaveLength(0);
    expect(editor.state.doc.toString()).toContain("Answer: はい");
    expect(editor.state.doc.toString()).toBe(room.text.toString());
    server.destroy();
  });

  it("handles identical text in Q and A without replacing a neighbouring occurrence",async()=>{
    const initial="Q: 同期は同期を保証しますか？\n\nA: 同期を保証します。同期です";
    const {manager,editor,sent,server}=await mount(initial);
    const gap=initial.indexOf("\n\nA: ");
    editor.dispatch({changes:{from:gap,to:gap+2,insert:""}});
    Y.applyUpdate(server,decodeYjs(sent.filter(m=>m.type==="update").at(-1).update));
    const remote=server.getText("content");
    const q="保証しますか？";
    const at=remote.toString().indexOf(q);
    remote.delete(at,q.length);
    remote.insert(at,"可能でしょうか？");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(manager.undoNative(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(
      "Q: 同期は同期を可能でしょうか？\n\nA: 同期を保証します。同期です");
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

  it("keeps unrelated remote changes live before a Japanese IME candidate is confirmed", async () => {
    const { manager, editor, server } = await mount();
    editor.dispatch({selection:{anchor:editor.state.doc.length}});
    manager.setComposing(editor, true);
    server.getText("content").insert(0, "あいう");
    await manager.handle({
      channel: "collab", type: "update", path: "test.md",
      update: encodeYjs(Y.encodeStateAsUpdate(server))
    });
    expect(editor.state.doc.toString()).toBe("あいうInitial");
    expect(manager.rooms.get("test.md").composing).toBe(true);
    manager.setComposing(editor, false);
    expect(editor.state.doc.toString()).toBe("あいうInitial");
    server.destroy();
  });

  it("preserves a live Japanese candidate and stationary presence while accepting disjoint peer edits", async () => {
    const initial = "Q: 同期してもいい？\n\nA: ";
    const {manager,editor,server,sent}=await mount(initial);
    const room=manager.rooms.get("test.md");
    editor.dispatch({selection:{anchor:initial.length}});
    manager.setComposing(editor,true);
    const cursorBefore=sent.filter(x=>x.type==="cursor").length;
    expect(cursorBefore).toBeGreaterThanOrEqual(1);
    editor.dispatch({changes:{from:initial.length,insert:"へんかん中"}});
    const candidate=editor.state.doc.toString();
    expect(candidate).toContain("へんかん中");
    const local=sent.filter(x=>x.type==="update").at(-1);
    Y.applyUpdate(server,decodeYjs(local.update));
    server.getText("content").insert(0,"別端末がQを編集。\n");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(editor.state.doc.toString()).toContain("別端末がQを編集。");
    expect(editor.state.doc.toString()).toContain("へんかん中");
    expect(room.waiting).toHaveLength(0);
    expect(room.composing).toBe(true);
    expect(sent.filter(x=>x.type==="cursor-away")).toHaveLength(0);
    manager.setComposing(editor,false);
    expect(editor.state.doc.toString()).toBe(room.text.toString());
    server.destroy();
  });

  it("protects a true overlapping remote change until the IME candidate ends", async()=>{
    const initial="Q: 確定ですか？\n\nA: ";
    const {manager,editor,server,sent}=await mount(initial);
    const room=manager.rooms.get("test.md");
    const at=initial.length;
    editor.dispatch({selection:{anchor:at}});
    manager.setComposing(editor,true);
    editor.dispatch({changes:{from:at,insert:"変換中"}});
    Y.applyUpdate(server,decodeYjs(sent.filter(x=>x.type==="update").at(-1).update));
    server.getText("content").insert(at,"相手入力");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(editor.state.doc.toString()).not.toContain("相手入力");
    expect(room.waiting.length).toBeGreaterThan(0);
    manager.setComposing(editor,false);
    expect(room.waiting).toHaveLength(0);
    expect(editor.state.doc.toString()).toContain("相手入力");
    expect(editor.state.doc.toString()).toContain("変換中");
    server.destroy();
  });

  it("does not freeze a third participant's independent edit after a conflicting IME update is deferred", async()=>{
    const initial = "Q: 同期できますか？\n\nA: ";
    const {manager,editor,server,sent}=await mount(initial);
    const room = manager.rooms.get("test.md");
    const at = initial.length;
    editor.dispatch({selection:{anchor:at}});
    manager.setComposing(editor,true);
    editor.dispatch({changes:{from:at,insert:"へんかん中"}});
    Y.applyUpdate(server,decodeYjs(sent.filter(x=>x.type==="update").at(-1).update));
    const third=new Y.Doc();
    Y.applyUpdate(third,Y.encodeStateAsUpdate(server));
    server.getText("content").insert(at,"競合");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(server))});
    expect(room.waiting).toHaveLength(1);
    third.getText("content").insert(0,"別端末の質問追記。\n");
    await manager.handle({channel:"collab",type:"update",path:"test.md",
      update:encodeYjs(Y.encodeStateAsUpdate(third))});
    expect(editor.state.doc.toString()).toContain("別端末の質問追記。");
    expect(editor.state.doc.toString()).not.toContain("競合");
    expect(editor.state.doc.toString()).toContain("へんかん中");
    manager.setComposing(editor,false);
    expect(room.waiting).toHaveLength(0);
    expect(editor.state.doc.toString()).toContain("競合");
    expect(editor.state.doc.toString()).toBe(room.text.toString());
    third.destroy();server.destroy();
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
