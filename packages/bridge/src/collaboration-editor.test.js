import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { deltaToChanges, localChanges, patchEditor } from "./collaboration-editor.js";

function applyText(base, changes) {
  let result = base;

  for (const { from, to, insert } of changes.slice().reverse()) {
    result = result.slice(0, from) + insert + result.slice(to);
  }

  return result;
}

describe("minimal editing transactions", () => {
  it("does not delete unchanged text between two independent edits", () => {
    const source = "A 12345 B 67890 C";
    const destination = "A xx12345 B 67890yy C";
    const changes = deltaToChanges(localChanges(source, destination));

    expect(changes).toHaveLength(2);
    expect(changes[0].to).toBeLessThan(changes[1].from);
    expect(applyText(source, changes)).toBe(destination);
  });

  it("preserves UTF-16 lengths, deletions and replacements", () => {
    for (const [before, after] of [
      ["ab😀cd", "a😎b😀d"],
      ["some words", "new words!"],
      ["same", ""],
      ["", "new text"],
      ["abcxyz", "abxqz"],
    ]) {
      expect(applyText(before, deltaToChanges(localChanges(before, after)))).toBe(after);
    }
  });

  it("generates Yjs updates that preserve concurrent changes in untouched spans", () => {
    const base = "first middle last";
    const server = new Y.Doc();
    server.getText("content").insert(0, base);
    const left = new Y.Doc();
    const right = new Y.Doc();
    const original = Y.encodeStateAsUpdate(server);
    Y.applyUpdate(left, original);
    Y.applyUpdate(right, original);
    const changed = "L first middle last R";
    left.getText("content").applyDelta(localChanges(base, changed));
    right.getText("content").insert(8, " shared ");

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(left.getText("content").toString()).toBe(right.getText("content").toString());
    expect(left.getText("content").toString()).toContain(" shared ");
    expect(left.getText("content").toString()).toContain("L first");
    expect(left.getText("content").toString()).toContain("last R");
  });

  it("maps Yjs incremental deltas precisely across a reproducible sequence of edits", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "alpha beta γ delta 😎 end");
    let previous = text.toString();
    let seed = 37;

    const nextRandom = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    text.observe((event) => {
      const changes = deltaToChanges(event.delta);
      expect(applyText(previous, changes)).toBe(text.toString());
      previous = text.toString();
    });

    for (let i = 0; i < 240; i++) {
      const length = text.length;
      const current = text.toString();
      const boundaries = [0];

      for (const codePoint of current) {
        boundaries.push(boundaries.at(-1) + codePoint.length);
      }

      const at = boundaries[Math.floor(nextRandom() * boundaries.length)];

      if (length > 5 && nextRandom() < 0.35) {
        const index = at === current.length ? boundaries.at(-2) : at;
        text.delete(index, (current.codePointAt(index) || 0) > 0xffff ? 2 : 1);
      } else {
        text.insert(at, i % 3 === 0 ? "漢" : "x");
      }
    }
  });

  it("rejects a stale editor with the same text length before dispatching", () => {
    let dispatched = false;
    const editor = {
      cm: {
        dispatch() { dispatched = true; },
        state: {
          doc: { length: 4, toString: () => "xxxx" },
          changes: () => ({
            apply: () => ({ toString: () => "axxx" }),
          }),
        },
      },
    };
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "good");
    expect(patchEditor(editor, text, [{ delete: 1 }, { insert: "a" }])).toBe(false);
    expect(dispatched).toBe(false);
  });
});
