import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { visibleSelectionGlyphRects } from "./selection-glyphs.js";

afterEach(() => vi.unstubAllGlobals());

describe("visibleSelectionGlyphRects", () => {
  it("walks the rendered text nodes and measures a partial DOM Range", () => {
    const dom = new JSDOM('<div id="editor">Hello world</div>');
    const { document, Node, NodeFilter } = dom.window;
    vi.stubGlobal("document", document);
    vi.stubGlobal("Node", Node);
    vi.stubGlobal("NodeFilter", NodeFilter);

    // JSDOM implements Range traversal but not layout geometry.
    // Only the measured coordinates are simulated; all Range boundaries and
    // comparePoint/intersectsNode checks are executed by the real DOM API.
    dom.window.Range.prototype.getClientRects = () => [{
      left: 100, right: 140, top: 10, bottom: 30, width: 40, height: 20,
    }];

    const contentDOM = document.getElementById("editor");
    const text = contentDOM.firstChild;
    const cm = {
      contentDOM,
      domAtPos: (offset) => ({ node: text, offset }),
      visibleRanges: [{ from: 0, to: 11 }],
      state: { doc: { length: 11 } },
    };
    const space = { toLocal: (rect) => rect };

    expect(visibleSelectionGlyphRects(cm, space, 1, 5)).toEqual({
      rects: [{ left: 100, top: 10, width: 40, height: 20 }],
      limited: false,
    });
    expect(visibleSelectionGlyphRects(cm, space, 1, 5, 0)).toEqual({
      rects: [],
      limited: true,
    });
    expect(visibleSelectionGlyphRects(cm, space, 5, 5)).toEqual({
      rects: [],
      limited: false,
    });
  });

  it("accepts a nested text glyph inside a taller range line box", () => {
    const dom = new JSDOM(
      '<div id="editor"><span>#</span><span> </span><i></i><i></i><b>Handoff</b></div>',
    );
    const { document, Node, NodeFilter } = dom.window;
    vi.stubGlobal("document", document);
    vi.stubGlobal("Node", Node);
    vi.stubGlobal("NodeFilter", NodeFilter);

    const contentDOM = document.getElementById("editor");
    const headingText = contentDOM.lastChild.firstChild;
    const measuredOffsets = [];
    dom.window.Range.prototype.getClientRects = function () {
      // The parent DOM Range is taller than its actual text glyph.
      if (this.startContainer === contentDOM) {
        return [{ left: 110, right: 150, top: 5, bottom: 35,
          width: 40, height: 30 }];
      }
      measuredOffsets.push([this.startOffset, this.endOffset]);
      return [{ left: 110, right: 150, top: 10, bottom: 28,
        width: 40, height: 18 }];
    };
    const cm = {
      contentDOM,
      domAtPos: (offset) => offset === 1
        ? { node: contentDOM, offset: 4 }
        : { node: headingText, offset: 3 },
      visibleRanges: [{ from: 1, to: 5 }],
      state: { doc: { length: 6 } },
    };

    expect(visibleSelectionGlyphRects(cm, { toLocal: r => r }, 1, 5)).toEqual({
      rects: [{ left: 110, top: 10, width: 40, height: 18 }],
      limited: false,
    });
    expect(measuredOffsets).toEqual([[0, 3]]);
  });
});
