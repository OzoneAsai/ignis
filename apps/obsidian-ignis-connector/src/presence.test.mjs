// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CursorOverlay, encodeSelection, encodeSelections, resolveSelection,
  resolveSelections, sanitizePeers, sanitizeCursorMessage } from "./presence.ts";

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
  it("preserves multiple reversed selections and the primary index through Yjs edits", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const sent = encodeSelections(text, [
      { anchor: 0, head: 1 }, { anchor: 10, head: 6 }, { anchor: 8, head: 8 }
    ], 1);
    expect(sent.selections).toHaveLength(3);
    expect(sent.mainIndex).toBe(1);
    const peer = { ...sent };
    expect(resolveSelections(text, peer)).toEqual([
      { anchor: 0, head: 1 }, { anchor: 10, head: 6 },
      { anchor: 8, head: 8 }
    ]);
    text.insert(0, "NEW ");
    expect(resolveSelections(text, peer)).toEqual([
      { anchor: 4, head: 5 }, { anchor: 14, head: 10 },
      { anchor: 12, head: 12 }
    ]);
    expect(encodeSelections(text, Array.from({ length: 33 },
      () => ({ anchor: 0, head: 1 })), 0)).toBe(null);
    expect(sanitizeCursorMessage({
      selections: [{ anchor: "nonsense", head: "nonsense" }]
    }).selections).toEqual([]);
    doc.destroy();
  });
  it("sanitizes all 50 peers without the former 32-person cap", () => {
    const source = Array.from({ length: 50 }, (_, i) => ({
      id: "peer-" + i, name: "User " + i, color: "#33CC44",
      selections: [], mainIndex: 0
    }));
    const peers = sanitizePeers(source, "self");
    expect(peers).toHaveLength(50);
    expect(peers.at(-1).name).toBe("User 49");
    expect(peers[0].selections).toEqual([]);
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
    vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => ({
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
  it("renders three caret nodes for one peer and keeps all 50 peers navigable", async () => {
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
      lineBlockAt: (pos) => ({ top: pos * 18 }),
      coordsAtPos: () => ({ left: 35, right: 37, top: 24, bottom: 40 }),
      state: { doc: { length: 11, lineAt: () => ({ to: 11 }) } },
      viewport: { from: 0, to: 11 }
    };
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = cb => setTimeout(() => cb(0), 1);
    globalThis.cancelAnimationFrame = id => clearTimeout(id);
    try {
      const overlay = new CursorOverlay(view);
      const selected = encodeSelections(t, [
        { anchor: 1, head: 2 }, { anchor: 4, head: 7 },
        { anchor: 10, head: 9 }
      ], 1);
      const peers = sanitizePeers([
        { id: "remote", name: "Remote", color: "#aabbcc", ...selected },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: "other-" + i, name: "Other " + i, color: "#ee6b72"
        }))
      ], "self");
      overlay.set(t, peers);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(parent.querySelectorAll(".ignis-native-remote-caret")).toHaveLength(3);
      expect(parent.querySelectorAll(".ignis-native-remote-label"))
        .toHaveLength(3);
      expect([...parent.querySelectorAll(".ignis-native-remote-label")]
        .filter(el => el.style.display !== "none")).toHaveLength(1);
      expect(parent.querySelectorAll(".ignis-native-people-jump")).toHaveLength(50);
      parent.querySelector('.ignis-native-people-jump[data-ignis-peer="remote"]').click();
      expect(scroller.scrollTop).toBeGreaterThan(0);
      overlay.set(t, []);
      expect(parent.querySelectorAll(".ignis-native-remote-caret")).toHaveLength(0);
      expect(parent.querySelector(".ignis-native-people-roster").hidden).toBe(true);
      overlay.destroy();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
      parent.remove();
      d.destroy();
      vi.restoreAllMocks();
    }
  });
  it("places native name labels without covering rendered text or other labels", async () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "日本語 aaa");
    const parent = document.createElement("div");
    document.body.append(parent);
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    content.textContent = "日本語 aaa";
    scroller.append(content);
    parent.append(scroller);
    const area = (left, top, right, bottom) => ({
      left, top, right, bottom, width: right - left, height: bottom - top
    });
    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(area(0, 0, 420, 260));
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(area(0, 0, 420, 260));
    const oldRangeRects = Range.prototype.getClientRects;
    const oldElementRect = HTMLElement.prototype.getBoundingClientRect;
    Range.prototype.getClientRects = () => [area(0, 76, 126, 98)];
    HTMLElement.prototype.getBoundingClientRect = function() {
      return this.classList.contains("ignis-native-remote-label")
        ? area(0, 0, 60, 18) : oldElementRect.call(this);
    };
    const view = {
      dom: parent, scrollDOM: scroller, contentDOM: content,
      coordsAtPos: () => area(140, 100, 142, 120),
      state: { doc: { length: text.length, lineAt: () => ({ to: text.length }) } },
      viewport: { from: 0, to: text.length }
    };
    const oldRaf = globalThis.requestAnimationFrame;
    const oldCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 1);
    globalThis.cancelAnimationFrame = clearTimeout;
    try {
      const overlay = new CursorOverlay(view);
      const shared = encodeSelection(text, 3, 3);
      overlay.set(text, [
        { id: "one", name: "Guest One", color: "#ee6b72", ...shared },
        { id: "two", name: "Guest Two", color: "#59baf2", ...shared }
      ]);
      await new Promise(resolve => setTimeout(resolve, 30));
      const labels = [...parent.querySelectorAll(".ignis-native-remote-label")]
        .filter(element => element.style.visibility === "visible");
      expect(labels).toHaveLength(2);
      const rectangles = labels.map(label => {
        const caret = label.parentElement;
        const left = parseFloat(caret.style.left) + parseFloat(label.style.left);
        const top = parseFloat(caret.style.top) + parseFloat(label.style.top);
        return area(left, top, left + 60, top + 18);
      });
      const intersects = (a, b) => a.left < b.right && a.right > b.left &&
        a.top < b.bottom && a.bottom > b.top;
      expect(intersects(rectangles[0], rectangles[1])).toBe(false);
      for (const badge of rectangles) {
        expect(intersects(badge, area(0, 76, 126, 98))).toBe(false);
      }
      overlay.destroy();
    } finally {
      Range.prototype.getClientRects = oldRangeRects;
      HTMLElement.prototype.getBoundingClientRect = oldElementRect;
      globalThis.requestAnimationFrame = oldRaf;
      globalThis.cancelAnimationFrame = oldCancel;
      parent.remove();
      doc.destroy();
      vi.restoreAllMocks();
    }
  });
});
