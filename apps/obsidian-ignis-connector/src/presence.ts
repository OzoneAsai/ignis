import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";

// Ignis's /ws collab channel already carries ephemeral presence and Yjs
// relative positions. Native Obsidian uses that same protocol; Yjs Awareness
// from y-websocket would be a second, incompatible presence transport.
const MAX_CURSOR_BYTES = 512;
const MAX_PEERS = 32;
export type Peer = {
  id: string;
  name: string;
  color: string;
  anchor: string | null;
  head: string | null;
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
    return Uint8Array.from(raw, c => c.charCodeAt(0));
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
  for (const item of input.slice(0, MAX_PEERS * 4)) {
    if (!item || typeof item !== "object" ||
        typeof item.id !== "string" || item.id.length > 128 ||
        !item.id || item.id === selfId || unique.has(item.id)) continue;
    unique.add(item.id);
    peers.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name.slice(0, 40) : "Peer",
      color: typeof item.color === "string" &&
        /^#[a-fA-F0-9]{6}$/.test(item.color) ? item.color : "#59baf2",
      anchor: typeof item.anchor === "string" ? item.anchor : null,
      head: typeof item.head === "string" ? item.head : null
    });
    if (peers.length === MAX_PEERS) break;
  }
  return peers;
}

export class CursorOverlay {
  private readonly root: HTMLDivElement;
  private readonly nodes = new Map<string, {
    caret: HTMLDivElement; label: HTMLSpanElement; marks: HTMLSpanElement[];
  }>();
  private peers: Peer[] = [];
  private text: Y.Text | null = null;
  private raf = 0;
  private readonly originalPosition: string;
  private readonly scroll = () => this.schedule();

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
    view.scrollDOM.addEventListener("scroll", this.scroll, { passive: true });
    window.addEventListener("resize", this.scroll);
  }

  set(text: Y.Text | null, peers: Peer[]) {
    this.text = text;
    this.peers = peers;
    if (!text || peers.length === 0) {
      this.clear();
    } else {
      this.schedule();
    }
  }

  private discard(id: string) {
    const record = this.nodes.get(id);
    if (!record) return;
    record.caret.remove();
    for (const mark of record.marks) mark.remove();
    this.nodes.delete(id);
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
    const bounds = this.view.dom.getBoundingClientRect();
    const visible = new Set<string>();
    for (const peer of this.peers) {
      const selection = resolveSelection(this.text, peer);
      if (!selection) continue;
      visible.add(peer.id);
      let record = this.nodes.get(peer.id);
      if (!record) {
        const caret = document.createElement("div");
        caret.className = "ignis-native-remote-caret";
        caret.dataset.ignisPeer = peer.id;
        Object.assign(caret.style, {
          position: "absolute", width: "2px", pointerEvents: "none",
          backgroundColor: peer.color
        });
        const label = document.createElement("span");
        label.className = "ignis-native-remote-label";
        Object.assign(label.style, {
          position: "absolute", left: "0", bottom: "100%",
          color: "#fff", backgroundColor: peer.color,
          fontSize: "11px", fontWeight: "600", borderRadius: "3px",
          padding: "2px 5px", whiteSpace: "nowrap", maxWidth: "180px",
          overflow: "hidden", textOverflow: "ellipsis"
        });
        caret.appendChild(label);
        this.root.appendChild(caret);
        record = { caret, label, marks: [] };
        this.nodes.set(peer.id, record);
      }
      record.label.textContent = peer.name;
      record.label.style.backgroundColor = peer.color;
      record.caret.style.backgroundColor = peer.color;
      const at = Math.min(this.view.state.doc.length, selection.head);
      const coords = this.view.coordsAtPos(at);
      const onScreen = !!coords && coords.bottom >= bounds.top &&
        coords.top <= bounds.bottom && coords.right >= bounds.left &&
        coords.left <= bounds.right;
      record.caret.style.display = onScreen ? "" : "none";
      if (coords && onScreen) {
        record.caret.style.left = (coords.left - bounds.left) + "px";
        record.caret.style.top = (coords.top - bounds.top) + "px";
        record.caret.style.height = Math.max(1, coords.bottom - coords.top) + "px";
      }
      const from = Math.max(0, Math.min(selection.anchor, selection.head));
      const to = Math.min(this.view.state.doc.length,
        Math.max(selection.anchor, selection.head));
      const marks: { left: number; top: number; width: number; height: number }[] = [];
      // Visible lines only, bounded to protect large selections on mobile.
      const viewport = this.view.viewport;
      let index = Math.max(from, viewport.from);
      const end = Math.min(to, viewport.to);
      while (index < end && marks.length < 120) {
        const line = this.view.state.doc.lineAt(index);
        const stop = Math.min(end, line.to);
        const a = this.view.coordsAtPos(index);
        const b = this.view.coordsAtPos(stop);
        if (a && b) {
          marks.push({
            left: a.left - bounds.left,
            top: a.top - bounds.top,
            width: Math.max(2, b.left - a.left),
            height: Math.max(1, b.bottom - a.top)
          });
        }
        index = Math.max(index + 1, stop + 1);
      }
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
    for (const id of [...this.nodes.keys()]) {
      if (!visible.has(id)) this.discard(id);
    }
  }

  destroy() {
    this.clear();
    this.view.scrollDOM.removeEventListener("scroll", this.scroll);
    window.removeEventListener("resize", this.scroll);
    this.root.remove();
    this.view.dom.style.position = this.originalPosition;
  }
}
