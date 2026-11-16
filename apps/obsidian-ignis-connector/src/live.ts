import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap, ySyncAnnotation } from "y-codemirror.next";
import {
  CursorOverlay, encodeSelections, sanitizePeers, sanitizeCursorMessage,
  resolveSelections, type Peer, type CursorSelection
} from "./presence";
import { remoteSelectionExtension } from "./selection-decorations";
import { independentCompositionDelta } from "../../../packages/bridge/src/composition-rebase.js";
import { hasMissingYjsAncestors, causalRepairDelay,
  MAX_CAUSAL_REPAIR_ATTEMPTS } from "../../../packages/bridge/src/causal-history.js";
import { rebasePrejoinText, deltaForText, textEdits } from "./prejoin-rebase";

// Native Obsidian, mobile included, uses the same Yjs wire protocol as Ignis
// Bridge. We only install the CM6 binding after checking native file content,
// so a stale local file cannot overwrite a recently updated remote document.
const REMOTE = Symbol("ignis-remote");
const UNDO_BOUNDARY_REPAIR = Symbol("ignis-undo-boundary-repair");
function liveBoundary(doc: Y.Doc, position: Y.RelativePosition): number | null {
  // RelativePosition resolves even when its target struct was deleted:
  // Yjs then moves to a neighbour. That is fine for cursors, but NOT
  // proof that an Undo insertion belongs next to the same surviving text.
  // Only rewrite the inverse transaction while the original right-hand
  // item still exists. If the peer removed the item, preserve the normal
  // CRDT result and avoid guessing the intended position.
  if (!position.item) return null;
  const item = Y.getItem(doc.store, position.item);
  if (!item || item.deleted) return null;
  return Y.createAbsolutePositionFromRelativePosition(position, doc)?.index ?? null;
}
const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_COMPOSITION_BUFFER_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type WireMessage = {
  channel: "collab";
  type: string;
  path?: string;
  documentId?: string;
  state?: string;
  update?: string;
  seq?: number;
  error?: string;
  self?: Peer;
  people?: Peer[];
  id?: string;
  anchor?: string | null;
  head?: string | null;
  selections?: CursorSelection[];
  mainIndex?: number;
  name?: string;
};

export type UndoReview = {
  path: string;
  documentId: string | null;
  operation: "undo" | "redo";
  deleted: string;
  reason: "boundary-removed" | "target-changed";
  // Read-only context for the person reviewing the edit. It is never used
  // as a guessed insertion position or an automatic patch.
  context: string;
};
type Room = {
  path: string;
  preJoinBase: string | null;
  documentId: string | null;
  wasKnown: boolean;
  doc: Y.Doc | null;
  text: Y.Text | null;
  undo: Y.UndoManager | null;
  persistence: IndexeddbPersistence | null;
  hydrated: boolean;
  hydration: Promise<void> | null;
  views: Set<EditorView>;
  initializing: boolean;
  joined: boolean;
  blocked: boolean;
  composing: boolean;
  imeGuard: { from: number; to: number } | null;
  pendingHandshake: boolean;
  waiting: Uint8Array[];
  waitingBytes: number;
  sentSeq: number;
  savedSeq: number;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  causalRepairAttempts: number;
  causalRepairTimer: ReturnType<typeof setTimeout> | null;
  snapshot: string | null;
  selfId: string | null;
  peers: Map<string, Peer>;
  cursorTimer: ReturnType<typeof setTimeout> | null;
  lastCursor: string | null;
  undoIntent: {
    stackItem: unknown;
    deleted: string;
    right: Y.RelativePosition;
    manual?: boolean;
  } | null;
  redoIntent: {
    deleted: string;
    right: Y.RelativePosition;
    manual?: boolean;
  } | null;
  undoReview: UndoReview | null;
};

function encode(update: Uint8Array): string {
  let result = "";
  const step = 8192;
  for (let i = 0; i < update.length; i += step) {
    result += String.fromCharCode(...update.subarray(i, i + step));
  }
  return btoa(result);
}
function decode(input: unknown): Uint8Array {
  if (typeof input !== "string" || input.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4) {
    throw new Error("Oversized or invalid collaboration frame");
  }
  const data = atob(input);
  if (data.length > MAX_FRAME_BYTES) throw new Error("Oversized collaboration frame");
  return Uint8Array.from(data, (char) => char.charCodeAt(0));
}

function newRoom(path: string, documentId: string | null): Room {
  return {
    path, documentId, wasKnown: !!documentId, preJoinBase: null,
    doc: null, text: null, undo: null,
    persistence: null, hydrated: false, hydration: null, views: new Set(),
    initializing: false, joined: false, blocked: false,
    composing: false, imeGuard: null,
    pendingHandshake: false, waiting: [], waitingBytes: 0,
    sentSeq: 0, savedSeq: 0,
    retryCount: 0, retryTimer: null,
    causalRepairAttempts: 0, causalRepairTimer: null,
    snapshot: null, selfId: null, peers: new Map(),
    cursorTimer: null, lastCursor: null,
    undoIntent: null, redoIntent: null, undoReview: null
  };
}

export class NativeYjs {
  private readonly rooms = new Map<string, Room>();
  private readonly paths = new Map<EditorView, string>();
  private readonly bound = new Map<EditorView, Room>();
  private readonly overlays = new Map<EditorView, CursorOverlay>();
  private readonly compartment = new Compartment();
  private online = false;
  private disposed = false;

  constructor(private readonly opts: {
    vaultId: () => string;
    origin: () => string;
    pathForView: (view: EditorView) => string | null;
    knownId: (path: string) => string | null;
    fileBaseline?: (path: string) => { hash: string; generationId: string } | null;
    rememberId: (path: string, id: string) => Promise<void>;
    displayName?: () => string;
    mobile?: boolean;
    send: (message: WireMessage) => void;
    notify: (path: string, status: string) => void;
    compositionChanged?: (path: string) => void;
  }) {}

