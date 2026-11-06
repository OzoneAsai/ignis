import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import {
  createOverlaySpace, cursorLabelTextColor, layoutCursorLabels,
  visibleContentObstacles
} from
  "../../../packages/bridge/src/cursor-label-layout.js";
import type { LabelItem, LabelPlacement, LabelRect } from
  "../../../packages/bridge/src/cursor-label-layout.js";

// Ignis's /ws collab channel already carries ephemeral presence and Yjs
// relative positions. Native Obsidian uses that same protocol; Yjs Awareness
// from y-websocket would be a second, incompatible presence transport.
const MAX_CURSOR_BYTES = 512;
export const MAX_SHARED_SELECTIONS = 32;
export type CursorSelection = { anchor: string; head: string };
export type Peer = {
  id: string;
  name: string;
  color: string;
  anchor: string | null;
  head: string | null;
  selections?: CursorSelection[];
  mainIndex?: number;
};

function encodeBytes(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function decodeBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > 688 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const raw = atob(value);
    if (!raw.length || raw.length > MAX_CURSOR_BYTES) return null;
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    // A syntactically valid base64 string need not be a Yjs relative
    // position. Reject corrupt cursor payloads before they reach the DOM.
    const canonical = Y.encodeRelativePosition(Y.decodeRelativePosition(bytes));
    if (canonical.byteLength !== bytes.byteLength ||
        canonical.some((byte, index) => byte !== bytes[index])) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function encodeSelection(text: Y.Text, anchor: number, head: number) {
  const at = (index: number) => encodeBytes(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(
      text, Math.max(0, Math.min(text.length, index))
    )
  ));
  const result = { anchor: at(anchor), head: at(head) };
  if (result.anchor.length > 688 || result.head.length > 688) return null;
  return result;
}

export function encodeSelections(text: Y.Text,
  ranges: ReadonlyArray<{ anchor: number; head: number }>, mainIndex = 0) {
  if (!Array.isArray(ranges) || ranges.length === 0 ||
      ranges.length > MAX_SHARED_SELECTIONS ||
      !Number.isSafeInteger(mainIndex) || mainIndex < 0 ||
      mainIndex >= ranges.length) return null;
  const selections: CursorSelection[] = [];
  for (const range of ranges) {
    const encoded = encodeSelection(text, range.anchor, range.head);
    if (!encoded) return null;
    selections.push(encoded);
  }
  return { selections, mainIndex, ...selections[mainIndex] };
}

export function selectionEntries(peer: Peer): CursorSelection[] {
  if (Array.isArray(peer.selections)) {
    if (peer.selections.length > MAX_SHARED_SELECTIONS) return [];
    return peer.selections;
  }
  return peer.anchor && peer.head ? [{ anchor: peer.anchor, head: peer.head }] : [];
}

export function resolveSelections(text: Y.Text, peer: Peer) {
  return selectionEntries(peer).map(entry => resolveSelection(text, entry));
}

function safeSelections(item: Record<string, unknown>): CursorSelection[] {
  if (Array.isArray(item.selections)) {
    if (item.selections.length > MAX_SHARED_SELECTIONS) return [];
    const selections: CursorSelection[] = [];
    for (const entry of item.selections) {
      if (!entry || typeof entry !== "object") return [];
      const anchor = (entry as Record<string, unknown>).anchor;
      const head = (entry as Record<string, unknown>).head;
      if (!decodeBytes(anchor) || !decodeBytes(head)) return [];
      selections.push({ anchor: anchor as string, head: head as string });
    }
    return selections;
  }
  return decodeBytes(item.anchor) && decodeBytes(item.head)
    ? [{ anchor: item.anchor as string, head: item.head as string }] : [];
}

export function sanitizeCursorMessage(item: unknown): Pick<Peer,
  "anchor" | "head" | "selections" | "mainIndex"> {
  const data = item && typeof item === "object"
    ? item as Record<string, unknown> : {};
  const selections = safeSelections(data);
  const requested = data.mainIndex;
  const mainIndex = Number.isSafeInteger(requested) &&
    (requested as number) >= 0 && (requested as number) < selections.length
    ? requested as number : 0;
  const primary = selections[mainIndex];
  return { selections, mainIndex,
    anchor: primary?.anchor || null, head: primary?.head || null };
}

