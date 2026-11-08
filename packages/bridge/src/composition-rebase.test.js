import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  beginComposition, publishComposition, commitComposition
} from "./composition-rebase.js";

describe("browser IME transaction rebase", () => {
  it("keeps remote text live and merges a Japanese IME draft without overwriting it", () => {
    const live = new Y.Doc();
    const text = live.getText("content");
    text.insert(0, "begin end");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    const snapshot = beginComposition(live);

    peer.getText("content").insert(0, "REMOTE ");
    Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
    expect(text.toString()).toBe("REMOTE begin end");
    expect(snapshot.text.toString()).toBe("begin end");

    const undo = new Y.UndoManager(text, { trackedOrigins: new Set(["local-ime"]) });
    commitComposition(live, snapshot, "begin 日本語end", "local-ime");
    expect(text.toString()).toContain("REMOTE ");
    expect(text.toString()).toContain("日本語");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    expect(peer.getText("content").toString()).toBe(text.toString());

    undo.undo();
    expect(text.toString()).toBe("REMOTE begin end");
    undo.destroy();
    peer.destroy();
    live.destroy();
  });

  it("does not roll back remote edits when composition finishes without changes", () => {
    const live = new Y.Doc();
    live.getText("content").insert(0, "initial");
    const snapshot = beginComposition(live);
    live.getText("content").insert(0, "peer ");
    commitComposition(live, snapshot, "initial", "local-ime");
    expect(live.getText("content").toString()).toBe("peer initial");
    live.destroy();
  });

  it("preserves disjoint concurrent edits made during an uncommitted composition", () => {
    const live = new Y.Doc();
    live.getText("content").insert(0, "abc");
    const snapshot = beginComposition(live);
    live.getText("content").insert(0, "REMOTE ");
    commitComposition(live, snapshot, "abc日本語", "local-ime");
    expect(live.getText("content").toString()).toBe("REMOTE abc日本語");
    live.destroy();
  });

  it("merges peer updates arriving after composition begins without touching the draft snapshot", () => {
    const live = new Y.Doc();
    const text = live.getText("content");
    text.insert(0, "start middle end");
    const snapshot = beginComposition(live);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    peer.getText("content").insert(6, "PEER ");
    Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
    expect(snapshot.text.toString()).toBe("start middle end");
    expect(text.toString()).toBe("start PEER middle end");

    commitComposition(live, snapshot, "start middle END日本語", "local-ime");
    expect(text.toString()).toBe("start PEER middle END日本語");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    expect(peer.getText("content").toString()).toBe(text.toString());
    peer.destroy();
    live.destroy();
  });

  it("streams provisional IME conversions to remote devices before compositionend", () => {
    const live = new Y.Doc();
    const text = live.getText("content");
    text.insert(0, "A ");
    const snapshot = beginComposition(live);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    const updates = [];
    live.on("update", (bytes, origin) => {
      if (origin === "local-ime") updates.push(bytes);
    });

    expect(publishComposition(live, snapshot, "A に", "local-ime")).toBe(true);
    Y.applyUpdate(peer, updates.at(-1));
    expect(peer.getText("content").toString()).toBe("A に");
    expect(publishComposition(live, snapshot, "A 日本", "local-ime")).toBe(true);
    Y.applyUpdate(peer, updates.at(-1));
    expect(peer.getText("content").toString()).toBe("A 日本");

    // Peer edits remain independent of provisional candidate conversion.
    peer.getText("content").insert(0, "B ");
    Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
    commitComposition(live, snapshot, "A 日本語", "local-ime");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    expect(peer.getText("content").toString()).toBe("B A 日本語");
    live.destroy();
    peer.destroy();
  });
});
