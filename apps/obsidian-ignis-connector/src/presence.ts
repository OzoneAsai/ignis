import * as Y from "yjs";
import {
  MAX_SHARED_SELECTIONS, decodeCursorPosition,
  encodeCursorSelection, encodeCursorSelections,
  selectionEntries as commonSelectionEntries,
  resolveCursorSelection, resolveCursorSelections
} from "../../../packages/bridge/src/collab-cursor-protocol.js";
export { MAX_SHARED_SELECTIONS };
export const encodeSelection = encodeCursorSelection;
export const encodeSelections = encodeCursorSelections;
export const resolveSelection = resolveCursorSelection;
export const resolveSelections = resolveCursorSelections;
import type { EditorView } from "@codemirror/view";
import {
  createOverlaySpace, cursorLabelTextColor, layoutCursorLabels,
  visibleContentObstacles
} from
  "../../../packages/bridge/src/cursor-label-layout.js";
import type { LabelItem, LabelPlacement, LabelRect } from
  "../../../packages/bridge/src/cursor-label-layout.js";
import {
  MAX_REMOTE_MARKS, remoteSelectionField, replaceRemoteMarks,
  type RemoteMark
} from "./selection-decorations";

// Ignis's /ws collab channel already carries ephemeral presence and Yjs
// relative positions. Native Obsidian uses that same protocol; Yjs Awareness
// from y-websocket would be a second, incompatible presence transport.
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

export function selectionEntries(peer: Peer): CursorSelection[] {
  return commonSelectionEntries(peer).filter(
    (entry): entry is CursorSelection => entry !== null
  );
}

