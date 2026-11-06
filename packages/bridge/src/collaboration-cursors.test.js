import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  encodeCursorSelection,
  resolveCursorSelection,
} from "./collaboration-cursors.js";

describe("shared cursor relative positions", () => {
  it("keeps selections attached to text when characters are inserted before them", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const peer = encodeCursorSelection(text, 6, 11);

    expect(resolveCursorSelection(text, peer)).toEqual({ anchor: 6, head: 11 });
    text.insert(0, "new ");
    expect(resolveCursorSelection(text, peer)).toEqual({ anchor: 10, head: 15 });
  });

  it("preserves selection direction", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "abcdef");
    const peer = encodeCursorSelection(text, 5, 2);
    expect(resolveCursorSelection(text, peer)).toEqual({ anchor: 5, head: 2 });
  });

  it("ignores invalid and cross-document cursors", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "test");
    expect(resolveCursorSelection(text, { anchor: "invalid", head: "invalid" })).toBe(null);

    const otherText = doc.getText("other");
    otherText.insert(0, "other");
    expect(resolveCursorSelection(text, encodeCursorSelection(otherText, 0, 3))).toBe(null);
  });
});
