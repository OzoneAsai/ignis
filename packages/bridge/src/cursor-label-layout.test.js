// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createOverlaySpace, cursorLabelTextColor,
  layoutCursorLabels, visibleContentObstacles
} from "./cursor-label-layout.js";

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const badge = (key, x, y, width = 56, height = 18) => ({
  key, caret: { left: x, top: y, bottom: y + 20 }, width, height
});
const bounds = rect(0, 0, 320, 240);
const area = (item, placement) => rect(
  placement.left, placement.top,
  placement.left + item.width, placement.top + item.height
);
const intersects = (a, b) =>
  a.left < b.right && a.right > b.left &&
  a.top < b.bottom && a.bottom > b.top;

describe("shared remote cursor label geometry", () => {
  it("keeps the actual caret fixed and chooses empty space instead of covering text", () => {
    const person = badge("Alice", 80, 82);
    const text = [rect(0, 58, 220, 82)];
    const result = layoutCursorLabels([person], text, bounds);
    expect(result.has("Alice")).toBe(true);
    expect(intersects(area(person, result.get("Alice")), text[0])).toBe(false);
    expect(person.caret).toEqual({ left: 80, top: 82, bottom: 102 });
  });

  it("never places overlapping labels for 20 simultaneous participants", () => {
    const peers = Array.from({ length: 20 }, (_, index) =>
      badge("peer-" + String(index).padStart(2, "0"), 100, 110, 48, 18));
    const result = layoutCursorLabels([...peers].reverse(), [], bounds);
    expect(result.size).toBeGreaterThan(0);
    const visible = peers.filter(peer => result.has(peer.key));
    for (let i = 0; i < visible.length; i++) {
      const a = area(visible[i], result.get(visible[i].key));
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.right).toBeLessThanOrEqual(320);
      for (let j = i + 1; j < visible.length; j++) {
        expect(intersects(a, area(visible[j],
          result.get(visible[j].key)))).toBe(false);
      }
    }
    expect([...layoutCursorLabels(peers, [], bounds).keys()])
      .toEqual([...result.keys()]);
  });

  it("does not cover text when there is no free space", () => {
    const person = badge("blocked", 140, 60);
    const blocked = layoutCursorLabels([person], [rect(0, 0, 320, 240)], bounds);
    expect(blocked.size).toBe(0);
  });

  it("keeps a previous safe relative position while typing", () => {
    const alice = badge("alice", 100, 110);
    const initial = layoutCursorLabels([alice], [], bounds);
    const moved = layoutCursorLabels([badge("alice", 108, 110)], [], bounds, initial);
    expect(moved.get("alice").dx).toBe(initial.get("alice").dx);
    expect(moved.get("alice").dy).toBe(initial.get("alice").dy);
    expect(moved.get("alice").left).toBe(initial.get("alice").left + 8);
  });

  it("stays within editor boundaries when the caret is near corners", () => {
    for (const [x, y] of [[1, 1], [318, 1], [1, 230], [318, 230]]) {
      const item = badge("corner", x, y);
      const value = layoutCursorLabels([item], [], bounds).get("corner");
      if (value) {
        const placed = area(item, value);
        expect(placed.left).toBeGreaterThanOrEqual(bounds.left);
        expect(placed.top).toBeGreaterThanOrEqual(bounds.top);
        expect(placed.right).toBeLessThanOrEqual(bounds.right);
        expect(placed.bottom).toBeLessThanOrEqual(bounds.bottom);
      }
    }
  });

  it("handles bidirectional glyph rectangles and mixed Japanese text as measured", () => {
    const content = document.createElement("div");
    content.innerHTML = "<span>日本語 abc שלום</span>";
    const original = Range.prototype.getClientRects;
    Range.prototype.getClientRects = vi.fn(() => [
      rect(100, 20, 184, 40), rect(22, 42, 82, 62)
    ]);
    try {
      const space = { toLocal: rect => ({
        left: rect.left - 10, top: rect.top - 5,
        right: rect.right - 10, bottom: rect.bottom - 5
      }) };
      const obstacles = visibleContentObstacles(content, space,
        rect(0, 0, 300, 160));
      expect(obstacles).toEqual([
        rect(90, 15, 174, 35), rect(12, 37, 72, 57)
      ]);
    } finally {
      Range.prototype.getClientRects = original;
    }
  });

  it("fails closed when text geometry is unavailable or exceeds the budget", () => {
    expect(visibleContentObstacles(null, null, bounds)).toBeNull();
    const content = document.createElement("div");
    content.textContent = "aaa";
    const original = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [rect(2, 2, 22, 20)];
    try {
      expect(visibleContentObstacles(content, { toLocal: x => x }, bounds, 0)).toBeNull();
    } finally {
      Range.prototype.getClientRects = original;
    }
  });
  it("normalizes CSS scale and nested non-uniform transforms to local pixels", () => {
    const host = document.createElement("div");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      ...rect(30, 60, 530, 360), width: 500, height: 300
    });
    Object.defineProperty(host, "offsetWidth", { value: 400 });
    Object.defineProperty(host, "offsetHeight", { value: 200 });
    const space = createOverlaySpace(host);
    expect(space.scaleX).toBe(1.25);
    expect(space.scaleY).toBe(1.5);
    expect(space.toLocal(rect(155, 90, 280, 120)))
      .toEqual(rect(100, 20, 200, 40));
    expect(space.bounds).toEqual(rect(0, 0, 400, 200));
  });
  it("treats non-text images and embeds as occupied visual geometry", () => {
    const content = document.createElement("div");
    const photo = document.createElement("img");
    const frame = document.createElement("iframe");
    content.append(photo, frame);
    vi.spyOn(photo, "getBoundingClientRect").mockReturnValue(rect(10, 10, 130, 80));
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(140, 20, 280, 100));
    const space = { toLocal: x => x };
    const obstacles = visibleContentObstacles(content, space, bounds);
    expect(obstacles).toEqual([rect(10, 10, 130, 80), rect(140, 20, 280, 100)]);
    const subject = badge("image", 45, 40, 65, 20);
    const placed = layoutCursorLabels([subject], obstacles, bounds).get("image");
    if (placed) {
      expect(obstacles.every(area => !intersects(
        area, rect(placed.left, placed.top, placed.left + subject.width,
          placed.top + subject.height)))).toBe(true);
    }
  });
  it("selects readable black/white text for custom bright and dark peer colors", () => {
    expect(cursorLabelTextColor("#ffffff")).toBe("#000000");
    expect(cursorLabelTextColor("#000000")).toBe("#ffffff");
    expect(cursorLabelTextColor("#59baf2")).toBe("#000000");
    expect(cursorLabelTextColor("#10192b")).toBe("#ffffff");
    const luminance = color => {
      const values = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
      return values.map(x => x <= 0.04045 ? x / 12.92 :
        ((x + 0.055) / 1.055) ** 2.4).reduce((total, x, i) =>
        total + x * [0.2126, 0.7152, 0.0722][i], 0);
    };
    for (let i = 0; i < 256; i++) {
      const bg = "#" + Array.from({ length: 3 }, (_, k) =>
        ((i * 71 + k * 93) % 256).toString(16).padStart(2, "0")).join("");
      const foreground = cursorLabelTextColor(bg);
      const a = luminance(bg), b = luminance(foreground);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});
