// Shared across Ignis WebUI and the native Obsidian Connector. A cursor is
// an ephemeral Yjs-relative text location, never an absolute pixel or a
// device identity. The server consumes the same wire-limit JSON.
import * as Y from "yjs";
import limits from "../../server-core/src/collab-cursor-limits.json";

export const MAX_SHARED_SELECTIONS = limits.maxSelections;
export const MAX_CURSOR_ENCODED_CHARS = limits.maxEncodedCursorChars;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encodeBytes(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(raw);
}

export function decodeCursorPosition(value) {
  if (typeof value !== "string" || !value ||
      value.length > MAX_CURSOR_ENCODED_CHARS || !BASE64.test(value)) return null;
  try {
    const raw = atob(value);
    if (!raw || raw.length > limits.maxDecodedCursorBytes) return null;
    const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
    const canonical = Y.encodeRelativePosition(Y.decodeRelativePosition(bytes));
    if (canonical.length !== bytes.length ||
        canonical.some((byte, i) => byte !== bytes[i])) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function encodeCursorSelection(text, anchor, head) {
  const at = (index) => encodeBytes(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(
      text, Math.max(0, Math.min(text.length, index))
    )));
  const result = { anchor: at(anchor), head: at(head) };
  return decodeCursorPosition(result.anchor) && decodeCursorPosition(result.head)
    ? result : null;
}

export function encodeCursorSelections(text, ranges, mainIndex = 0) {
  if (!Array.isArray(ranges) || ranges.length < 1 ||
      ranges.length > MAX_SHARED_SELECTIONS ||
      !Number.isSafeInteger(mainIndex) || mainIndex < 0 ||
      mainIndex >= ranges.length) return null;
  const selections = [];
  for (const selection of ranges) {
    if (!selection || !Number.isSafeInteger(selection.anchor) ||
        !Number.isSafeInteger(selection.head)) return null;
    const encoded = encodeCursorSelection(text, selection.anchor, selection.head);
    if (!encoded) return null;
    selections.push(encoded);
  }
  return { selections, mainIndex, ...selections[mainIndex] };
}

export function selectionEntries(peer) {
  const entries = Array.isArray(peer?.selections)
    ? peer.selections
    : peer?.anchor != null && peer?.head != null
      ? [{ anchor: peer.anchor, head: peer.head }] : [];
  if (entries.length > MAX_SHARED_SELECTIONS) return [];
  return entries.map(entry => entry && decodeCursorPosition(entry.anchor) &&
    decodeCursorPosition(entry.head) ? { anchor: entry.anchor, head: entry.head } : null);
}

export function resolveCursorSelection(text, entry) {
  const start = decodeCursorPosition(entry?.anchor);
  const end = decodeCursorPosition(entry?.head);
  if (!start || !end || !text?.doc) return null;
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(start), text.doc);
    const b = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(end), text.doc);
    if (!a || !b || a.type !== text || b.type !== text) return null;
    return { anchor: a.index, head: b.index };
  } catch {
    return null;
  }
}

export function resolveCursorSelections(text, peer) {
  return selectionEntries(peer).map(entry => resolveCursorSelection(text, entry));
}
