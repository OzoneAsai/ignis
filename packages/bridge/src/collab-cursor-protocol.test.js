import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import limits from "../../server-core/src/collab-cursor-limits.json";
import {
  MAX_SHARED_SELECTIONS, MAX_CURSOR_ENCODED_CHARS,
  decodeCursorPosition, encodeCursorSelection, encodeCursorSelections,
  resolveCursorSelection, resolveCursorSelections, selectionEntries
} from "./collab-cursor-protocol.js";
import {
  encodeSelection as nativeEncode, encodeSelections as nativeMany,
  resolveSelection as nativeResolve, sanitizeCursorMessage
} from "../../../apps/obsidian-ignis-connector/src/presence.ts";
import {
  encodeCursorSelection as webEncode, resolveCursorSelection as webResolve
} from "./collaboration-cursors.js";

describe("shared Yjs cursor wire semantics", () => {
  it("uses exactly the same maximum payload limits on all clients and the server", () => {
    expect(limits.maxSelections).toBe(32);
    expect(MAX_SHARED_SELECTIONS).toBe(limits.maxSelections);
    expect(MAX_CURSOR_ENCODED_CHARS).toBe(limits.maxEncodedCursorChars);
    expect(limits.maxEncodedCursorChars).toBe(512);
    expect(limits.maxDecodedCursorBytes).toBe(384);
  });

  it("roundtrips backward selections between native, web and server-compatible data", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "ABC 日本語 collaboration");
    const native = nativeEncode(text, 12, 2);
    expect(native).toEqual(webEncode(text, 12, 2));
    expect(native).toEqual(encodeCursorSelection(text, 12, 2));
    expect(webResolve(text, native)).toEqual(nativeResolve(text, native));
    expect(resolveCursorSelection(text, native)).toEqual({anchor: 12, head: 2});
    text.insert(0, "new ");
    expect(resolveCursorSelections(text, {selections: [native]}))
      .toEqual([{anchor: 16, head: 6}]);
    doc.destroy();
  });

  it("does not drag a stationary remote caret after somebody else's newline at that same line end", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "Q: 今すぐ質問しますか？\nA: はい");
    const at = text.toString().indexOf("\n");
    const caret = encodeCursorSelection(text, at, at);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    // The author inserts a newline at exactly the stationary peer's caret.
    peer.getText("content").insert(at, "\n");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(resolveCursorSelection(text, caret)).toEqual({anchor:at,head:at});
    const movingOwnCaret = encodeCursorSelection(text, at+1, at+1);
    expect(resolveCursorSelection(text,movingOwnCaret)).toEqual({
      anchor:at+1,head:at+1
    });
    peer.destroy();
    doc.destroy();
  });

  it("does not silently truncate 33 selections or accept an invalid mainIndex", () => {
    const doc = new Y.Doc(), text = doc.getText("content");
    text.insert(0, "hello world");
    const ranges = Array.from({length: 33}, (_, index) =>
      ({anchor: index % 5, head: 5}));
    expect(nativeMany(text, ranges)).toBeNull();
    expect(encodeCursorSelections(text, ranges)).toBeNull();
    expect(encodeCursorSelections(text, [ranges[0]], 2)).toBeNull();
    const packet = nativeMany(text, [ranges[0]]);
    expect(packet).not.toBeNull();
    expect(selectionEntries(packet)).toEqual(packet.selections);
    doc.destroy();
  });

  it("rejects noncanonical, oversized or corrupted Yjs positions in both clients", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const point = encodeCursorSelection(text, 3, 3).anchor;
    expect(decodeCursorPosition(point)).toBeTruthy();
    expect(decodeCursorPosition(point + "A")).toBeNull();
    expect(decodeCursorPosition("#not-base64")).toBeNull();
    expect(decodeCursorPosition("A".repeat(516))).toBeNull();
    expect(sanitizeCursorMessage({selections: [{anchor: "garbage", head: point}]}).selections)
      .toEqual([]);
    doc.destroy();
  });

  it("rejects a syntactically valid Yjs position too large for the server wire limit", () => {
    const doc = new Y.Doc();
    const text = doc.getText("x".repeat(420));
    // Before the first insertion Yjs names the root type on the wire, so a
    // legitimately long root name can exceed the canonical wire bound.
    const encoded = Buffer.from(Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, 0))).toString("base64");
    expect(encoded.length).toBeGreaterThan(limits.maxEncodedCursorChars);
    expect(decodeCursorPosition(encoded)).toBeNull();
    expect(nativeEncode(text, 0, 0)).toBeNull();
    expect(webEncode(text, 0, 0)).toBeNull();
    doc.destroy();
  });
});
