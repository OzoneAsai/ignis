// Screen-space placement shared by the WebUI and native Connector.
// Cursor positions remain authoritative: only their optional name badges move.

const GAP = 3;
const MAX_BADGE_DISTANCE = 96;

function finiteRect(rect) {
  return rect && [rect.left, rect.top, rect.right, rect.bottom]
    .every(Number.isFinite) && rect.right > rect.left &&
    rect.bottom > rect.top;
}

function overlaps(a, b) {
  return a.left < b.right + GAP && a.right + GAP > b.left &&
    a.top < b.bottom + GAP && a.bottom + GAP > b.top;
}

function within(rect, bounds) {
  return rect.left >= bounds.left && rect.top >= bounds.top &&
    rect.right <= bounds.right && rect.bottom <= bounds.bottom;
}

function rectangle(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height };
}

// Both CodeMirror coordinates and DOM measurement rectangles are expressed in
// VISUAL viewport pixels. Absolutely positioned overlays, however, use the
// editor's untransformed CSS layout pixels. Convert every input into one
// coordinate space before any collision tests (including selection marks).
export function createOverlaySpace(host) {
  if (!host?.getBoundingClientRect) return null;
  const visual = host.getBoundingClientRect();
  const width = host.offsetWidth || visual.width;
  const height = host.offsetHeight || visual.height;
  const scaleX = visual.width / width;
  const scaleY = visual.height / height;
  if (!finiteRect(visual) || !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
  const toLocal = (rect) => ({
    left: (rect.left - visual.left) / scaleX,
    top: (rect.top - visual.top) / scaleY,
    right: (rect.right - visual.left) / scaleX,
    bottom: (rect.bottom - visual.top) / scaleY,
  });
  return {
    bounds: rectangle(0, 0, width, height),
    toLocal,
    scaleX,
    scaleY,
  };
}

// Black/white always offers at least 4.58:1 contrast against an opaque RGB
// background, including custom participant colors outside the default palette.
export function cursorLabelTextColor(background) {
  const valid = /^#([a-f0-9]{6})$/i.exec(background || "");
  if (!valid) return "#000000";
  const hex = valid[1];
  const components = [0, 2, 4].map((index) => {
    const c = parseInt(hex.slice(index, index + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = components[0] * 0.2126 +
    components[1] * 0.7152 + components[2] * 0.0722;
  return luminance >= Math.sqrt(0.0525) - 0.05 ? "#000000" : "#ffffff";
}

// The same translucent participant tint is applied by the native CM6 text
// decorations and WebUI's measured glyph fragments. Untrusted peer colors
// never enter a style string without RGB validation.
export function cursorHighlightTint(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || "")) {
    return "rgba(89, 186, 242, 0.24)";
  }
  const channels = [1, 3, 5].map((i) =>
    parseInt(color.slice(i, i + 2), 16));
  return `rgba(${channels.join(", ")}, 0.24)`;
}

function candidates(item, previous) {
  const { caret, width, height } = item;
  const x = caret.left;
  const above = caret.top - height - GAP;
  const below = caret.bottom + GAP;
  const offsets = [0, -width, 9, -width - 9, -width / 2];
  const choices = [];

  // Keep the previous RELATIVE location if it remains safe and near the caret.
  // A badge following a typing cursor should not hop sides on every keystroke.
  if (previous && Number.isFinite(previous.dx) && Number.isFinite(previous.dy) &&
      Math.abs(previous.dx) <= MAX_BADGE_DISTANCE + width &&
      Math.abs(previous.dy) <= MAX_BADGE_DISTANCE) {
    choices.push([x + previous.dx, caret.top + previous.dy]);
  }

  for (const y of [above, below,
    above - height - GAP, below + height + GAP,
    above - 2 * (height + GAP), below + 2 * (height + GAP)]) {
    for (const offset of offsets) choices.push([x + offset, y]);
  }
  // A blank stretch of the same line is often better than covering the line
  // above. These candidates must still pass the text-rectangle test.
  const center = caret.top + (caret.bottom - caret.top - height) / 2;
  choices.push([x + 12, center], [x - width - 12, center]);
  return choices;
}

/**
 * Return a Map of visible badge placements. Missing entries are intentionally
 * hidden badges, not missing collaborators: the caret and people roster stay.
 *
 * Items/obstacles/bounds use the same editor-local CSS pixel coordinates.
 * No persistent identity, CRDT position, editor state or text is modified.
 */
export function layoutCursorLabels(items, obstacles, bounds, previous = new Map()) {
  const placed = new Map();
  if (!finiteRect(bounds)) return placed;
  const reserved = obstacles.filter(finiteRect).slice();

  // Independent of incoming presence message order. A stable priority also
  // prevents two peers oscillating when an otherwise equal slot is available.
  const ordered = [...items].sort((a, b) => a.key.localeCompare(b.key));
  for (const item of ordered) {
    if (!item.caret || !Number.isFinite(item.caret.left) ||
        !Number.isFinite(item.caret.top) ||
        !Number.isFinite(item.caret.bottom) ||
        !Number.isFinite(item.width) || !Number.isFinite(item.height) ||
        item.width <= 0 || item.height <= 0) continue;
    for (const [left, top] of candidates(item, previous.get(item.key))) {
      const rect = rectangle(left, top, item.width, item.height);
      if (!within(rect, bounds) || reserved.some(other => overlaps(rect, other))) {
        continue;
      }
      placed.set(item.key, {
        left, top, dx: left - item.caret.left, dy: top - item.caret.top
      });
      reserved.push(rect);
      break;
    }
  }
  return placed;
}

/**
 * Read the visible editor's text AND non-text occupied geometry (inline
 * images, embeds, widgets, rules, tables). Range fragments account for
 * wrapping, bidirectional and mixed Japanese/Latin text without guessing glyph
 * widths. All inputs/output are in the overlay's untransformed local pixels.
 * Returning null means geometry could not be safely measured, in which case
 * clients retain carets but do not show speculative badges.
 */
export function visibleContentObstacles(contentDOM, space, viewport, limit = 1500) {
  if (!space || !contentDOM?.ownerDocument?.createTreeWalker ||
      !contentDOM.ownerDocument.createRange) return null;
  const doc = contentDOM.ownerDocument;
  const walker = doc.createTreeWalker(contentDOM, doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4);
  const range = doc.createRange();
  const found = [];
  const collect = (viewportRect) => {
    const rect = space.toLocal(viewportRect);
    if (!finiteRect(rect) || !overlaps(rect, viewport)) return true;
    if (found.length >= limit) return false;
    found.push(rect);
    return true;
  };
  let node;
  try {
    while ((node = walker.nextNode())) {
      if (!node.textContent?.length) continue;
      range.selectNodeContents(node);
      for (const fragment of range.getClientRects()) {
        if (!collect(fragment)) return null;
      }
    }
    const occupied = contentDOM.querySelectorAll(
      "img,video,canvas,svg,iframe,object,embed,hr,table,input,textarea," +
      "button,select,[contenteditable='false'],.cm-widget,.cm-widgetBuffer"
    );
    for (const element of occupied) {
      if (!collect(element.getBoundingClientRect())) return null;
    }
    return found;
  } catch {
    return null;
  } finally {
    range.detach?.();
  }
}
