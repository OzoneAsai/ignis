import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

// Native Obsidian, mobile included, uses the same Yjs wire protocol as Ignis
// Bridge. We only install the CM6 binding after checking native file content,
// so a stale local file cannot overwrite a recently updated remote document.
const REMOTE = Symbol("ignis-remote");
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
};
type Room = {
  path: string;
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
  pendingHandshake: boolean;
  waiting: Uint8Array[];
  waitingBytes: number;
  sentSeq: number;
  savedSeq: number;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  snapshot: string | null;
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
    path, documentId, wasKnown: !!documentId, doc: null, text: null, undo: null,
    persistence: null, hydrated: false, hydration: null, views: new Set(),
    initializing: false, joined: false, blocked: false,
    composing: false, pendingHandshake: false, waiting: [], waitingBytes: 0,
    sentSeq: 0, savedSeq: 0,
    retryCount: 0, retryTimer: null,
    snapshot: null
  };
}

export class NativeYjs {
  private readonly rooms = new Map<string, Room>();
  private readonly paths = new Map<EditorView, string>();
  private readonly bound = new Map<EditorView, Room>();
  private readonly compartment = new Compartment();
  private online = false;
  private disposed = false;

  constructor(private readonly opts: {
    vaultId: () => string;
    origin: () => string;
    pathForView: (view: EditorView) => string | null;
    knownId: (path: string) => string | null;
    rememberId: (path: string, id: string) => Promise<void>;
    send: (message: WireMessage) => void;
    notify: (path: string, status: string) => void;
  }) {}

  extension() {
    const manager = this;
    return [
      this.compartment.of([]),
      ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {
          manager.observe(view);
        }
        update(update: { view: EditorView }) {
          manager.observe(update.view);
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
      // Reconfiguration is deferred to avoid dispatching during CM6 update.
      queueMicrotask(() => {
        if (view.dom.isConnected && !this.disposed) {
          view.dispatch({ effects: this.compartment.reconfigure([]) });
        }
      });
      if (old && old.views.size === 0 && old.joined) {
        this.opts.send({ channel: "collab", type: "leave", path: old.path });
        old.joined = false;
      }
    }
    if (!path) return;
    this.paths.set(view, path);
    let room = this.rooms.get(path);
    if (!room) {
      const id = this.opts.knownId(path);
      room = newRoom(path, id);
      this.rooms.set(path, room);
      if (id) void this.hydrate(room, id);
    }
    room.views.add(view);
    this.tryAttach(room);
    if (this.online) this.join(room);
  }

  private forget(view: EditorView) {
    const path = this.paths.get(view);
    if (!path) return;
    this.paths.delete(view);
    this.bound.delete(view);
    const room = this.rooms.get(path);
    if (!room) return;
    room.views.delete(view);
    if (room.views.size === 0 && room.joined) {
      this.opts.send({ channel: "collab", type: "leave", path });
      room.joined = false;
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
        Prec.highest(keymap.of(yUndoManagerKeymap))
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
      });
    }
  }

  private setComposing(view: EditorView, state: boolean) {
    const path = this.paths.get(view);
    const room = path && this.rooms.get(path);
    if (!room) return;
    room.composing = state ||
      [...room.views].some((v) => v !== view && v.composing);
    if (!room.composing) {
      for (const update of room.waiting.splice(0)) {
        if (room.doc && !room.blocked) Y.applyUpdate(room.doc, update, REMOTE);
      }
      room.waitingBytes = 0;
      this.tryAttach(room);
      if (room.pendingHandshake && room.doc && room.joined && !room.blocked) {
        room.pendingHandshake = false;
        this.sendUpdate(room, Y.encodeStateAsUpdate(room.doc));
      }
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
        "Remote edits exceeded IME buffer; local draft preserved, reopen note to reconcile");
      return;
    }
    room.waiting.push(update);
    room.waitingBytes += update.byteLength;
  }

  private join(room: Room) {
    if (!this.online || room.blocked || !room.views.size) return;
    this.opts.send({ channel: "collab", type: "join", path: room.path });
  }

  connected() {
    this.online = true;
    for (const room of this.rooms.values()) this.join(room);
  }

  disconnected() {
    this.online = false;
    for (const room of this.rooms.values()) {
      room.joined = false;
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
      this.opts.send({ channel: "collab", type: "leave", path: oldPath });
    }
    room.joined = false;
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
        candidate.destroy();
        // If the local editor diverged from the persisted local Yjs cache,
        // treat it as a separate unsent native draft, never overwrite it.
        // New sessions have an empty cache, so compare directly to server.
        const preJoin = room.text!.toString();
        const expected = room.wasKnown ? preJoin : serverText;
        if ([...room.views].some((view) =>
          view.state.doc.toString() !== expected)) {
          room.blocked = true;
          this.opts.send({ channel: "collab", type: "leave", path: room.path });
          this.opts.notify(room.path, "Native draft differs from Yjs baseline; not merged automatically");
          return;
        }
        if (room.wasKnown) {
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
        room.joined = true;
        if (room.composing) this.deferRemote(room, remote);
        else Y.applyUpdate(room.doc, remote, REMOTE);
        if (room.blocked) return;
        await this.opts.rememberId(room.path, message.documentId);
        room.wasKnown = true;
        this.tryAttach(room);
        // Replays offline CRDT history without turning a note into a
        // stale whole-file overwrite; the server ACKs only after fsync.
        if (!room.composing) this.sendUpdate(room, Y.encodeStateAsUpdate(room.doc));
        else {
          room.pendingHandshake = true;
          this.opts.notify(room.path, "IME composition: remote merge deferred");
        }
      } catch (e) {
        this.opts.notify(room.path, "Could not initialize Yjs: " + String(e));
      }
      return;
    }
    if (message.type === "update" && room.doc && room.joined && !room.blocked) {
      try {
        const bytes = decode(message.update);
        if (room.composing) this.deferRemote(room, bytes);
        else Y.applyUpdate(room.doc, bytes, REMOTE);
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

  async dispose() {
    this.disposed = true;
    this.disconnected();
    this.paths.clear();
    this.bound.clear();
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
