// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CursorOverlay, encodeSelection, resolveSelection, sanitizePeers } from "./presence.ts";

describe("Ignis native presence uses the existing server relative cursor protocol", () => {
  it("preserves a remote selection when another author inserts preceding text", () => {
    const d = new Y.Doc();
    const t = d.getText("content");
    t.insert(0, "hello world");
    const cursor = encodeSelection(t, 6, 11);
    expect(resolveSelection(t, cursor)).toEqual({ anchor: 6, head: 11 });
    t.insert(0, "NEW ");
    expect(resolveSelection(t, cursor)).toEqual({ anchor: 10, head: 15 });
    expect(resolveSelection(t, { anchor: "bad", head: "bad" })).toBe(null);
    const other = d.getText("unrelated");
    other.insert(0, "hi");
    expect(resolveSelection(t, encodeSelection(other, 0, 2))).toBe(null);
    d.destroy();
  });
  it("filters malicious peers, duplicates, self identity and unsafe colors", () => {
    const people = sanitizePeers([
      { id: "self", name: "self" },
      { id: "other", name: "<script>hello</script>", color: "red",
        anchor: "abc", head: "def" },
      { id: "other", name: "duplicate" },
      { id: null, name: "no id" },
      { id: "peer", name: "Peer", color: "#33CC44" }
    ], "self");
    expect(people).toHaveLength(2);
    expect(people[0].name).toBe("<script>hello</script>");
    expect(people[0].color).toBe("#59baf2");
    expect(people[1].color).toBe("#33CC44");
  });
  it("paints and immediately removes a visible remote caret/selection", async () => {
    const d = new Y.Doc();
    const t = d.getText("content");
    t.insert(0, "hello world");
    const parent = document.createElement("div");
    document.body.append(parent);
    const scroller = document.createElement("div");
    parent.append(scroller);
    vi.spyOn(parent, "getBoundingClientRect").mockImplementation(() => ({
      left: 0, top: 0, right: 500, bottom: 250, width: 500, height: 250
    }));
    const view = {
      dom: parent, scrollDOM: scroller,
      coordsAtPos: () => ({ left: 36, right: 38, top: 24, bottom: 41 }),
      state: { doc: { length: 11, lineAt: () => ({ to: 11 }) } },
      viewport: { from: 0, to: 11 }
    };
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = cb => setTimeout(() => cb(0), 1);
    globalThis.cancelAnimationFrame = id => clearTimeout(id);
    try {
      const overlay = new CursorOverlay(view);
      overlay.set(t, [{
        id: "remote", name: "<b>Other editor</b>", color: "#ee6b72",
        ...encodeSelection(t, 1, 6)
      }]);
      await new Promise(resolve => setTimeout(resolve, 15));
      const cursor = parent.querySelector(".ignis-native-remote-caret");
      const label = parent.querySelector(".ignis-native-remote-label");
      expect(cursor?.dataset.ignisPeer).toBe("remote");
      expect(cursor?.style.display).not.toBe("none");
      expect(label?.textContent).toBe("<b>Other editor</b>");
      expect(label?.querySelector("b")).toBeNull();
      overlay.set(t, []);
      expect(parent.querySelector(".ignis-native-remote-caret")).toBeNull();
      overlay.destroy();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
      parent.remove();
      d.destroy();
      vi.restoreAllMocks();
    }
  });
});