function safeSelections(item: Record<string, unknown>): CursorSelection[] {
  if (Array.isArray(item.selections)) {
    if (item.selections.length > MAX_SHARED_SELECTIONS) return [];
    const selections: CursorSelection[] = [];
    for (const entry of item.selections) {
      if (!entry || typeof entry !== "object") return [];
      const anchor = (entry as Record<string, unknown>).anchor;
      const head = (entry as Record<string, unknown>).head;
      if (!decodeCursorPosition(anchor) || !decodeCursorPosition(head)) return [];
      selections.push({ anchor: anchor as string, head: head as string });
    }
    return selections;
  }
  return decodeCursorPosition(item.anchor) && decodeCursorPosition(item.head)
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
    caret: HTMLDivElement; label: HTMLSpanElement;
  }>();
  private readonly lastBadgePositions = new Map<string, LabelPlacement>();
  private peers: Peer[] = [];
  private text: Y.Text | null = null;
  private raf = 0;
  private readonly originalPosition: string;
  private readonly scroll = () => this.schedule();
  private readonly contentMutation: MutationObserver | null;
  private readonly mobileViewportChange = () => {
    this.positionMobileRoster();
    this.schedule();
  };
  private highlightFingerprint = "";
  private highlightEpoch = 0;
  private highlightsLimited = false;

  constructor(private readonly view: EditorView, private readonly mobile = false) {
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
      position: mobile ? "fixed" : "absolute",
      top: mobile ? "auto" : "5px",
      right: mobile ? "auto" : "6px",
      left: mobile ? "max(12px, env(safe-area-inset-left, 0px))" : "auto",
      maxWidth: "min(65vw, 250px)", maxHeight: "42vh",
      overflow: "auto", zIndex: "9", pointerEvents: "auto",
      background: "var(--background-primary, #202127)",
      color: "var(--text-normal, #fff)",
      fontSize: "12px", borderRadius: "5px", padding: "3px 6px",
      boxShadow: "0 1px 5px #0004"
    });
    this.rosterTitle = document.createElement("summary");
    this.rosterTitle.style.cursor = "pointer";
    this.rosterTitle.setAttribute("aria-label", "Open Ignis collaborators");
    if (mobile) {
      Object.assign(this.roster.style, {
        zIndex: "1000", overflow: "visible", padding: "0",
        borderRadius: "12px", boxShadow: "0 3px 18px #0006"
      });
      Object.assign(this.rosterTitle.style, {
        display: "flex", alignItems: "center", minHeight: "44px",
        padding: "0 14px", fontSize: "13px", fontWeight: "600",
        touchAction: "manipulation", whiteSpace: "nowrap"
      });
    }
    this.roster.appendChild(this.rosterTitle);
    this.rosterList = document.createElement("div");
    this.rosterList.style.maxHeight = "35vh";
    this.rosterList.style.overflowY = "auto";
    if (mobile) {
      Object.assign(this.rosterList.style, {
        position: "absolute", bottom: "calc(100% + 8px)", left: "0",
        minWidth: "min(78vw, 240px)", maxWidth: "min(86vw, 300px)",
        padding: "8px", borderRadius: "10px",
        background: "var(--background-primary, #202127)",
        boxShadow: "0 4px 18px #0006"
      });
    }
    this.roster.appendChild(this.rosterList);
    // CM6's scrolling editor can clip the old top-right popup on iOS.
    // A mobile floating action lives in the visual viewport, not the editor.
    if (mobile) {
      document.body.appendChild(this.roster);
      this.positionMobileRoster();
      window.visualViewport?.addEventListener("resize", this.mobileViewportChange);
      window.visualViewport?.addEventListener("scroll", this.mobileViewportChange);
    } else {
      view.dom.appendChild(this.roster);
    }
    view.scrollDOM.addEventListener("scroll", this.scroll, { passive: true });
    window.addEventListener("resize", this.scroll);
    if (mobile) window.addEventListener("resize", this.mobileViewportChange);
    this.contentMutation = typeof MutationObserver !== "undefined" && view.contentDOM
      ? new MutationObserver(this.scroll) : null;
    this.contentMutation?.observe(view.contentDOM, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["style", "class"]
    });
    document.fonts?.addEventListener?.("loadingdone", this.scroll);
  }

  private positionMobileRoster() {
    if (!this.mobile) return;
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    // Keep the 44px touch target ABOVE Obsidian's mobile toolbar and the
    // software keyboard, even when iOS changes the visual viewport without
    // changing window.innerHeight.
    const y = (viewport?.offsetTop ?? 0) + height - 104;
    this.roster.style.top = Math.max(12, Math.min(
      window.innerHeight - 56, y
    )) + "px";
    this.rosterList.style.maxHeight = Math.max(88, height - 180) + "px";
  }

  set(text: Y.Text | null, peers: Peer[]) {
    this.text = text;
    this.peers = peers;
    this.syncHighlights();
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
    this.rosterTitle.setAttribute("aria-label", this.rosterTitle.textContent);
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
        padding: this.mobile ? "12px 8px" : "4px",
        minHeight: this.mobile ? "44px" : "auto", cursor: "pointer"
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
    this.nodes.delete(id);
    this.lastBadgePositions.delete(id);
  }

  private clear() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const id of [...this.nodes.keys()]) this.discard(id);
    this.publishHighlights([]);
  }

  private publishHighlights(marks: RemoteMark[]) {
    const fingerprint = JSON.stringify(marks);
    if (fingerprint === this.highlightFingerprint) return;
    this.highlightFingerprint = fingerprint;
    const epoch = ++this.highlightEpoch;
    // Never dispatch a CM6 transaction while its ViewPlugin is updating.
    queueMicrotask(() => {
      if (epoch !== this.highlightEpoch || !this.view.dom.isConnected ||
          !this.view.dispatch || !this.view.state?.field) return;
      try {
        if (this.view.state.field(remoteSelectionField, false) === undefined) return;
        this.view.dispatch({ effects: replaceRemoteMarks.of(marks) });
      } catch {
        // An editor can close between scheduling and the next microtask.
      }
    });
  }

  private syncHighlights() {
    const marks: RemoteMark[] = [];
    this.highlightsLimited = false;
    if (this.text) {
      const length = this.view.state.doc.length;
      for (const peer of this.peers) {
        for (const selection of resolveSelections(this.text, peer)) {
          if (!selection) continue;
          const from = Math.max(0, Math.min(length, selection.anchor, selection.head));
          const to = Math.min(length, Math.max(selection.anchor, selection.head));
          if (from >= to) continue;
          if (marks.length < MAX_REMOTE_MARKS) {
            marks.push({ from, to, color: peer.color });
          } else {
            this.highlightsLimited = true;
          }
        }
      }
    }
    this.publishHighlights(marks);
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
        record = { caret, label };
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
      (this.highlightsLimited ? " · highlights limited" : " · show locations");
    this.rosterTitle.setAttribute("aria-label", this.rosterTitle.textContent);
  }

  destroy() {
    this.clear();
    this.view.scrollDOM.removeEventListener("scroll", this.scroll);
    window.removeEventListener("resize", this.scroll);
    this.contentMutation?.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", this.scroll);
    if (this.mobile) {
      window.visualViewport?.removeEventListener("resize", this.mobileViewportChange);
      window.visualViewport?.removeEventListener("scroll", this.mobileViewportChange);
      window.removeEventListener("resize", this.mobileViewportChange);
    }
    this.root.remove();
    this.roster.remove();
    this.view.dom.style.position = this.originalPosition;
  }
}