export function resolveSelection(text: Y.Text, peer: Pick<Peer, "anchor" | "head">) {
  const start = decodeBytes(peer.anchor);
  const end = decodeBytes(peer.head);
  if (!start || !end || !text.doc) return null;
  try {
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(start), text.doc);
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(end), text.doc);
    if (!anchor || !head || anchor.type !== text || head.type !== text) return null;
    return { anchor: anchor.index, head: head.index };
  } catch {
    return null;
  }
}

export function sanitizePeers(input: unknown, selfId: string | null): Peer[] {
  if (!Array.isArray(input)) return [];
  const unique = new Set<string>();
  const peers: Peer[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" ||
        typeof item.id !== "string" || item.id.length > 128 ||
        !item.id || item.id === selfId || unique.has(item.id)) continue;
    unique.add(item.id);
    peers.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name.slice(0, 40) : "Peer",
      color: typeof item.color === "string" &&
        /^#[a-fA-F0-9]{6}$/.test(item.color) ? item.color : "#59baf2",
      ...sanitizeCursorMessage(item)
    });
  }
  return peers;
}

export class CursorOverlay {
  private readonly root: HTMLDivElement;
  private readonly roster: HTMLDetailsElement;
  private readonly rosterTitle: HTMLElement;
  private readonly rosterList: HTMLDivElement;
  private rosterFingerprint = "";
  private readonly nodes = new Map<string, {
    caret: HTMLDivElement; label: HTMLSpanElement; marks: HTMLSpanElement[];
  }>();
  private readonly lastBadgePositions = new Map<string, LabelPlacement>();
  private peers: Peer[] = [];
  private text: Y.Text | null = null;
  private raf = 0;
  private readonly originalPosition: string;
  private readonly scroll = () => this.schedule();
  private readonly contentMutation: MutationObserver | null;