  compositionState(path: string | null): {
    composing: boolean; peerEditWaiting: boolean
  } {
    const room = path ? this.rooms.get(path) : undefined;
    return {
      composing: room?.composing === true,
      peerEditWaiting: !!(room?.composing && room.waiting.length)
    };
  }

  extension() {
    const manager = this;
    return [
      this.compartment.of([]),
      remoteSelectionExtension,
      ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {
          manager.observe(view);
        }
        update(update: ViewUpdate) {
          manager.observe(update.view);
          if (update.docChanged) manager.trackImeRange(update);
          if (update.docChanged) manager.captureLocalUndoIntent(update);
          if (update.selectionSet || update.docChanged || update.focusChanged) {
            manager.selectionChanged(update.view);
          }
        }
        destroy() {
          manager.forget(this.view);
        }
      }, {
        eventHandlers: {
          compositionstart(_event, view) { manager.setComposing(view, true); return false; },
          compositionend(_event, view) {
            // Let Obsidian commit the final IME transaction before applying
            // delayed remote changes to the composing DOM.
            setTimeout(() => manager.setComposing(view, false), 0);
            return false;
          }
        }
      })
    ];
  }

  private getPath(view: EditorView): string | null {
    try {
      const path = this.opts.pathForView(view);
      return typeof path === "string" && path.toLowerCase().endsWith(".md") &&
        !path.includes("\\") && !path.includes("\0") &&
        !path.startsWith("/") &&
        !path.split("/").some((part) =>
          [".obsidian", ".git", ".ignis-connector", ".trash"].includes(
            part.toLowerCase()))
        ? path : null;
    } catch { return null; }
  }

  private observe(view: EditorView) {
    if (this.disposed) return;
    const path = this.getPath(view);
    const oldPath = this.paths.get(view);
    if (oldPath === path) return;
    if (oldPath) {
      const old = this.rooms.get(oldPath);
      old?.views.delete(view);
      this.paths.delete(view);
      this.bound.delete(view);
      this.overlays.get(view)?.destroy();
      this.overlays.delete(view);
      // Reconfiguration is deferred to avoid dispatching during CM6 update.
      queueMicrotask(() => {
        if (view.dom.isConnected && !this.disposed) {
          view.dispatch({ effects: this.compartment.reconfigure([]) });
        }
      });
      if (old && old.views.size === 0 && old.joined) {
        this.clearCausalRepair(old);
        this.sendCursorAway(old);
        this.opts.send({ channel: "collab", type: "leave", path: old.path });
        old.joined = false;
        this.clearPeers(old);
      }
    }
    if (!path) return;
    this.paths.set(view, path);
    let room = this.rooms.get(path);
    if (!room) {
      const id = this.opts.knownId(path);
      room = newRoom(path, id);
      room.preJoinBase = view.state.doc.toString();
      this.rooms.set(path, room);
      if (id) void this.hydrate(room, id);
    }
    room.views.add(view);
    this.refreshPeers(room);
    this.tryAttach(room);
    if (this.online) this.join(room);
  }

  private forget(view: EditorView) {
    const path = this.paths.get(view);
    if (!path) return;
    this.paths.delete(view);
    this.bound.delete(view);
    this.overlays.get(view)?.destroy();
    this.overlays.delete(view);
    const room = this.rooms.get(path);
    if (!room) return;
    room.views.delete(view);
    if (room.views.size === 0 && room.joined) {
      this.clearCausalRepair(room);
      this.sendCursorAway(room);
      this.opts.send({ channel: "collab", type: "leave", path });
      room.joined = false;
      this.clearPeers(room);
    }
  }

  private async hydrate(room: Room, id: string) {
    if (room.initializing || room.hydrated || this.disposed) return;
    room.initializing = true;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const undo = new Y.UndoManager(text, { captureTimeout: 500 });
    // CRDT history belongs to the document generation, not to a filename.
    // A rename must not strand unacknowledged offline edits in an old path.
    const key = ["ignis-connector-yjs-v2", this.opts.origin(),
      this.opts.vaultId(), id].join("|");
    const persistence = new IndexeddbPersistence(key, doc);
    room.doc = doc;
    room.text = text;
    room.undo = undo;
    room.persistence = persistence;
    doc.on("update", (update, origin) => {
      if (origin !== REMOTE && origin !== persistence &&
          room.joined && !room.blocked && this.online) {
        this.sendUpdate(room, update);
      }
      if (room.peers.size) this.refreshPeers(room);
    });
    const hydrateTask = async () => {
      try {
        await persistence.whenSynced;
        // Upgrade old path-based caches exactly once. An old cache's Yjs
        // operations are idempotent and are merged, never substituted.
        if (room.wasKnown && await persistence.get("legacy-v1-imported") !== "yes") {
          const legacyKey = ["ignis-connector-yjs-v1", this.opts.origin(),
            this.opts.vaultId(), room.path, id].join("|");
          const oldDoc = new Y.Doc();
          const legacy = new IndexeddbPersistence(legacyKey, oldDoc);
          try {
            await legacy.whenSynced;
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(oldDoc), REMOTE);
            await persistence.set("legacy-v1-imported", "yes");
          } finally {
            await legacy.destroy();
            oldDoc.destroy();
          }
        }
        if (this.disposed || room.documentId !== id) return;
        room.hydrated = true;
        // New sessions have no local history until server initialization.
        if (room.wasKnown) this.tryAttach(room);
      } catch {
        room.blocked = true;
        this.opts.notify(room.path, "Local Yjs cache unavailable; native text preserved");
      } finally {
        room.initializing = false;
      }
    };
    room.hydration = hydrateTask();
    await room.hydration;
  }

  private tryAttach(room: Room) {
    if (room.blocked || !room.hydrated || !room.text) return;
    for (const view of room.views) {
      if (this.bound.get(view) === room) continue;
      if (view.state.doc.toString() !== room.text.toString()) {
        // No blind full-document replace, even when the Yjs cache exists.
        this.opts.notify(room.path, "Native file and Yjs state differ; review required");
        continue;
      }
      this.bound.set(view, room);
      const extension = [
        yCollab(room.text, null, { undoManager: room.undo! }),
        Prec.highest(keymap.of([
          { key: "Mod-z", run: (v) => this.undoNative(v) },
          { key: "Mod-Shift-z", run: (v) => this.redoNative(v) },
          { key: "Mod-y", run: (v) => this.redoNative(v) },
          ...yUndoManagerKeymap.filter(binding =>
            !["Mod-z", "Mod-Shift-z", "Mod-y"].includes(binding.key || ""))
        ]))
      ];
      queueMicrotask(() => {
        if (this.disposed || this.paths.get(view) !== room.path ||
            this.bound.get(view) !== room) return;
        if (view.state.doc.toString() !== room.text?.toString()) {
          this.bound.delete(view);
          this.opts.notify(room.path, "Editor changed during collaboration setup");
          return;
        }
        view.dispatch({ effects: this.compartment.reconfigure(extension) });
        this.refreshPeers(room);
        this.selectionChanged(view);
      });
    }
  }

  private captureLocalUndoIntent(update: ViewUpdate) {
    const room = this.bound.get(update.view);
    if (!room?.text || !room.undo) return;
    if (update.transactions.some(tx => tx.annotation(ySyncAnnotation))) return;
    room.redoIntent = null;
    // Undo stack items are the atomic units of Yjs history. Associate a
    // single native deletion with its exact stack entry, never infer
    // intent from identical text elsewhere in the document.
    const transactions = update.transactions.filter(tx => tx.docChanged);
    if (transactions.length !== 1 ||
        room.text.toString() !== update.state.doc.toString()) {
      room.undoIntent = null;
      return;
    }
    const changes: Array<{fromB:number;toB:number;deleted:string}> = [];
    const tx = transactions[0];
    tx.changes.iterChanges((fromA, toA, fromB, toB) => {
      changes.push({fromB,toB,deleted:tx.startState.doc.sliceString(fromA,toA)});
    });
    const change = changes.length === 1 ? changes[0] : null;
    if (!change || !change.deleted || change.fromB !== change.toB) {
      room.undoIntent = null;
      return;
    }
    const item = room.undo.undoStack.at(-1);
    if (!item) return;
    room.undoIntent = {
      stackItem: item, deleted: change.deleted,
      // Assoc=0 attaches to the surviving RIGHT-hand character. Unlike
      // a raw offset or the deleted left context, it survives a concurrent
      // replacement of text immediately before the boundary.
      right: Y.createRelativePositionFromTypeIndex(room.text, change.fromB, 0)
    };
  }

  pendingUndoReviews(): UndoReview[] {
    return [...this.rooms.values()].flatMap(room =>
      room.undoReview ? [{ ...room.undoReview }] : []);
  }

  dismissUndoReview(path: string, documentId: string | null): boolean {
    const room = this.rooms.get(path);
    if (!room?.undoReview || room.undoReview.documentId !== documentId) return false;
    room.undoReview = null;
    return true;
  }

  private requestUndoReview(room: Room, operation: "undo" | "redo",
    deleted: string, reason: UndoReview["reason"]) {
    const text = room.text?.toString() || "";
    const previous = room.undoReview;
    room.undoReview = {
      path: room.path, documentId: room.documentId, operation, deleted, reason,
      context: text.length <= 240 ? text : text.slice(0, 100) +
        "\n[…]\n" + text.slice(-100)
    };
    // A repeated keypress must not launch an endless series of notices.
    if (!previous || previous.reason !== reason ||
        previous.deleted !== deleted || previous.operation !== operation) {
      this.opts.notify(room.path,
        (operation === "undo" ? "Undo" : "Redo") +
        " needs review · open Ignis collaborators to inspect the original text");
    }
  }

  undoNative(view: EditorView): boolean {
    const room = this.bound.get(view);
    if (!room?.text || !room.doc || !room.undo) return false;
    if (room.undoIntent?.manual) {
      const intent = room.undoIntent;
      const at = liveBoundary(room.doc, intent.right);
      if (at === null) {
        this.requestUndoReview(room, "undo", intent.deleted, "boundary-removed");
        return true;
      }
      room.doc.transact(() => room.text!.insert(at,intent.deleted),
        UNDO_BOUNDARY_REPAIR);
      room.undoIntent = null;
      room.redoIntent = {deleted:intent.deleted,right:intent.right,manual:true};
      return true;
    }
    if (!room.undo.undoStack.length) return false;
    const intent = room.undoIntent?.stackItem === room.undo.undoStack.at(-1)
      ? room.undoIntent : null;
    if (intent && liveBoundary(room.doc,intent.right) === null) {
      // A peer erased the actual CRDT item that identified the right side
      // of this deletion. The inverse has no provable target. Consuming the
      // keypress (true) also prevents Obsidian's fallback undo from applying
      // a different, potentially destructive history operation.
      this.requestUndoReview(room, "undo", intent.deleted, "boundary-removed");
      return true;
    }
    room.undoIntent = null;
    const insertions: Array<{at:number;text:string}> = [];
    const observe = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin !== room.undo) return;
      let at = 0;
      for (const part of event.delta) {
        if (part.retain) at += part.retain;
        if (part.insert && typeof part.insert === "string") {
          insertions.push({at,text:part.insert});
          at += part.insert.length;
        }
      }
    };
    room.text.observe(observe);
    try { room.undo.undo(); }
    finally { room.text.unobserve(observe); }
    if (!intent) return true;
    const inserted = insertions.length === 1 ? insertions[0] : null;
    if (!inserted || inserted.text !== intent.deleted) return true;
    const atRight = liveBoundary(room.doc, intent.right);
    if (atRight === null) return true;
    if (inserted.at + inserted.text.length !== atRight) {
      // The user's deleted span was resurrected before a peer's newly
      // replaced text. Reposition the exact undo insertion to its surviving
      // right boundary, rather than silently splitting that peer's edit.
      room.doc.transact(() => {
        room.text!.delete(inserted.at,inserted.text.length);
        const corrected = liveBoundary(room.doc!,intent.right);
        if (corrected !== null) room.text!.insert(corrected,intent.deleted);
      }, UNDO_BOUNDARY_REPAIR);
      room.redoIntent = { deleted: intent.deleted, right: intent.right };
    }
    return true;
  }

  redoNative(view: EditorView): boolean {
    const room = this.bound.get(view);
    if (!room?.undo || !room.text || !room.doc) return false;
    if (room.redoIntent?.manual) {
      const intent = room.redoIntent;
      const atRight = liveBoundary(room.doc,intent.right);
      const at = atRight === null ? -1 : atRight-intent.deleted.length;
      if (atRight === null || at < 0 ||
          room.text.toString().slice(at,atRight) !== intent.deleted) {
        this.requestUndoReview(room, "redo", intent.deleted, "target-changed");
        return true;
      }
      room.doc.transact(() => room.text!.delete(at,intent.deleted.length),
        UNDO_BOUNDARY_REPAIR);
      room.undoIntent = {stackItem:null,deleted:intent.deleted,
        right:intent.right,manual:true};
      room.redoIntent = null;
      return true;
    }
    if (!room.undo.redoStack.length) return false;
    const intent = room.redoIntent;
    if (intent && liveBoundary(room.doc,intent.right) === null) {
      this.requestUndoReview(room, "redo", intent.deleted, "boundary-removed");
      return true;
    }
    room.redoIntent = null;
    room.undo.redo();
    if (intent) {
      const atRight = liveBoundary(room.doc,intent.right);
      const at = atRight === null ? -1 : atRight-intent.deleted.length;
      if (atRight !== null && at >= 0 &&
          room.text.toString().slice(at,atRight) === intent.deleted) {
        room.doc.transact(() => room.text!.delete(at,intent.deleted.length),
          UNDO_BOUNDARY_REPAIR);
      }
      const stackItem = room.undo.undoStack.at(-1);
      room.undoIntent = { ...intent,stackItem:stackItem||null,manual:!stackItem };
    }
    return true;
  }

  private setComposing(view: EditorView, state: boolean) {
    const path = this.paths.get(view);
    const room = path && this.rooms.get(path);
    if (!room) return;
    if (state && !room.composing) {
      const selection = view.state.selection.main;
      room.imeGuard = { from: selection.from, to: selection.to };
      // A candidate picker is not a cursor-away event. Send the last
      // grounded caret before composition changes the view's focus state.
      this.publishCursor(room, view);
    }
    room.composing = state ||
      [...room.views].some((v) => v !== view && v.composing);
    if (!room.composing) {
      room.imeGuard = null;
      for (const update of room.waiting.splice(0)) {
        if (room.doc && !room.blocked) Y.applyUpdate(room.doc, update, REMOTE);
      }
      room.waitingBytes = 0;
      this.tryAttach(room);
      if (room.pendingHandshake && room.doc && room.joined && !room.blocked) {
        room.pendingHandshake = false;
        this.sendUpdate(room, Y.encodeStateAsUpdate(room.doc));
      }
      this.ensureCausalConvergence(room);
    }
    this.opts.compositionChanged?.(room.path);
  }
  private trackImeRange(update: ViewUpdate) {
    const room = this.bound.get(update.view);
    if (!room?.composing || !room.imeGuard) return;
    const previous = room.imeGuard;
    let from = update.changes.mapPos(previous.from, -1);
    let to = update.changes.mapPos(previous.to, 1);
    const local = !update.transactions.some(tx => tx.annotation(ySyncAnnotation));
    if (local) update.changes.iterChanges((_a, _b, nextFrom, nextTo) => {
      from = Math.min(from, nextFrom);
      to = Math.max(to, nextTo);
    });
    room.imeGuard = { from: Math.max(0, from), to: Math.max(from, to) };
  }
  private applyRemoteDuringIme(room: Room, bytes: Uint8Array) {
    if (!room.doc) return;
    if (!room.composing) {
      Y.applyUpdate(room.doc, bytes, REMOTE);
      return;
    }
    if (!room.imeGuard) {
      this.deferRemote(room, bytes);
      return;
    }
    // Inspect the actual Yjs delta on a private fork BEFORE exposing it to
    // the native CM6 binding. An earlier conflicting update being held must
    // not stall unrelated updates from a third participant. A causally
    // dependent update may remain pending in the fork; the composition
    // guard and later replay preserve its lineage without applying it early.
    const candidate = new Y.Doc();
    let delta: Y.YEvent<Y.Text>["delta"] | null = null;
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
      candidate.getText("content").observe(event => { delta = event.delta; });
      Y.applyUpdate(candidate, bytes, REMOTE);
      if (delta === null || independentCompositionDelta(delta, room.imeGuard)) {
        Y.applyUpdate(room.doc, bytes, REMOTE);
      } else {
        this.deferRemote(room, bytes);
      }
    } finally {
      candidate.destroy();
    }
  }
  private deferRemote(room: Room, update: Uint8Array) {
    if (room.waitingBytes + update.byteLength > MAX_COMPOSITION_BUFFER_BYTES) {
      // A suspended iOS composition can accumulate unbounded remote frames.
      // Never exhaust the WebView heap or apply a partial remote history.
      room.waiting = [];
      room.waitingBytes = 0;
      room.blocked = true;
      if (room.joined) this.opts.send({
        channel: "collab", type: "leave", path: room.path
      });
      room.joined = false;
      this.opts.notify(room.path,
        "Remote edits exceeded IME buffer; local draft preserved, restart Connector to reconcile");
      this.opts.compositionChanged?.(room.path);
      return;
    }
    room.waiting.push(update);
    room.waitingBytes += update.byteLength;
    this.opts.compositionChanged?.(room.path);
  }

  private join(room: Room) {
    if (!this.online || room.blocked || !room.views.size) return;
    this.opts.send({ channel: "collab", type: "join", path: room.path,
      name: this.opts.displayName?.() || "Native Obsidian" });
  }

  private hasCausalGap(room: Room): boolean {
    // A received Yjs update can be syntactically valid yet INCOMPLETE:
    // it references a struct from an earlier missing frame. This must not
    // be misreported as a converged / server-acknowledged editor. Yjs keeps
    // the update in the StructStore until that ancestor is available.
    return hasMissingYjsAncestors(room.doc);
  }

  private clearCausalRepair(room: Room) {
    if (room.causalRepairTimer !== null) {
      clearTimeout(room.causalRepairTimer);
      room.causalRepairTimer = null;
    }
    room.causalRepairAttempts = 0;
  }

  private ensureCausalConvergence(room: Room) {
    if (!this.hasCausalGap(room)) {
      this.clearCausalRepair(room);
      return;
    }
    if (!this.online || !room.joined || room.blocked || room.composing ||
        !room.views.size || room.causalRepairTimer !== null) return;
    if (room.causalRepairAttempts >= MAX_CAUSAL_REPAIR_ATTEMPTS) {
      room.blocked = true;
      room.joined = false;
      this.opts.send({ channel: "collab", type: "leave", path: room.path });
      this.opts.notify(room.path,
        "Server Yjs ancestry remained incomplete; native draft protected for review");
      return;
    }
    const delay = causalRepairDelay(room.causalRepairAttempts);
    room.causalRepairTimer = setTimeout(() => {
      room.causalRepairTimer = null;
      if (!this.hasCausalGap(room)) {
        this.clearCausalRepair(room);
        return;
      }
      if (!this.online || !room.joined || room.blocked || room.composing) return;
      room.causalRepairAttempts++;
      // JOIN is an idempotent full-state request for an existing member; the
      // server retains the same person/colour and replies with an INIT whose
      // Yjs operations carry their original identities. No text replacement.
      this.join(room);
      this.ensureCausalConvergence(room);
    }, delay);
  }

  private clearPeers(room: Room) {
    room.peers.clear();
    room.selfId = null;
    room.lastCursor = null;
    if (room.cursorTimer !== null) clearTimeout(room.cursorTimer);
    room.cursorTimer = null;
    this.refreshPeers(room);
  }

  private sendCursorAway(room: Room) {
    if (room.cursorTimer !== null) clearTimeout(room.cursorTimer);
    room.cursorTimer = null;
    if (room.lastCursor !== null && room.joined && this.online) {
      this.opts.send({ channel: "collab", type: "cursor-away",
        path: room.path, documentId: room.documentId || undefined });
    }
    room.lastCursor = null;
  }

  private selectionChanged(view: EditorView) {
    const room = this.bound.get(view);
    if (!room) return;
    if (room.peers.size) this.refreshPeers(room);
    if (!view.hasFocus && !room.composing) {
      if (![...room.views].some(v => v.hasFocus)) this.sendCursorAway(room);
      return;
    }
    if (!room.joined || !this.online || room.blocked) return;
    if (room.cursorTimer !== null) clearTimeout(room.cursorTimer);
    room.cursorTimer = setTimeout(() => {
      room.cursorTimer = null;
      const focused = [...room.views].find(v =>
        v.hasFocus && this.bound.get(v) === room);
      if (!focused || !room.text || !room.joined ||
          room.blocked || !this.online) return;
      this.publishCursor(room, focused);
    }, 65);
  }
  private publishCursor(room: Room, view: EditorView) {
    if (!room.text || !room.joined || !this.online || room.blocked) return;
    // A native IME candidate may not yet be included in Y.Text. Freeze
    // awareness rather than sending a cursor to unrelated text coordinates.
    if (view.state.doc.toString() !== room.text.toString()) return;
    const selection = view.state.selection;
    const encoded = encodeSelections(room.text, selection.ranges, selection.mainIndex);
    if (!encoded) {
      this.opts.notify(room.path, "Shared cursors allow up to 32 selections; none were truncated");
      return;
    }
    const signature = JSON.stringify([encoded.selections, encoded.mainIndex]);
    if (room.lastCursor === signature) return;
    room.lastCursor = signature;
    this.opts.send({ channel:"collab", type:"cursor", path:room.path,
      documentId:room.documentId || undefined, ...encoded });
  }

  private refreshPeers(room: Room) {
    for (const view of room.views) {
      if (typeof document === "undefined" || !view.dom ||
          !("nodeType" in view.dom) || view.dom.nodeType !== 1) continue;
      let overlay = this.overlays.get(view);
      if (!overlay) {
        overlay = new CursorOverlay(view, this.opts.mobile === true);
        this.overlays.set(view, overlay);
      }
      overlay.set(room.text, [...room.peers.values()]);
    }
  }

  updateDisplayName() {
    const name = this.opts.displayName?.() || "Native Obsidian";
    for (const room of this.rooms.values()) {
      if (room.joined && !room.blocked && this.online) {
        this.opts.send({
          channel: "collab", type: "identity", path: room.path,
          documentId: room.documentId || undefined, name
        });
      }
    }
  }

  participants(path: string | null): Array<Pick<Peer, "id" | "name" | "color">> {
    const room = path && this.rooms.get(path);
    return room ? [...room.peers.values()].map(({ id, name, color }) =>
      ({ id, name, color })) : [];
  }

  saveState(): {
    online: boolean;
    active: number;
    awaitingServer: number;
    reconnecting: number;
    blocked: number;
  } {
    const active = [...this.rooms.values()].filter(room => room.views.size > 0);
    return {
      online: this.online,
      active: active.length,
      awaitingServer: active.filter(room => room.sentSeq > room.savedSeq ||
        room.pendingHandshake).length,
      reconnecting: active.filter(room => !room.joined && !room.blocked).length,
      blocked: active.filter(room => room.blocked).length
    };
  }

  blockingPaths(): string[] {
    // A live Yjs editor and the REST file journal are independent
    // reconciliation planes. Both must contribute to the user's review list.
    return [...this.rooms.values()]
      .filter(room => room.blocked && room.views.size > 0)
      .map(room => room.path);
  }

  jumpToParticipant(path: string, id: string): boolean {
    const room = this.rooms.get(path);
    const peer = room?.peers.get(id);
    if (!peer || !room?.text) return false;
    const choices = resolveSelections(room.text, peer);
    const main = peer.mainIndex ?? 0;
    const head = choices[main]?.head;
    if (head === undefined) return false;
    const view = [...room.views].find(item => item.dom?.isConnected);
    if (!view) return false;
    const at = Math.max(0, Math.min(view.state.doc.length, head));
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    return true;
  }

  private receivePeople(room: Room, people: unknown, selfId: string | null) {
    room.selfId = selfId;
    room.peers = new Map(sanitizePeers(people, selfId).map(peer =>
      [peer.id, peer]));
    this.refreshPeers(room);
  }

  connected() {
    this.online = true;
    for (const room of this.rooms.values()) this.join(room);
  }

  disconnected() {
    this.online = false;
    for (const room of this.rooms.values()) {
      room.joined = false;
      this.clearCausalRepair(room);
      this.clearPeers(room);
      if (room.retryTimer !== null) {
        clearTimeout(room.retryTimer);
        room.retryTimer = null;
      }
    }
  }

  // A native Vault rename changes the locator, not the document. Preserve
  // the in-memory Y.Doc and its generation-scoped IndexedDB history.
  // Rejoin only after the server has acknowledged moving its own Yjs state.
  relocate(oldPath: string, newPath: string): boolean {
    const room = this.rooms.get(oldPath);
    if (!room) return true;
    if (this.rooms.has(newPath) && this.rooms.get(newPath) !== room) {
      room.blocked = true;
      this.opts.notify(oldPath, "Yjs rename collides with another open document");
      return false;
    }
    if (room.joined) {
      this.sendCursorAway(room);
      this.opts.send({ channel: "collab", type: "leave", path: oldPath });
    }
    room.joined = false;
    this.clearPeers(room);
    this.rooms.delete(oldPath);
    room.path = newPath;
    this.rooms.set(newPath, room);
    for (const view of room.views) this.paths.set(view, newPath);
    return true;
  }

  rejoinPath(path: string) {
    const room = this.rooms.get(path);
    if (room) this.join(room);
  }

  private sendUpdate(room: Room, update: Uint8Array) {
    if (update.byteLength > MAX_UPDATE_BYTES) {
      // A whole-document replay larger than the current wire bound cannot
      // truthfully claim synchronization. Keep local Yjs/Obsidian content and
      // stop sending dependent partial updates until the protocol is upgraded.
      room.blocked = true;
      if (room.joined) this.opts.send({
        channel: "collab", type: "leave", path: room.path
      });
      room.joined = false;
      this.opts.notify(room.path, "Yjs update exceeds server limit; retained on device");
      return;
    }
    room.sentSeq++;
    this.opts.send({
      channel: "collab", type: "update", path: room.path,
      seq: room.sentSeq, update: encode(update)
    });
  }

  private retryDurableSave(room: Room) {
    if (room.retryTimer !== null || room.blocked || !room.joined || !this.online) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(room.retryCount++, 5));
    room.retryTimer = setTimeout(() => {
      room.retryTimer = null;
      if (!this.online || !room.joined || room.blocked || !room.doc) return;
      if (room.composing) {
        room.pendingHandshake = true;
        return;
      }
      // Yjs applies repeated updates idempotently. The server must return
      // "saved" only after its canonical Markdown and journal both commit.
      this.sendUpdate(room, Y.encodeStateAsUpdate(room.doc));
    }, delay);
  }

  async handle(message: WireMessage) {
    if (this.disposed || message.channel !== "collab" || !message.path) return;
    const room = this.rooms.get(message.path);
    if (!room) return;
    if ((message.type === "cursor" || message.type === "presence") &&
        (!room.joined || room.blocked ||
        (message.documentId && room.documentId !== message.documentId))) return;
    if (message.type === "presence") {
      this.receivePeople(room, message.people, room.selfId);
      return;
    }
    if (message.type === "cursor") {
      if (!message.id || message.id === room.selfId) return;
      const peer = room.peers.get(message.id);
      if (!peer) return;
      Object.assign(peer, sanitizeCursorMessage(message));
      this.refreshPeers(room);
      return;
    }
    if (message.type === "init") {
      if (!message.documentId || !ID_PATTERN.test(message.documentId)) {
        this.opts.notify(room.path, "Invalid server Yjs identity");
        return;
      }
      if (room.documentId && room.documentId !== message.documentId) {
        room.blocked = true;
        room.joined = false;
        this.opts.send({ channel: "collab", type: "leave", path: room.path });
        this.opts.notify(room.path, "Note was replaced; old offline Yjs document preserved");
        return;
      }
      if (!room.documentId) room.documentId = message.documentId;
      if (!room.hydrated) {
        if (room.hydration) await room.hydration;
        else await this.hydrate(room, message.documentId);
        if (!room.hydrated) return;
      }
      if (!room.doc || room.blocked) return;
      try {
        const remote = decode(message.state);
        const candidate = new Y.Doc();
        Y.applyUpdate(candidate, remote);
        const serverText = candidate.getText("content").toString();
        // A known generation must keep its actual Yjs operation lineage.
        // Reconstructing a new Y.Doc from unchanged Markdown does NOT
        // recreate the same CRDT. Merging two independent nonempty histories
        // would duplicate even identical text on the native Mac editor.
        // Zero-history peers are allowed (the first empty server document
        // can still accept offline edits). Use shared client IDs rather than
        // a fragile text-equality special case.
        const localVector = Y.decodeStateVector(Y.encodeStateVector(room.doc));
        const remoteVector = Y.decodeStateVector(Y.encodeStateVector(candidate));
        const unrelated = room.wasKnown && localVector.size > 0 &&
          remoteVector.size > 0 &&
          ![...localVector.keys()].some((clientId) => remoteVector.has(clientId));
        candidate.destroy();
        if (unrelated) {
          room.blocked = true;
          room.joined = false;
          this.opts.send({ channel: "collab", type: "leave", path: room.path });
          this.opts.notify(room.path,
            "Yjs lineage mismatch; server history was recreated; native draft preserved");
          return;
        }
        // If the local editor diverged from the persisted local Yjs cache,
        // treat it as a separate unsent native draft, never overwrite it.
      // New sessions have an empty cache, so compare directly to server.
        const preJoin = room.text!.toString();
        const wasKnownAtJoin = room.wasKnown;
        const expected = wasKnownAtJoin ? preJoin : serverText;
        const views = [...room.views];
        let acceptedPrejoin: string | null = null;
        let verifiedAncestor = false;
        const divergentViews = views.filter(view =>
          view.state.doc.toString() !== expected);
        if (!wasKnownAtJoin && !room.composing &&
            typeof room.preJoinBase === "string") {
          // The stored file generation and hash are a proven common ancestor.
          // A path match or equal visible text is not sufficient ancestry.
          const baseline = this.opts.fileBaseline?.(room.path);
          if (baseline?.generationId === message.documentId &&
              /^[a-f0-9]{64}$/.test(baseline.hash)) {
            const bytes = new TextEncoder().encode(room.preJoinBase);
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const hash = Array.from(new Uint8Array(digest), byte =>
              byte.toString(16).padStart(2, "0")).join("");
            if (hash === baseline.hash) {
              // Hash verification is async. Read the actual CM6 text AFTER
              // its completion so keystrokes during the handshake remain in
              // the candidate draft rather than being silently stranded.
              verifiedAncestor = true;
              const input = views[0]?.state.doc.toString();
              if (input !== undefined && views.every(view =>
                view.state.doc.toString() === input)) {
                const result = rebasePrejoinText(room.preJoinBase, input, serverText);
                if (result.kind === "merged") acceptedPrejoin = result.text;
              }
            }
          }
        }
        if (divergentViews.length && acceptedPrejoin === null &&
            !verifiedAncestor) {
          room.blocked = true;
          this.opts.send({ channel: "collab", type: "leave", path: room.path });
          this.opts.notify(room.path, "Native draft differs from Yjs baseline; not merged automatically");
          return;
        }
        if (!wasKnownAtJoin && verifiedAncestor && acceptedPrejoin === null) {
          room.blocked = true;
          this.opts.send({ channel: "collab", type: "leave", path: room.path });
          this.opts.notify(room.path,
            "Competing edits to the same original span; native draft retained for review");
          return;
        }
        if (acceptedPrejoin !== null &&
            (this.disposed || room.blocked || room.composing || !room.views.size ||
             views.some(view => view.state.doc.toString() !==
               (views[0]?.state.doc.toString())))) {
          room.blocked = true;
          this.opts.send({ channel: "collab", type: "leave", path: room.path });
          this.opts.notify(room.path, "Native draft changed during safe rebase; retained for review");
          return;
        }
        if (wasKnownAtJoin) {
          // Ensure the CodeMirror Yjs extension is installed before a remote
          // merge. Otherwise a fast WebSocket init can change the Y.Doc
          // before our queued compartment reconfiguration reaches the view,
          // leaving the native pane detached despite matching the pre-merge
          // local baseline.
          this.tryAttach(room);
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          if ([...room.views].some((view) => this.bound.get(view) !== room)) {
            room.blocked = true;
            this.opts.send({ channel: "collab", type: "leave", path: room.path });
            this.opts.notify(room.path, "Could not safely attach native editor to cached Yjs state");
            return;
          }
        }
        this.receivePeople(room, message.people,
          typeof message.self?.id === "string" ? message.self.id : null);
        this.applyRemoteDuringIme(room, remote);
        if (room.blocked) return;
        if (!wasKnownAtJoin && acceptedPrejoin !== null) {
          // First append only local, disjoint modifications to the hydrated
          // server Yjs lineage, then move the not-yet-bound CM6 view to the
          // same result in a single selection-preserving transaction.
          if (room.text!.toString() !== serverText) {
            throw new Error("Server text changed during pre-join reconciliation");
          }
          const delta = deltaForText(serverText, acceptedPrejoin);
          if (acceptedPrejoin !== serverText) {
            room.doc!.transact(() => room.text!.applyDelta(delta), null);
          }
          for (const view of views) {
            const current = view.state.doc.toString();
            const result = rebasePrejoinText(room.preJoinBase!, current, serverText);
            if (!verifiedAncestor || result.kind === "review" ||
                result.text !== acceptedPrejoin) {
              throw new Error("Native edits changed during verified startup; draft kept for review");
            }
            const edits = textEdits(current, acceptedPrejoin);
            if (edits.length) {
              view.dispatch({ changes: edits });
            }
          }
        }
        // Completing the wire handshake does NOT mean the editing surface
        // is synchronized. A queued CM6 compartment reconfiguration can
        // lose a race with local typing and leave a joined room detached.
        // Require actual native CM6 attachment BEFORE marking joined or
        // acknowledging any local Yjs update as a shared edit.
        if (!wasKnownAtJoin) {
          this.tryAttach(room);
          await new Promise<void>(resolve => queueMicrotask(resolve));
          const attached = [...room.views].every(view =>
            view.dom.isConnected !== true ||
            (this.bound.get(view) === room &&
              view.state.doc.toString() === room.text?.toString()));
          if (!attached) {
            room.blocked = true;
            this.opts.send({ channel: "collab", type: "leave", path: room.path });
            this.opts.notify(room.path,
              "Editor was not attached to shared history; native draft retained for review");
            return;
          }
        }
        room.joined = true;
        await this.opts.rememberId(room.path, message.documentId);
        room.wasKnown = true;
        for (const view of room.views) this.selectionChanged(view);
        // Replays offline CRDT history without turning a note into a
        // stale whole-file overwrite; the server ACKs only after fsync.
        if (!room.composing) this.sendUpdate(room, Y.encodeStateAsUpdate(room.doc));
        else {
          room.pendingHandshake = true;
          this.opts.notify(room.path, "IME composition: remote merge deferred");
        }
        this.ensureCausalConvergence(room);
      } catch (e) {
        room.blocked = true;
        room.joined = false;
        this.opts.send({ channel: "collab", type: "leave", path: room.path });
        this.opts.notify(room.path, "Could not initialize Yjs: " + String(e));
      }
      return;
    }
    if (message.type === "update" && room.doc && room.joined && !room.blocked) {
      try {
        const bytes = decode(message.update);
        this.applyRemoteDuringIme(room, bytes);
        this.ensureCausalConvergence(room);
      } catch {
        this.opts.notify(room.path, "Invalid remote Yjs update");
      }
    }
    if (message.type === "saved" && Number.isSafeInteger(message.seq)) {
      room.savedSeq = Math.max(room.savedSeq, message.seq!);
      room.retryCount = 0;
      if (room.retryTimer !== null) {
        clearTimeout(room.retryTimer);
        room.retryTimer = null;
      }
      if (room.savedSeq >= room.sentSeq) {
        this.opts.notify(room.path, "Server persisted collaborative edits");
      }
    }
    if (message.type === "save-error") {
      this.opts.notify(room.path, message.error || "Server could not persist Yjs state");
      this.retryDurableSave(room);
    } else if (message.type === "error") {
      this.opts.notify(room.path, message.error || "Server rejected Yjs update");
    }
  }

  isManaged(path: string): boolean {
    const room = this.rooms.get(path);
    return !!room?.views.size;
  }

  async retireDocument(path: string): Promise<void> {
    // Explicit preserve-first migration changes the local file generation.
    // Even though the file path is unchanged, the old room's blocked flag,
    // cached Y.Doc and generation identity must not attach to that new file.
    // Never do this to an open editor or an unacknowledged local CRDT update.
    const room = this.rooms.get(path);
    if (!room) return;
    if (room.views.size || room.sentSeq > room.savedSeq ||
        room.pendingHandshake || room.waiting.length) {
      throw new Error("Close the old editor and finish pending collaboration writes");
    }
    if (room.joined) {
      this.opts.send({ channel: "collab", type: "leave", path });
      room.joined = false;
    }
    this.clearPeers(room);
    this.rooms.delete(path);
    this.clearCausalRepair(room);
    if (room.retryTimer !== null) clearTimeout(room.retryTimer);
    room.retryTimer = null;
    await room.hydration?.catch(() => {});
    await room.persistence?.destroy();
    room.undo?.destroy();
    room.doc?.destroy();
  }

  async resetForConnection(): Promise<void> {
    // A different Vault is a different document namespace. Detach all
    // CodeMirror bindings and Yjs storage before changing its connection
    // identity, but keep the registered CM6 extension alive.
    this.disconnected();
    const views = [...new Set(
      [...this.rooms.values()].flatMap((room) => [...room.views])
    )];
    for (const view of views) {
      if (view.dom.isConnected) {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      }
    }
    this.paths.clear();
    this.bound.clear();
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    for (const room of this.rooms.values()) {
      if (room.retryTimer !== null) clearTimeout(room.retryTimer);
      this.clearCausalRepair(room);
      await room.persistence?.destroy().catch(() => {});
      room.undo?.destroy();
      room.doc?.destroy();
    }
    this.rooms.clear();
    for (const view of views) {
      if (view.dom.isConnected) this.observe(view);
    }
  }

  async dispose() {
    this.disposed = true;
    this.disconnected();
    this.paths.clear();
    this.bound.clear();
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    for (const room of this.rooms.values()) {
      if (room.retryTimer !== null) clearTimeout(room.retryTimer);
      await room.persistence?.destroy().catch(() => {});
      room.undo?.destroy();
      room.doc?.destroy();
    }
    this.rooms.clear();
  }
}

export { encode as encodeYjs, decode as decodeYjs };
