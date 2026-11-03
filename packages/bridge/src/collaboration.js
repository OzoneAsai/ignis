// Browser Markdown collaboration: bind the existing Obsidian Editor to Y.Text.
// The shared Ignis WebSocket transports Yjs updates, not whole-file snapshots.
import { MarkdownView, Modal } from "obsidian";
import * as Y from "yjs";
import { createOfflineDocument } from "./collaboration-offline.js";
import { saveOfflineNote } from "../../shim/src/offline-boot.js";
import { fsShim } from "../../shim/src/fs/index.js";
import {
  localChanges,
  patchEditor,
  reconcileEditor as reconcileEditorState,
} from "./collaboration-editor.js";
import {
  createCursorOverlay,
  encodeCursorSelection,
} from "./collaboration-cursors.js";

const REMOTE = "remote";
const LOCAL = "local";
const NAME_KEY = "ignis-collab-display-name";
const TAB_KEY = "ignis-collab-tab-id";

function ownDisplayName() {
  let tabId = sessionStorage.getItem(TAB_KEY);

  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, tabId);
  }

  return sessionStorage.getItem(NAME_KEY) || `Guest ${tabId.slice(0, 4)}`;
}

class PeopleModal extends Modal {
  constructor(app, getPeople, getName, setName, getDetails, retrySync, dismissDraft) {
    super(app);
    this.getPeople = getPeople;
    this.getName = getName;
    this.setName = setName;
    this.getDetails = getDetails;
    this.retrySync = retrySync;
    this.dismissDraft = dismissDraft;
  }

  onOpen() {
    const root = this.contentEl;
    root.createEl("h3", { text: "Live collaborators" });
    const form = root.createEl("form");
    const label = form.createEl("label", { text: "Your display name" });
    const input = label.createEl("input", { type: "text" });
    input.maxLength = 40;
    input.value = this.getName();
    input.style.display = "block";
    input.style.width = "100%";
    const save = form.createEl("button", { text: "Save name", type: "submit" });
    save.style.marginTop = "8px";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.setName(input.value);
      this.close();
    });
    const details = this.getDetails();
    root.createEl("p", { text: details.status });

    if (details.storageError) {
      root.createEl("p", {
        text: "Local storage is unavailable. Keep this tab open and copy your note before closing it.",
      });
      root.createEl("small", { text: String(details.storageError.message || details.storageError) });
    }

    if (details.serverSaveError) {
      root.createEl("p", {
        text: "Your device retains the draft, but the server has not confirmed saving it.",
      });
      root.createEl("button", { text: "Retry server sync", type: "button" })
        .addEventListener("click", () => {
          this.retrySync();
          this.close();
        });
    }

    if (typeof details.pendingDraft === "string") {
      root.createEl("h4", { text: "Recovered unsent draft" });
      root.createEl("p", {
        text: "An editor changed this note before the shared version finished loading. The unsent text is preserved separately. Review and copy it; it was NOT merged over other people's edits.",
      });
      const area = root.createEl("textarea");
      area.readOnly = true;
      area.value = details.pendingDraft;
      area.style.width = "100%";
      area.style.minHeight = "140px";
      const copy = root.createEl("button", { text: "Copy recovered draft", type: "button" });
      copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(details.pendingDraft);
            copy.textContent = "Copied";
          } catch {
            area.select();
          }
        });
      const dismiss = root.createEl("button", {
        text: "Discard this recovery copy", type: "button",
      });
      dismiss.style.marginLeft = "10px";
      dismiss.addEventListener("click", () => {
        dismiss.textContent = "Confirm discard recovery copy";
        dismiss.addEventListener("click", () => {
          this.dismissDraft();
          this.close();
        }, { once: true });
      }, { once: true });
    }

    root.createEl("h4", { text: "People in this note" });
    this.peopleList = root.createDiv({ cls: "ignis-collab-people" });
    this.refreshPeople();
  }

  refreshPeople() {
    if (!this.peopleList) {
      return;
    }

    const participants = this.getPeople();
    const active = new Set(participants.map((person) => person.id));

    for (const node of Array.from(this.peopleList.children)) {
      if (!active.has(node.dataset.collabPeer)) {
        node.remove();
      }
    }

    for (const person of participants) {
      let entry = [...this.peopleList.children].find(
        (node) => node.dataset.collabPeer === person.id,
      );

      if (!entry) {
        entry = this.peopleList.createDiv({ cls: "ignis-collab-person" });
        entry.dataset.collabPeer = person.id;
        entry.createSpan({ cls: "ignis-collab-person-color" });
        entry.createSpan({ cls: "ignis-collab-person-name" });
        entry.createEl("small", { text: `· ${person.id.slice(0, 6)}` });
      }

      const color = entry.querySelector(".ignis-collab-person-color");
      color.style.setProperty("--ignis-peer-color", person.color);
      entry.querySelector(".ignis-collab-person-name").textContent =
        person.name + (person.isSelf ? " (you)" : "");
      this.peopleList.appendChild(entry);
    }
  }
}

