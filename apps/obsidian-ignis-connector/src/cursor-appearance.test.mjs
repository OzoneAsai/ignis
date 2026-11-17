import { describe, expect, it } from "vitest";
import {
  NORMAL_CURSOR_APPEARANCE, displayCursorColor, cursorPaintStyle,
  safeCalmCursorWidth
} from "./cursor-appearance.ts";

describe("Calm cursor is a local visual presentation, not a transport identity", () => {
  it("keeps the server-assigned peer color and standard 2px caret unchanged by default", () => {
    const color = "#ee6b72";
    expect(displayCursorColor(color, false, false)).toBe(color);
    expect(cursorPaintStyle(color, NORMAL_CURSOR_APPEARANCE)).toMatchObject({
      color, width: 2, highlightOpacity: 0.24,
      labelFontSize: "11px", labelFontWeight: "600"
    });
  });
  it("uses low-chroma dark/slate tones with a 1px caret and subdued selection", () => {
    const standard = cursorPaintStyle("#ff0000", { calm: false, width: 1 });
    const calm = cursorPaintStyle("#ff0000", { calm: true, width: 1 });
    expect(standard.color).toBe("#ff0000");
    expect(standard.width).toBe(2);
    expect(calm.width).toBe(1);
    expect(calm.highlightOpacity).toBeLessThan(standard.highlightOpacity);
    expect(calm.labelFontSize).toBe("10px");
    expect(calm.labelFontWeight).toBe("500");
    expect(calm.color).toMatch(/^#[0-9a-f]{6}$/);
    const rgb = [1,3,5].map(i => parseInt(calm.color.slice(i,i+2),16));
    expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(65);
    expect(Math.max(...rgb)).toBeLessThan(125);
  });
  it("adjusts for dark themes without using vivid colors or hiding peer identities", () => {
    const light = cursorPaintStyle("#00ff00", { calm: true, width: 1 }, false);
    const dark = cursorPaintStyle("#00ff00", { calm: true, width: 1 }, true);
    expect(dark.color).not.toBe(light.color);
    const intensity = hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16))
      .reduce((a,b)=>a+b,0);
    expect(intensity(dark.color)).toBeGreaterThan(intensity(light.color));
    expect(displayCursorColor("#000000", true, false))
      .not.toBe(displayCursorColor("#ffffff", true, false));
  });
  it("normalizes malformed colors and widths without executing CSS input", () => {
    expect(displayCursorColor("url(javascript:1)", true, false)).toMatch(/^#[0-9a-f]{6}$/);
    for (const value of [0,4,1.5,null,undefined,"1",NaN,Infinity]) {
      expect(safeCalmCursorWidth(value)).toBe(1);
    }
    for (const value of [1,2,3]) {
      expect(safeCalmCursorWidth(value)).toBe(value);
    }
    expect(cursorPaintStyle("#59baf2", { calm: true, width: 3 }).width).toBe(3);
  });
});
