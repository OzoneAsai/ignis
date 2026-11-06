// Browser-side adapter for the host CodeMirror EditorView. Do not bundle a
// second instance of @codemirror/state into the Ignis bridge: a StateEffect
// from another copy is not recognized by Obsidian's editor. Instead, map
// semantic document offsets to actual rendered text nodes with domAtPos and
// measure only those glyphs with DOM Range. The native Connector uses the
// equivalent document ranges as CM6 Decoration.mark extensions.
export const MAX_GLYPH_FRAGMENTS = 480;

export function visibleSelectionGlyphRects(cm, space, from, to, budget = MAX_GLYPH_FRAGMENTS) {
  if (!cm?.contentDOM || typeof cm.domAtPos !== "function" ||
      !space?.toLocal || typeof document === "undefined" ||
      !Number.isFinite(from) || !Number.isFinite(to)) return { rects: [], limited: false };
  const length = cm.state?.doc?.length ?? 0;
  const start = Math.max(0, Math.min(length, from));
  const end = Math.max(0, Math.min(length, to));
  if (start >= end) return { rects: [], limited: false };
  const visible = Array.isArray(cm.visibleRanges) ? cm.visibleRanges :
    [cm.viewport || { from: 0, to: length }];
  const fragments = [];
  // Bound traversal even when CodeMirror exposes a very large viewport.
  let inspected = 0;
  const maxTextNodes = Math.max(300, Math.min(4000, budget * 8));

  for (const range of visible) {
    const left = Math.max(start, range.from);
    const right = Math.min(end, range.to);
    if (left >= right) continue;
    let selection;
    let a;
    try {
      a = cm.domAtPos(left);
      const b = cm.domAtPos(right);
      selection = document.createRange();
      selection.setStart(a.node, a.offset);
      selection.setEnd(b.node, b.offset);
      if (selection.collapsed) continue;
    } catch {
      continue;
    }
    // Measuring individual text nodes can expose trailing collapsed
    // whitespace that the complete selection Range does not paint. The
    // complete Range is the semantic clipping boundary; the per-text-node
    // fragments merely subdivide its actual rendered glyphs.
    const selectionBounds = [...selection.getClientRects()].filter(rect =>
      rect.width > 0.25 && rect.height > 0.5);
    const walker = document.createTreeWalker(
      cm.contentDOM, NodeFilter.SHOW_TEXT
    );
    // Start at the first endpoint rather than rescanning the entire
    // CodeMirror viewport for each remote selection.
    let node;
    if (cm.contentDOM.contains(a.node)) {
      walker.currentNode = a.node;
      node = a.node.nodeType === Node.TEXT_NODE ? a.node : walker.nextNode();
    } else {
      node = walker.nextNode();
    }
    while (node && inspected++ < maxTextNodes) {
      if (selection.comparePoint(node, 0) > 0) break;
      if (!selection.intersectsNode(node) || !node.textContent) {
        node = walker.nextNode();
        continue;
      }
      const size = node.textContent.length;
      // Text-node boundaries are exact DOM Range offsets. A binary search
      // through comparePoint is lossy at the inclusive end boundary and can
      // add one unselected glyph to the measured highlight.
      const startOffset = selection.startContainer === node
        ? selection.startOffset : 0;
      const endOffset = selection.endContainer === node
        ? selection.endOffset : size;
      if (startOffset < endOffset) {
        const textRange = document.createRange();
        textRange.setStart(node, startOffset);
        textRange.setEnd(node, endOffset);
        for (const rect of textRange.getClientRects()) {
          if (rect.width <= 0.25 || rect.height <= 0.5) continue;
          if (!selectionBounds.some(bound => {
            // A DOM Range can return a line-box rectangle while the text
            // node's glyph rectangle is shorter (notably in Markdown
            // headings). Require the glyph to overlap that painted row,
            // rather than requiring identical vertical bounds.
            const verticalOverlap = Math.min(rect.bottom, bound.bottom) -
              Math.max(rect.top, bound.top);
            return verticalOverlap > Math.min(rect.height, bound.height) / 2 &&
              rect.left >= bound.left - 1 && rect.right <= bound.right + 1;
          })) {
            continue;
          }
          const pos = space.toLocal(rect);
          if (fragments.length >= budget) {
            return { rects: fragments, limited: true };
          }
          fragments.push({
            left: pos.left, top: pos.top,
            width: Math.max(0, pos.right - pos.left),
            height: Math.max(0, pos.bottom - pos.top),
          });
        }
      }
      node = walker.nextNode();
    }
    if (inspected >= maxTextNodes) break;
  }
  return { rects: fragments, limited: false };
}