function encodeUpdate(bytes) {
  let result = "";

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  return btoa(result);
}

function decodeUpdate(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function applyLocalChange(ytext, value) {
  const before = ytext.toString();

  if (before === value) {
    return;
  }

  ytext.doc.transact(() => {
    ytext.applyDelta(localChanges(before, value));
  }, LOCAL);
}

function reconcileEditor(session) {
  session.suppress = true;

  try {
    return reconcileEditorState(session.editor, session.text.toString());
  } finally {
    session.suppress = false;
  }
}

export function initCollaboration(plugin) {
  const ws = window.__ignis.ws;
  const channel = ws.channel("collab");
  const status = plugin.addStatusBarItem();
  status.addClass("ignis-collaboration-status");

  let session = null;
  let activeTimer = null;
  let peopleModal = null;

  window.__ignis.collaboration = {
    isActivePath: (path) => Boolean(session && session.path === path),
  };

  function people() {
    if (!session) {
      return [];
    }

    return [...session.people.values()].map((person) => ({
      ...person,
      isSelf: person.id === session.self?.id,
    }));
  }

  function showPeople() {
    peopleModal?.close();
    peopleModal = new PeopleModal(plugin.app, people, ownDisplayName, (value) => {
      // eslint-disable-next-line no-control-regex
      const clean = value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim().slice(0, 40);

      if (!clean) {
        return;
      }

      sessionStorage.setItem(NAME_KEY, clean);

      if (session?.self) {
        session.self.name = clean;
        session.people.set(session.self.id, { ...session.self });

        if (session.joined && ws.isOpen()) {
          channel.send("identity", { path: session.path, name: clean });
        }

        render();
        renderPeers(session);
        peopleModal?.refreshPeople();
      }
    }, () => ({
      status: status.textContent,
      storageError: session?.storageError,
      serverSaveError: session?.serverSaveError,
      pendingDraft: session?.pendingConflict,
    }), () => {
      if (session?.joined && ws.isOpen()) {
        sendUpdate(session, Y.encodeStateAsUpdate(session.doc));
      }
    }, () => {
      if (session?.pendingConflict) {
        session.pendingConflict = null;
        session.local.persistence.set("unsent-startup-draft", null)
          .catch((error) => console.warn("[collab] Could not clear recovery copy:", error));
        render();
      }
    });
    peopleModal.open();
  }

  status.setAttribute("role", "button");
  status.setAttribute("tabindex", "0");
  status.setAttribute("aria-label", "Live collaborators: view people or edit your name");
  status.addEventListener("click", showPeople);
  status.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showPeople();
    }
  });

  function renderPeers(current) {
    const members = [...current.people.values()];
    const counts = new Map();

    for (const member of members) {
      counts.set(member.name, (counts.get(member.name) || 0) + 1);
    }

    current.overlay?.render(members
      .filter((member) => member.id !== current.self?.id)
      .map((member) => ({
        ...member,
        label: (counts.get(member.name) || 0) > 1
          ? `${member.name} ·${member.id.slice(0, 4)}`
          : member.name,
      })));
  }

  function render() {
    if (!session) {
      if (status.textContent) {
        status.setText("");
      }
      return;
    }

    let label;

    if (session.storageError) {
      label = "Collab: local storage failed · keep this tab open";
    } else if (!session.hydrated) {
      label = "Collab: loading local draft…";
    } else if (!session.initialized) {
      label = ws.isOpen() ? "Collab: loading note…" : "Collab: offline · note unavailable";
    } else if (session.pendingConflict) {
      label = "Collab: review unsent startup changes";
    } else if (session.serverSaveError) {
      label = "Collab: server save failed · local draft retained";
    } else if (session.protocolError) {
      label = "Collab: synchronization error · check this note";
    } else if (session.localSaving || session.previewSaving) {
      label = ws.isOpen() ? "Collab: saving to device…" : "Collab: offline · saving locally…";
    } else if (!ws.isOpen()) {
      label = "Collab: offline · saved on device";
    } else if (!session.joined) {
      label = "Collab: reconnecting · local copy ready";
    } else if (session.dirty || session.confirmedSeq < session.sentSeq) {
      label = `Collab: syncing · ${session.participants} online`;
    } else {
      label = `Collab: ${session.participants} online · saved`;
    }

    if (status.textContent !== label) {
      status.setText(label);
    }
  }

  function sendJoin() {
    if (session?.hydrated && ws.isOpen() && !session.joined) {
      channel.send("join", { path: session.path, name: ownDisplayName() });
    }
  }

  function sendUpdate(current, bytes) {
    if (!current.joined || !ws.isOpen()) {
      return;
    }

    current.sentSeq++;
    current.dirty = true;
    current.serverSaveError = false;
    channel.send("update", {
      path: current.path,
      seq: current.sentSeq,
      update: encodeUpdate(bytes),
    });
    render();
  }

  function guardEditor(current) {
    const contentDOM = current.editor.cm?.contentDOM;

    if (!contentDOM) {
      return;
    }

    const previous = contentDOM.getAttribute("contenteditable");
    contentDOM.setAttribute("contenteditable", "false");
    contentDOM.setAttribute("aria-busy", "true");
    current.unlockEditor = () => {
      if (previous === null) {
        contentDOM.removeAttribute("contenteditable");
      } else {
        contentDOM.setAttribute("contenteditable", previous);
      }

      contentDOM.removeAttribute("aria-busy");
      current.unlockEditor = null;
    };
  }

  function writeOfflinePreview(current) {
    clearTimeout(current.previewTimer);
    current.previewTimer = null;
    const content = current.text.toString();
    const revision = current.previewRevision;
    current.previewPromise = current.previewPromise.then(() =>
      saveOfflineNote(window.__currentVaultId, current.path, content)
    ).then((saved) => {
      if (!saved) {
        throw new Error("This note exceeds the offline startup cache limit");
      }

      if (revision === current.previewRevision && session === current) {
        current.previewSaving = false;
        render();
      }
    }).catch((error) => {
      current.storageError = error;
      console.error("[collab] Offline note cache failed:", error);
      render();
    });
  }

  function scheduleOfflinePreview(current) {
    if (!current.hydrated || !current.initialized) {
      return;
    }

    current.previewRevision++;
    current.previewSaving = true;
    clearTimeout(current.previewTimer);
    current.previewTimer = setTimeout(() => writeOfflinePreview(current), 90);
    render();
  }

  function sendSelection(current) {
    if (!current || !current.initialized || !current.joined || !ws.isOpen() || current.suppress) {
      return;
    }

    const selected = current.editor.cm?.state?.selection?.main;

    if (!selected) {
      return;
    }

    const encoded = encodeCursorSelection(current.text, selected.anchor, selected.head);
    const signature = encoded.anchor + ":" + encoded.head;

    if (current.lastSelection === signature) {
      return;
    }

    current.lastSelection = signature;
    channel.send("cursor", { path: current.path, ...encoded });
  }

  function scheduleSelection(current) {
    if (!current || current !== session) {
      return;
    }

    clearTimeout(current.selectionTimer);
    current.selectionTimer = setTimeout(() => sendSelection(current), 65);
  }

  function finishComposition(current) {
    clearTimeout(current.compositionTimer);

    if (!current.composing || !current.initialized) {
      return;
    }

    // Keep the original Y.Doc fixed during native IME composition. A remote
    // update received mid-composition must not rewrite the composing DOM.
    // Apply the author's completed change first, then merge buffered remote
    // CRDT operations. This preserves both inputs and CodeMirror's IME state.
    applyLocalChange(current.text, current.editor.getValue());
    current.composing = false;

    for (const update of current.pendingRemote.splice(0)) {
      Y.applyUpdate(current.doc, update, REMOTE);
    }

    scheduleSelection(current);
  }

  function dispose() {
    if (!session) {
      return;
    }

    const current = session;
    session = null;

    if (current.joined && ws.isOpen()) {
      channel.send("leave", { path: current.path });
    }

    clearTimeout(current.selectionTimer);
    finishComposition(current);
    if (current.previewTimer) {
      writeOfflinePreview(current);
    }
    current.restoreUndo?.();
    current.undoManager?.destroy();
    current.removeEditorListeners?.();
    current.overlay?.destroy();
    current.unlockEditor?.();
    current.local?.close().catch((error) => {
      console.warn("[collab] Could not close offline document:", error);
    });
    render();
  }

  function syncActive() {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const editor = view?.editor;

    if (!file || !editor || !file.path.toLowerCase().endsWith(".md")) {
      dispose();
      return;
    }

    if (session?.path === file.path && session.editor === editor) {
      return;
    }

    dispose();

    const next = {
      path: file.path,
      editor,
      initial: editor.getValue(),
      initialized: false,
      hydrated: false,
      joined: false,
      dirty: false,
      sentSeq: 0,
      confirmedSeq: 0,
      localSaving: false,
      storageError: null,
      serverSaveError: false,
      protocolError: null,
      previewSaving: false,
      previewRevision: 0,
      previewTimer: null,
      previewPromise: Promise.resolve(),
      suppress: false,
      participants: 1,
      people: new Map(),
      self: null,
      lastSelection: null,
      selectionTimer: null,
      composing: false,
      compositionTimer: null,
      pendingRemote: [],
    };

    const local = createOfflineDocument(window.__currentVaultId, file.path, (storage) => {
      if (session === next) {
        next.localSaving = storage.isSaving;
        next.storageError = storage.error;
        render();
      }
    });
    const { doc, text } = local;
    next.doc = doc;
    next.text = text;
    next.local = local;
    next.undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 500,
    });

    // CodeMirror's stock history cannot distinguish a remote transaction from
    // the local author's changes. Use Yjs UndoManager for collaborative notes:
    // remote edits remain untouched, and Undo itself is synced as a CRDT edit.
    const originalUndo = editor.undo;
    const originalRedo = editor.redo;
    const undo = () => next.undoManager.undo();
    const redo = () => next.undoManager.redo();
    editor.undo = function () {
      return next.initialized && session === next
        ? undo()
        : originalUndo.call(editor);
    };
    editor.redo = function () {
      return next.initialized && session === next
        ? redo()
        : originalRedo.call(editor);
    };

    const onUndoShortcut = (event) => {
      if (!next.initialized || session !== next || event.isComposing ||
          !editor.cm?.dom?.contains(event.target) ||
          !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) ||
        (key === "y" && event.ctrlKey && !event.metaKey);

      if (wantsUndo || wantsRedo) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (wantsUndo ? undo : redo)();
      }
    };

    document.addEventListener("keydown", onUndoShortcut, true);
    next.restoreUndo = () => {
      document.removeEventListener("keydown", onUndoShortcut, true);
      editor.undo = originalUndo;
      editor.redo = originalRedo;
    };

    guardEditor(next);

    next.overlay = createCursorOverlay(next);

    const onCursorMotion = () => scheduleSelection(next);
    const cmDom = editor.cm?.dom;
    const events = ["keyup", "mouseup", "pointerup", "focusin"];

    for (const event of events) {
      cmDom?.addEventListener(event, onCursorMotion);
    }

    const onCompositionStart = () => {
      if (next.initialized) {
        next.composing = true;
      }
    };
    const onCompositionEnd = () => {
      if (next.composing) {
        clearTimeout(next.compositionTimer);
        // Native compositionend can precede its final editor-change event.
        next.compositionTimer = setTimeout(() => finishComposition(next), 0);
      }
    };
    cmDom?.addEventListener("compositionstart", onCompositionStart);
    cmDom?.addEventListener("compositionend", onCompositionEnd);

    const onSelectionChange = () => {
      if (editor.cm?.hasFocus) {
        onCursorMotion();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    next.removeEditorListeners = () => {
      for (const event of events) {
        cmDom?.removeEventListener(event, onCursorMotion);
      }

      document.removeEventListener("selectionchange", onSelectionChange);
      cmDom?.removeEventListener("compositionstart", onCompositionStart);
      cmDom?.removeEventListener("compositionend", onCompositionEnd);
    };

    doc.on("update", (update, origin) => {
      if ((origin === LOCAL || origin === next.undoManager) && session === next) {
        next.dirty = true;
        sendUpdate(next, update);
        render();
      }
    });

    text.observe((event, transaction) => {
      if (session === next) {
        fsShim._contentCache.set(next.path, next.text.toString());
      }

      if (session === next && next.initialized) {
        if (transaction.origin !== LOCAL) {
          next.suppress = true;

          try {
            if (!patchEditor(next.editor, next.text, event.delta)) {
              // One fallback CM6 transaction, not a DOM replacement.
              reconcileEditor(next);
            }
          } finally {
            next.suppress = false;
          }
        }

        renderPeers(next);
        scheduleOfflinePreview(next);
      }
    });

    session = next;
    render();

    local.ready.then((hasLocalCopy) => {
      if (session !== next) {
        return;
      }

      next.hydrated = true;

      if (hasLocalCopy) {
        next.initialized = true;
        reconcileEditor(next);
        fsShim._contentCache.set(next.path, next.text.toString());
        next.unlockEditor?.();
        scheduleOfflinePreview(next);
      }

      render();
      sendJoin();
      next.local.persistence.get("unsent-startup-draft").then((draft) => {
        if (session === next && typeof draft === "string") {
          next.pendingConflict = draft;
          render();
        }
      }).catch((error) => console.warn("[collab] Could not read startup recovery copy:", error));
    }).catch((error) => {
      console.error("[collab] Local draft initialization failed:", error);

      if (session === next) {
        next.storageError = error;
        render();
      }
    });
  }

  function scheduleActive() {
    clearTimeout(activeTimer);
    activeTimer = setTimeout(syncActive, 0);
  }

  const unsubscribe = [
    channel.subscribe("init", (msg) => {
      if (!session || msg.path !== session.path || !session.hydrated) {
        return;
      }

      const current = session;
      const preJoinText = current.editor.getValue();
      const changedWhileJoining = !current.initialized && preJoinText !== current.initial;

      try {
        Y.applyUpdate(current.doc, decodeUpdate(msg.state), REMOTE);
        current.initialized = true;
        current.joined = true;
        current.participants = msg.participants || 1;
        current.self = msg.self || null;
        current.people = new Map((msg.people || []).map((person) => [person.id, person]));
        current.lastSelection = null;

        if (changedWhileJoining) {
          if (current.text.toString() === current.initial) {
            // Inputs that occurred before hydration had the same baseline.
            applyLocalChange(current.text, preJoinText);
          } else {
            // A plugin changed the uninitialized editor against a divergent
            // server state. Preserve the exact draft; never overwrite peers.
            current.pendingConflict = preJoinText;
            current.local.persistence.set("unsent-startup-draft", preJoinText).catch(
              (error) => console.warn("[collab] Unable to store competing draft:", error),
            );
          }
        }

        reconcileEditor(current);
        fsShim._contentCache.set(current.path, current.text.toString());
        current.unlockEditor?.();
        current.local.markInitialized().catch((error) => {
          current.storageError = error;
          render();
        });
        scheduleOfflinePreview(current);
        // Full state exchange includes local edits retained while disconnected.
        sendUpdate(current, Y.encodeStateAsUpdate(current.doc));
        render();
        renderPeers(current);
        scheduleSelection(current);
      } catch (error) {
        console.error("[collab] Failed to initialize note:", error);
        status.setText("Collab: initialization failed");
      }
    }),
    channel.subscribe("update", (msg) => {
      if (!session || msg.path !== session.path || !session.initialized) {
        return;
      }

      try {
        const bytes = decodeUpdate(msg.update);

        if (session.composing) {
          session.pendingRemote.push(bytes);
        } else {
          Y.applyUpdate(session.doc, bytes, REMOTE);
        }
      } catch (error) {
        console.error("[collab] Invalid remote update:", error);
      }
    }),
    channel.subscribe("presence", (msg) => {
      if (session?.path === msg.path) {
        session.participants = msg.participants;
        if (Array.isArray(msg.people)) {
          session.people = new Map(msg.people.map((person) => [person.id, person]));
          session.self = session.people.get(session.self?.id) || session.self;
        }

        render();
        renderPeers(session);
        if (peopleModal?.isOpen) {
          peopleModal.refreshPeople();
        }
      }
    }),
    channel.subscribe("cursor", (msg) => {
      if (!session || msg.path !== session.path || msg.id === session.self?.id) {
        return;
      }

      const person = session.people.get(msg.id);

      if (person) {
        person.anchor = msg.anchor;
        person.head = msg.head;
        renderPeers(session);
      }
    }),
    channel.subscribe("error", (msg) => {
      if (session?.path === msg.path) {
        console.error("[collab]", msg.error);
        session.protocolError = msg.error;
        render();
      }
    }),
    channel.subscribe("saved", (msg) => {
      if (!session || msg.path !== session.path || !Number.isSafeInteger(msg.seq)) {
        return;
      }

      session.confirmedSeq = Math.max(session.confirmedSeq, msg.seq);
      session.serverSaveError = false;
      session.protocolError = null;

      if (session.confirmedSeq >= session.sentSeq && session.joined) {
        session.dirty = false;
      }

      render();
    }),
    channel.subscribe("save-error", (msg) => {
      if (session?.path === msg.path) {
        session.serverSaveError = true;
        session.dirty = true;
        render();
      }
    }),
    ws.onStateChange((state) => {
      if (session) {
        session.joined = false;

        if (state === "open") {
          sendJoin();
        } else {
          session.people.clear();
          session.participants = 1;
        }

        render();
      }
    }),
  ];

  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", scheduleActive));
  plugin.registerEvent(plugin.app.workspace.on("file-open", scheduleActive));
  plugin.registerEvent(plugin.app.workspace.on("editor-change", (editor) => {
    if (session?.editor === editor && session.initialized && !session.suppress &&
        !session.composing) {
      applyLocalChange(session.text, editor.getValue());
      scheduleSelection(session);
    }
  }));

  plugin.app.workspace.onLayoutReady(scheduleActive);
  scheduleActive();

  return () => {
    clearTimeout(activeTimer);
    peopleModal?.close();
    dispose();

    for (const off of unsubscribe) {
      off();
    }

    status.remove();
    delete window.__ignis.collaboration;
  };
}

export { applyLocalChange };