  constructor(private readonly view: EditorView) {
    this.root = document.createElement("div");
    this.root.className = "ignis-native-cursors";
    this.root.setAttribute("aria-hidden", "true");
    Object.assign(this.root.style, {
      position: "absolute", inset: "0", overflow: "hidden",
      pointerEvents: "none", zIndex: "8"
    });
    this.originalPosition = view.dom.style.position;
    if (getComputedStyle(view.dom).position === "static") {
      view.dom.style.position = "relative";
    }
    view.dom.appendChild(this.root);
    this.roster = document.createElement("details");
    this.roster.className = "ignis-native-people-roster";
    Object.assign(this.roster.style, {
      position: "absolute", top: "5px", right: "6px",
      maxWidth: "min(65vw, 250px)", maxHeight: "42vh",
      overflow: "auto", zIndex: "9", pointerEvents: "auto",
      background: "var(--background-primary, #202127)",
      color: "var(--text-normal, #fff)",
      fontSize: "12px", borderRadius: "5px", padding: "3px 6px",
      boxShadow: "0 1px 5px #0004"
    });
    this.rosterTitle = document.createElement("summary");
    this.rosterTitle.style.cursor = "pointer";
    this.roster.appendChild(this.rosterTitle);
    this.rosterList = document.createElement("div");
    this.rosterList.style.maxHeight = "35vh";
    this.rosterList.style.overflowY = "auto";
    this.roster.appendChild(this.rosterList);
    view.dom.appendChild(this.roster);
    view.scrollDOM.addEventListener("scroll", this.scroll, { passive: true });
    window.addEventListener("resize", this.scroll);
    this.contentMutation = typeof MutationObserver !== "undefined" && view.contentDOM
      ? new MutationObserver(this.scroll) : null;
    this.contentMutation?.observe(view.contentDOM, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["style", "class"]
    });
    document.fonts?.addEventListener?.("loadingdone", this.scroll);
  }

  set(text: Y.Text | null, peers: Peer[]) {
    this.text = text;
    this.peers = peers;
    this.updateRoster();
    if (!text || peers.length === 0) {
      this.clear();
    } else {
      this.schedule();
    }
  }

  private updateRoster() {
    this.roster.hidden = this.peers.length === 0;
    this.rosterTitle.textContent = this.peers.length + " other editor" +
      (this.peers.length === 1 ? "" : "s") + " · show locations";
    const fingerprint = this.peers.map(peer =>
      [peer.id, peer.name, peer.color].join(":")).join("|");
    if (fingerprint === this.rosterFingerprint) return;
    this.rosterFingerprint = fingerprint;
    this.rosterList.replaceChildren();
    for (const peer of this.peers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ignis-native-people-jump";
      button.dataset.ignisPeer = peer.id;
      button.textContent = peer.name;
      button.title = "Go to " + peer.name + "'s cursor";
      Object.assign(button.style, {
        display: "block", width: "100%", textAlign: "left",
        color: "var(--text-normal, #fff)",
        background: "transparent", border: "0",
        borderLeft: "3px solid " + peer.color,
        padding: "4px", cursor: "pointer"
      });
      button.addEventListener("click", () => {
        const current = this.peers.find(entry => entry.id === peer.id);
        if (!current || !this.text) return;
        const selections = resolveSelections(this.text, current);
        const main = current.mainIndex ?? 0;
        const head = selections[main]?.head;
        if (head === undefined) return;
        const pos = Math.max(0, Math.min(head, this.view.state.doc.length));
        const block = this.view.lineBlockAt(pos);
        this.view.scrollDOM.scrollTop = Math.max(0,
          block.top - this.view.scrollDOM.clientHeight / 2);
      });
      this.rosterList.appendChild(button);
    }
  }

  private discard(id: string) {
    const record = this.nodes.get(id);
    if (!record) return;
    record.caret.remove();
    for (const mark of record.marks) mark.remove();
    this.nodes.delete(id);
    this.lastBadgePositions.delete(id);
  }

  private clear() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const id of [...this.nodes.keys()]) this.discard(id);
  }

  private schedule() {
    if (!this.raf && this.root.isConnected) {
      this.raf = requestAnimationFrame(() => this.paint());
    }
  }

  private paint() {
    this.raf = 0;
    if (!this.text) return;
    const space = createOverlaySpace(this.view.dom);
    if (!space) {
      for (const item of this.nodes.values()) item.caret.style.display = "none";
      return;
    }
    const bounds = space.bounds;
    const scrollBounds = space.toLocal(this.view.scrollDOM.getBoundingClientRect());
    const viewBounds: LabelRect = {
      left: Math.max(0, scrollBounds.left),
      top: Math.max(0, scrollBounds.top),
      right: Math.min(bounds.right, scrollBounds.right),
      bottom: Math.min(bounds.bottom, scrollBounds.bottom)
    };
    const visible = new Set<string>();
    const badgeItems: (LabelItem & { label: HTMLSpanElement })[] = [];
    const caretBlockers: LabelRect[] = [];
    // A single bounded highlight budget protects iOS when many participants
    // select long documents. All cursors and roster entries still render.
    let remainingMarks = 480;
    let highlightsLimited = false;
    for (const peer of this.peers) {
      const selections = resolveSelections(this.text, peer);
      const mainIndex = Number.isSafeInteger(peer.mainIndex) &&
        (peer.mainIndex as number) >= 0 &&
        (peer.mainIndex as number) < selections.length ? peer.mainIndex! : 0;
      for (const [index, selection] of selections.entries()) {
      if (!selection) continue;
      const key = peer.id + ":" + index;
      visible.add(key);
      let record = this.nodes.get(key);
      if (!record) {
        const caret = document.createElement("div");
        caret.className = "ignis-native-remote-caret";
        caret.dataset.ignisPeer = peer.id;
        caret.dataset.ignisSelection = String(index);
        Object.assign(caret.style, {
          position: "absolute", width: "2px", pointerEvents: "none",
          backgroundColor: peer.color
        });
        const label = document.createElement("span");
        label.className = "ignis-native-remote-label";
        Object.assign(label.style, {
          position: "absolute", left: "0", top: "0",
          color: cursorLabelTextColor(peer.color), backgroundColor: peer.color,
          fontSize: "11px", fontWeight: "600", borderRadius: "3px",
          padding: "2px 5px", whiteSpace: "nowrap", maxWidth: "180px",
          overflow: "hidden", textOverflow: "ellipsis"
        });
        caret.appendChild(label);
        this.root.appendChild(caret);
        record = { caret, label, marks: [] };
        this.nodes.set(key, record);
      }
      record.label.textContent = peer.name;
      record.label.style.display = index === mainIndex ? "" : "none";
      record.label.style.visibility = "hidden";
      record.label.style.color = cursorLabelTextColor(peer.color);
      record.label.style.backgroundColor = peer.color;
      record.caret.style.backgroundColor = peer.color;
      const at = Math.min(this.view.state.doc.length, selection.head);
      const coords = this.view.coordsAtPos(at);
      const local = coords ? space.toLocal(coords) : null;
      const onScreen = !!local && local.bottom >= viewBounds.top &&
        local.top <= viewBounds.bottom && local.right >= viewBounds.left &&
        local.left <= viewBounds.right;
      record.caret.style.display = onScreen ? "" : "none";
      if (local && onScreen) {
        const { left, top, bottom } = local;
        record.caret.style.left = left + "px";
        record.caret.style.top = top + "px";
        record.caret.style.height = Math.max(1, bottom - top) + "px";
        caretBlockers.push({ left: left - 1, top, right: left + 3, bottom });
        if (index === mainIndex && peer.name) {
          const measured = record.label.getBoundingClientRect();
          badgeItems.push({ key, caret: { left, top, bottom },
            width: measured.width / space.scaleX,
            height: measured.height / space.scaleY, label: record.label });
        }
      }
      const from = Math.max(0, Math.min(selection.anchor, selection.head));
      const to = Math.min(this.view.state.doc.length,
        Math.max(selection.anchor, selection.head));
      const marks: { left: number; top: number; width: number; height: number }[] = [];
      // Visible lines only, bounded to protect large selections on mobile.
      const viewport = this.view.viewport;
      let position = Math.max(from, viewport.from);
      const end = Math.min(to, viewport.to);
      if (position < end && remainingMarks === 0) highlightsLimited = true;
      while (position < end &&
        marks.length < Math.min(120, remainingMarks)) {
        const line = this.view.state.doc.lineAt(position);
        const stop = Math.min(end, line.to);
        const a = this.view.coordsAtPos(position);
        const b = this.view.coordsAtPos(stop);
        if (a && b) {
          const first = space.toLocal(a);
          const last = space.toLocal(b);
          marks.push({
            left: first.left,
            top: first.top,
            width: Math.max(2, last.left - first.left),
            height: Math.max(1, last.bottom - first.top)
          });
        }
        position = Math.max(position + 1, stop + 1);
      }
      remainingMarks -= marks.length;
      for (let i = 0; i < marks.length; i++) {
        let mark = record.marks[i];
        if (!mark) {
          mark = document.createElement("span");
          mark.className = "ignis-native-remote-selection";
          Object.assign(mark.style, { position: "absolute", pointerEvents: "none",
            opacity: "0.22" });
          this.root.appendChild(mark);
          record.marks.push(mark);
        }
        Object.assign(mark.style, {
          backgroundColor: peer.color, left: marks[i].left + "px",
          top: marks[i].top + "px", width: marks[i].width + "px",
          height: marks[i].height + "px"
        });
      }
      while (record.marks.length > marks.length) record.marks.pop()!.remove();
      }
    }
    for (const id of [...this.nodes.keys()]) {
      if (!visible.has(id)) this.discard(id);
    }
    const textRects = visibleContentObstacles(this.view.contentDOM, space, viewBounds);
    const obstacles: LabelRect[] = textRects ? [...textRects, ...caretBlockers] : [];
    if (!this.roster.hidden) {
      obstacles.push(space.toLocal(this.roster.getBoundingClientRect()));
    }
    const placements = textRects
      ? layoutCursorLabels(badgeItems, obstacles, viewBounds, this.lastBadgePositions)
      : new Map<string, LabelPlacement>();
    for (const item of badgeItems) {
      const placement = placements.get(item.key);
      if (!placement) continue;
      item.label.style.left = (placement.left - item.caret.left) + "px";
      item.label.style.top = (placement.top - item.caret.top) + "px";
      item.label.style.visibility = "visible";
      this.lastBadgePositions.set(item.key, placement);
    }
    this.rosterTitle.textContent = this.peers.length + " other editor" +
      (this.peers.length === 1 ? "" : "s") +
      (highlightsLimited ? " · highlights limited" : " · show locations");
  }

  destroy() {
    this.clear();
    this.view.scrollDOM.removeEventListener("scroll", this.scroll);
    window.removeEventListener("resize", this.scroll);
    this.contentMutation?.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", this.scroll);
    this.root.remove();
    this.roster.remove();
    this.view.dom.style.position = this.originalPosition;
  }
}
