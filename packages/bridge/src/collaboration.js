// Browser Markdown collaboration: bind the existing Obsidian Editor to Y.Text.
// The shared Ignis WebSocket transports Yjs updates, not whole-file snapshots.
import { MarkdownView, Modal, setIcon } from "obsidian";
import * as Y from "yjs";
import { createOfflineDocument, CROSS_TAB_ORIGIN } from "./collaboration-offline.js";
import { classifyDocumentAncestry } from "./collaboration-ancestry.js";
import { hasMissingYjsAncestors, causalRepairDelay,
  MAX_CAUSAL_REPAIR_ATTEMPTS } from "./causal-history.js";
import { saveOfflineNote } from "../../shim/src/offline-boot.js";
import { collaborationStatus, collaborationStatusSummary } from "./collaboration-status.js";
import { bindCollaborativeHistory } from "./collaboration-undo.js";
import { fsShim } from "../../shim/src/fs/index.js";
import {
  localChanges,
  patchEditor,
  reconcileEditor as reconcileEditorState,
} from "./collaboration-editor.js";
import {
  beginComposition, publishComposition, commitComposition,
  widenCompositionGuard, projectIndependentCompositionUpdate
} from "./composition-rebase.js";
import {
  preferredDisplayName, saveDisplayName
} from "./collaboration-identity.js";
import { mobileConnectionState } from "./mobile-connection-state.js";
import { showFilePicker, showFileRename } from "./file-actions.js";
import { mountMobileNavbarAction } from "../../server-core/src/mobile-navbar.ts";
import { mobileUiCopy, mobileUiLanguage } from "../../server-core/src/mobile-ui-copy.ts";
import {
  createCursorOverlay,
  encodeCursorSelections,
} from "./collaboration-cursors.js";

const REMOTE = "remote";
const LOCAL = "local";
const TAB_KEY = "ignis-collab-tab-id";

class MobileIgnisActionsModal extends Modal {
  constructor(app, getStatus, onUpload, onRename, onPeople) {
    super(app);
    this.getStatus = getStatus;
    this.onUpload = onUpload;
    this.onRename = onRename;
    this.onPeople = onPeople;
  }

  onOpen() {
    const t = mobileUiCopy();
    const root = this.contentEl;
    root.addClass("ignis-mobile-action-menu");
    root.createEl("h3", { text: "Ignis" });
    this.connectionLabel = root.createEl("p", { cls: "ignis-mobile-action-state" });
    this.noteLabel = root.createEl("p", { cls: "ignis-mobile-action-detail" });
    this.refreshStatus();
    const addAction = (text, callback) => {
      const button = root.createEl("button", { text });
      button.type = "button";
      button.addEventListener("click", () => {
        this.close();
        callback();
      });
    };
    addAction(t.upload, this.onUpload);
    addAction(t.rename, this.onRename);
    addAction(t.people, this.onPeople);
  }

  refreshStatus() {
    if (!this.connectionLabel) return;
    const { connection, detail } = this.getStatus();
    this.connectionLabel.setText(`${mobileUiCopy().status}: ${connection}`);
    this.noteLabel.setText(detail);
  }

  onClose() {
    this.connectionLabel = null;
    this.noteLabel = null;
  }
}

function availableStorage(key) {
  try {
    return window[key];
  } catch {
    return null;
  }
}

function ownDisplayName() {
  const tabStorage = availableStorage("sessionStorage");
  let tabId;
  try {
    tabId = tabStorage?.getItem(TAB_KEY);
  } catch {
    // Private PWA contexts may deny storage access.
  }

  if (!tabId) {
    tabId = crypto.randomUUID();
    try {
      tabStorage?.setItem(TAB_KEY, tabId);
    } catch {
      // The session still has an ephemeral guest label.
    }
  }

  return preferredDisplayName(availableStorage("localStorage"), tabStorage) ||
    `Guest ${tabId.slice(0, 4)}`;
}

class PeopleModal extends Modal {
  constructor(app, getPeople, getName, setName, getDetails, retrySync, dismissDraft, activateServerCopy) {
    super(app);
    this.getPeople = getPeople;
    this.getName = getName;
    this.setName = setName;
    this.getDetails = getDetails;
    this.retrySync = retrySync;
    this.dismissDraft = dismissDraft;
    this.activateServerCopy = activateServerCopy;
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
    if (details.path) {
      root.createEl("p", { text: `Current note: ${details.path}` });
    }
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

    if (details.generationMismatch) {
      const independent = details.joinConflictReason === "independent";
      root.createEl("h4", { text: independent
        ? "Two independently created notes have the same name"
        : "This note was replaced on the server" });
      root.createEl("p", {
        text: independent
          ? "The browser's offline note and the server note have no verified common history. The local draft has NOT been merged or discarded. You can keep it as a recovery copy and open the server version separately."
          : "The same filename now refers to a different note. Your previous offline draft has NOT been merged into it. Keep a recovery copy and open the new server version separately.",
      });
    }

    if (typeof details.pendingDraft === "string") {
      root.createEl("h4", {
        text: details.generationMismatch || details.recoveredGenerationDraft
          ? "Protected copy of previous note" : "Recovered unsent draft",
      });
      root.createEl("p", {
        text: details.generationMismatch || details.recoveredGenerationDraft
          ? "This is your earlier note's text, stored separately so it cannot overwrite the new server note. You may copy it for comparison or recovery."
          : "An editor changed this note before the shared version finished loading. The unsent text is preserved separately. Review and copy it; it was NOT merged over other people's edits.",
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

    if (details.generationMismatch) {
      const openNew = root.createEl("button", {
        text: "Open new server note (preserve old draft)", type: "button",
      });
      openNew.addEventListener("click", async () => {
        openNew.disabled = true;

        try {
          await this.activateServerCopy();
          this.close();
        } catch (error) {
          openNew.disabled = false;
          root.createEl("p", {
            text: `Could not safely switch note copies: ${String(error.message || error)}`,
          });
        }
      });
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

export function initCollaboration(plugin) {
  const ws = window.__ignis.ws;
  const channel = ws.channel("collab");
  const status = plugin.addStatusBarItem();
  status.addClass("ignis-collaboration-status");
  const writes = window.__ignis.writes;
  let transportState = ws.isOpen() ? "open" : "connecting";

  let session = null;
  const sessions = new Map();
  const editorOwners = new WeakMap();
  let activeTimer = null;
  let peopleModal = null;

  window.__ignis.collaboration = {
    isActivePath: (path) => sessions.has(path),
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
      const clean = saveDisplayName(value,
        availableStorage("localStorage"), availableStorage("sessionStorage"));

      if (!clean) {
        return;
      }

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
      path: session?.path,
      status: collaborationStatus(session, ws.isOpen()),
      storageError: session?.storageError,
      serverSaveError: session?.serverSaveError,
      pendingDraft: session?.pendingConflict,
      generationMismatch: session?.generationMismatch,
      joinConflictReason: session?.joinConflictReason,
      recoveredGenerationDraft: session?.recoveredGenerationDraft,
    }), () => {
      if (session?.joined && ws.isOpen()) {
        sendUpdate(session, Y.encodeStateAsUpdate(session.doc));
      }
    }, () => {
      if (session?.pendingConflict) {
        session.pendingConflict = null;
        session.local.persistence.set("unsent-startup-draft", null)
          .catch((error) => console.warn("[collab] Could not clear recovery copy:", error));
        session.local.clearReplacedDraft().catch(
          (error) => console.warn("[collab] Could not clear replaced-note recovery:", error),
        );
        render();
      }
    }, async () => {
      const current = session;

      if (!current?.generationMismatch) {
        return;
      }

      await current.local.activateGeneration(current.generationMismatch, current.text.toString());

      if (sessions.get(current.path) === current) {
        dispose(current);
        scheduleActive();
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

  // One icon in Obsidian's own bottom navbar. A separate fixed dock would
  // cover notes and collide with iOS Safari's navigation controls.
  const navbarAction = document.createElement("div");
  navbarAction.className = "mobile-navbar-action ignis-navbar-action";
  const navbarButton = document.createElement("button");
  navbarButton.type = "button";
  navbarButton.className = "ignis-navbar-trigger";
  navbarButton.setAttribute("aria-haspopup", "dialog");
  navbarButton.setAttribute("aria-label", "Ignis: " + mobileUiCopy().openActions);
  setIcon(navbarButton, "flame");
  const connectionDot = document.createElement("span");
  connectionDot.className = "ignis-navbar-connection-dot";
  connectionDot.setAttribute("aria-hidden", "true");
  navbarButton.appendChild(connectionDot);
  navbarAction.appendChild(navbarButton);
  let mobileMenu = null;
  const openMobileMenu = () => {
    mobileMenu?.close();
    mobileMenu = new MobileIgnisActionsModal(plugin.app, () => {
      const projection = mobileConnectionState(
        session, transportState, writes?.getState?.() || "clean",
        writes?.listFailed?.().length || 0, mobileUiLanguage(),
      );
      return {
        connection: projection.label,
        detail: collaborationStatus(session, ws.isOpen()) || mobileUiCopy().noNote,
      };
    }, () => showFilePicker(plugin.app), () => showFileRename(plugin.app), showPeople);
    mobileMenu.open();
  };
  navbarButton.addEventListener("click", openMobileMenu);
  const unmountNavbarAction = mountMobileNavbarAction(navbarAction);

  plugin.addCommand({
    id: "show-collaboration-people-and-name",
    name: "共同編集: 参加者と表示名を変更",
    callback: showPeople,
  });
  plugin.addCommand({
    id: "open-mobile-ignis-actions",
    name: "Ignis: 接続状態・ファイル追加・ファイル名変更・参加者",
    callback: openMobileMenu,
  });

  function renderPeers(current) {
    const members = [...current.people.values()];
    const counts = new Map();

    for (const member of members) {
      counts.set(member.name, (counts.get(member.name) || 0) + 1);
    }

    const peers = members
      .filter((member) => member.id !== current.self?.id)
      .map((member) => ({
        ...member,
        label: (counts.get(member.name) || 0) > 1
          ? `${member.name} ·${member.id.slice(0, 4)}`
          : member.name,
      }));

    for (const binding of current.bindings.values()) {
      binding.overlay.render(peers);
    }
  }

  function render() {
    const details = collaborationStatus(session, ws.isOpen());
    const label = collaborationStatusSummary(session, ws.isOpen());

    if (status.textContent !== label) {
      status.setText(label);
    }
    status.toggleClass("ignis-composition-active", Boolean(session?.composing));
    status.setAttribute("aria-label", details ||
      "Live collaborators: view people or edit your name");
    status.setAttribute("title", details || "Open live collaborators");
    const connection = mobileConnectionState(
      session, transportState, writes?.getState?.() || "clean",
      writes?.listFailed?.().length || 0, mobileUiLanguage(),
    );
    navbarAction.dataset.connection = connection.kind;
    navbarButton.setAttribute("aria-label",
      `Ignis: ${connection.label} · ${mobileUiCopy().openActions}`);
    navbarButton.setAttribute("title", `Ignis: ${connection.label}`);
    mobileMenu?.refreshStatus();
  }

  function sendJoin(current) {
    if (current?.hydrated && !current.generationMismatch && ws.isOpen() && !current.joined) {
      channel.send("join", { path: current.path, name: ownDisplayName() });
    }
  }

  function clearCausalRepair(current) {
    clearTimeout(current.causalRepairTimer);
    current.causalRepairTimer = null;
    current.causalRepairAttempts = 0;
    current.causalGap = false;
  }

  function ensureCausalConvergence(current) {
    if (sessions.get(current.path) !== current) return;
    if (!hasMissingYjsAncestors(current.doc)) {
      clearCausalRepair(current);
      render();
      return;
    }
    current.causalGap = true;
    render();
    if (!ws.isOpen() || !current.joined || current.composing ||
        current.generationMismatch || current.protocolError ||
        current.causalRepairTimer !== null) return;
    if (current.causalRepairAttempts >= MAX_CAUSAL_REPAIR_ATTEMPTS) {
      current.protocolError = "Shared note history could not be repaired";
      current.joined = false;
      channel.send("leave", { path: current.path });
      render();
      return;
    }
    current.causalRepairTimer = setTimeout(() => {
      current.causalRepairTimer = null;
      if (sessions.get(current.path) !== current || !ws.isOpen() ||
          !current.joined || current.generationMismatch || current.protocolError) return;
      if (!hasMissingYjsAncestors(current.doc)) {
        clearCausalRepair(current);
        render();
        return;
      }
      current.causalRepairAttempts++;
      // Re-joining is idempotent for an already-present WebSocket peer.
      // The server sends its full original Yjs state, not a re-created
      // text snapshot, so dependent updates can be integrated exactly once.
      channel.send("join", { path: current.path, name: ownDisplayName() });
      ensureCausalConvergence(current);
    }, causalRepairDelay(current.causalRepairAttempts));
  }

  function sendUpdate(current, bytes) {
    if (!current.joined || current.generationMismatch || !ws.isOpen()) {
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

  function guardEditor(editor) {
    const contentDOM = editor.cm?.contentDOM;

    if (!contentDOM) {
      return () => {};
    }

    const previous = contentDOM.getAttribute("contenteditable");
    contentDOM.setAttribute("contenteditable", "false");
    contentDOM.setAttribute("aria-busy", "true");
    return () => {
      if (previous === null) {
        contentDOM.removeAttribute("contenteditable");
      } else {
        contentDOM.setAttribute("contenteditable", previous);
      }

      contentDOM.removeAttribute("aria-busy");
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

      if (revision === current.previewRevision && sessions.get(current.path) === current) {
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
    if (!current || !current.initialized || !current.joined || !ws.isOpen() ||
        current.suppress) {
      return;
    }

    const editor = current.composing
      ? current.composingEditor : current.editor;
    const selected = editor?.cm?.state?.selection;
    const text = current.composing
      ? current.imeSnapshot?.text : current.text;

    if (!selected || !text || (current.composing &&
        editor.getValue() !== text.toString())) {
      // A candidate may be visible in the IME's native DOM before CM6/Yjs
      // has received it. Keep the previous awareness; never send "away".
      return;
    }

    const encoded = encodeCursorSelections(text, selected.ranges, selected.mainIndex);
    if (!encoded) {
      current.protocolError = "Too many selections for shared cursor protocol (maximum 32)";
      render();
      return;
    }
    const signature = JSON.stringify([encoded.selections, encoded.mainIndex]);

    if (current.lastSelection === signature) {
      return;
    }

    current.lastSelection = signature;
    channel.send("cursor", {
      path: current.path, documentId: current.serverDocumentId, ...encoded
    });
  }

  function scheduleSelection(current) {
    if (!current || current !== session) {
      return;
    }

    clearTimeout(current.selectionTimer);
    current.selectionTimer = setTimeout(() => sendSelection(current), 65);
  }

  function clearSelection(current) {
    if (!current) {
      return;
    }

    clearTimeout(current.selectionTimer);
    current.lastSelection = null;

    if (current.joined && ws.isOpen()) {
      channel.send("cursor-away", {
        path: current.path, documentId: current.serverDocumentId
      });
    }
  }

  function finishComposition(current) {
    clearTimeout(current.compositionTimer);

    if (!current.composing || !current.initialized) {
      return;
    }

    // The composing browser DOM stays at its frozen baseline, while remote
    // Yjs edits and interim IME text have remained live for other panes and
    // tabs. Commit the final input from that frozen CRDT history.
    const editor = current.composingEditor || current.editor;
    let committed = false;
    current.sourceEditor = editor;
    try {
      commitComposition(current.doc, current.imeSnapshot, editor.getValue(), LOCAL);
      committed = true;
    } catch (error) {
      // Never replace uncommitted user input with a remote snapshot on error.
      current.pendingConflict = editor.getValue();
      current.protocolError = "IME draft could not be merged · recoverable text retained";
      console.error("[collab] IME commit failed:", error);
    } finally {
      current.sourceEditor = null;
      current.composing = false;
      current.composingEditor = null;
      current.imeSnapshot = null;
      current.imeGuard = null;
      current.imeProjectionBlocked = false;
      current.compositionPublished = false;
    }
    current.local.flushPeerUpdates();
    if (committed) {
      current.suppress = true;
      try {
        reconcileEditorState(editor, current.text.toString());
      } finally {
        current.suppress = false;
      }
      renderPeers(current);
      scheduleSelection(current);
    }
    render();
  }

  function bindEditor(current, editor) {
    if (current.bindings.has(editor)) {
      return;
    }

    // A MarkdownView may reuse the SAME Editor object while changing files.
    // A new note must never acquire a command binding while the previous note
    // still owns it: otherwise the old note's teardown can restore native
    // CodeMirror Undo over the new note's Yjs command guard.
    const previous = editorOwners.get(editor);

    if (previous && previous !== current) {
      previous.bindings.get(editor)?.detach();
    }

    const binding = {
      editor,
      overlay: createCursorOverlay({ editor, text: current.text }),
      unlock: !current.initialized ? guardEditor(editor) : null,
    };
    current.bindings.set(editor, binding);
    editorOwners.set(editor, current);

    if (current.initialized) {
      current.suppress = true;

      try {
        reconcileEditorState(editor, current.text.toString());
      } finally {
        current.suppress = false;
      }
    }

    const undo = () => current.undoManager.undo();
    const redo = () => current.undoManager.redo();
    const restoreHistory = bindCollaborativeHistory(editor, {
      isActive: () => current.initialized && sessions.get(current.path) === current,
      // The native CodeMirror history is never authoritative while the
      // editor is waiting for an offline/remote CRDT baseline either.
      isLocked: () => !current.initialized || Boolean(current.generationMismatch),
      undo,
      redo,
    });

    const onUndoShortcut = (event) => {
      if (!current.initialized || sessions.get(current.path) !== current ||
          event.isComposing || !editor.cm?.dom?.contains(event.target) ||
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

        if (!current.generationMismatch) {
          (wantsUndo ? undo : redo)();
        }
      }
    };
    document.addEventListener("keydown", onUndoShortcut, true);

    const onCursorMotion = () => {
      if (session === current && (current.editor === editor || editor.cm?.hasFocus)) {
        current.editor = editor;
        scheduleSelection(current);
      }
    };
    const cmDom = editor.cm?.dom;
    const events = ["keyup", "mouseup", "pointerup", "focusin"];

    for (const event of events) {
      cmDom?.addEventListener(event, onCursorMotion);
    }

    const onCompositionStart = () => {
      if (current.initialized && !current.composing) {
        if (current === session) sendSelection(current);
        current.imeSnapshot = beginComposition(current.doc);
        const selection = editor.cm?.state?.selection?.main;
        current.imeGuard = selection ?
          { from:selection.from, to:selection.to } : null;
        current.imeProjectionBlocked = false;
        current.compositionPublished = false;
        current.composing = true;
        current.composingEditor = editor;
        // Candidate selection remains owned by this editor; do not broadcast
        // "cursor-away" or make other participants think it has disappeared.
        if (current === session) render();
      }
    };
    const onCompositionEnd = () => {
      if (current.composing && current.composingEditor === editor) {
        clearTimeout(current.compositionTimer);
        current.compositionTimer = setTimeout(() => finishComposition(current), 0);
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

    binding.detach = () => {
      if (editorOwners.get(editor) === current) {
        editorOwners.delete(editor);
      }

      if (current.composingEditor === editor) {
        finishComposition(current);
      }

      document.removeEventListener("keydown", onUndoShortcut, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      for (const event of events) {
        cmDom?.removeEventListener(event, onCursorMotion);
      }

      cmDom?.removeEventListener("compositionstart", onCompositionStart);
      cmDom?.removeEventListener("compositionend", onCompositionEnd);
      restoreHistory();
      binding.overlay.destroy();
      binding.unlock?.();
      current.bindings.delete(editor);
    };
  }

  function unlockEditors(current) {
    for (const binding of current.bindings.values()) {
      binding.unlock?.();
      binding.unlock = null;
    }
  }

  function dispose(current) {
    if (!current) {
      return;
    }

    // Native IME composition must finish against this live Y.Doc before its
    // room membership is removed, even if the composing pane is closing.
    finishComposition(current);
    clearCausalRepair(current);
    sessions.delete(current.path);

    if (session === current) {
      session = null;
    }

    if (current.joined && ws.isOpen()) {
      channel.send("leave", { path: current.path });
    }

    clearTimeout(current.selectionTimer);
    if (current.previewTimer) {
      writeOfflinePreview(current);
    }
    current.undoManager?.destroy();

    for (const binding of current.bindings.values()) {
      binding.detach();
    }
    current.local?.close().catch((error) => {
      console.warn("[collab] Could not close offline document:", error);
    });
    render();
  }

  function openSession(view) {
    const file = view?.file;
    const editor = view?.editor;

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
      serverDocumentId: null,
      generationMismatch: null,
      joinConflictReason: null,
      hasLocalCopy: false,
      identitySaving: false,
      recoveredGenerationDraft: false,
      protocolError: null,
      previewSaving: false,
      previewRevision: 0,
      previewTimer: null,
      causalGap: false,
      causalRepairTimer: null,
      causalRepairAttempts: 0,
      previewPromise: Promise.resolve(),
      suppress: false,
      participants: 1,
      people: new Map(),
      self: null,
      lastSelection: null,
      selectionTimer: null,
      bindings: new Map(),
      sourceEditor: null,
      composing: false,
      composingEditor: null,
      imeSnapshot: null,
      imeGuard: null,
      imeProjectionBlocked: false,
      compositionPublished: false,
      compositionTimer: null,
    };

    const local = createOfflineDocument(window.__currentVaultId, file.path, (storage) => {
      if (sessions.get(next.path) === next) {
        next.localSaving = storage.isSaving;
        next.storageError = storage.error;
        render();
      }
    }, () => Boolean(next.generationMismatch));
    const { doc, text } = local;
    next.doc = doc;
    next.text = text;
    next.local = local;
    next.undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 500,
    });

    sessions.set(next.path, next);
    bindEditor(next, editor);

    doc.on("update", (update, origin) => {
      // The live CRDT stores all peers' operations, including operations
      // touching the unconfirmed candidate. The composing editor is a
      // distinct projection: accept independently safe updates against its
      // own Yjs lineage, even after an earlier conflict was held.
      if (sessions.get(next.path) === next && next.composing &&
          next.composingEditor && next.imeSnapshot &&
          (origin === REMOTE || origin === CROSS_TAB_ORIGIN ||
            next.sourceEditor !== next.composingEditor)) {
        const wasSuppressed=next.suppress;
        next.suppress=true;
        try {
          const decision=projectIndependentCompositionUpdate(
            next.imeSnapshot, update, next.imeGuard,
            (projection,delta)=>patchEditor(next.composingEditor,projection,delta)
          );
          if (decision.projected) {
            next.imeGuard=decision.guard;
            renderPeers(next);
          } else {
            next.imeProjectionBlocked=true;
          }
        } catch (error) {
          // Keep the real composition untouched and the full update in the
          // live doc. It can be reconciled after the IME commits.
          next.imeProjectionBlocked=true;
          console.warn("[collab] IME projection deferred:",error);
        } finally {
          next.suppress=wasSuppressed;
        }
        if (next === session) render();
      }
      if ((origin === LOCAL || origin === next.undoManager || origin === CROSS_TAB_ORIGIN) &&
          sessions.get(next.path) === next) {
        next.dirty = true;
        sendUpdate(next, update);
        render();
      }
    });

    text.observe((event, transaction) => {
      if (sessions.get(next.path) === next) {
        fsShim._contentCache.set(next.path, next.text.toString());
      }

      if (sessions.get(next.path) === next && next.initialized) {
        next.suppress = true;

        try {
          for (const binding of next.bindings.values()) {
            if (binding.editor === next.sourceEditor) continue;
            if (next.composing && binding.editor === next.composingEditor) {
              // A Yjs text observer runs before the corresponding document
              // update event. The latter carries original operation IDs and
              // owns the selective projection, including independent edits
              // received after a different participant's conflict.
              continue;
            } else {
              if (!patchEditor(binding.editor, next.text, event.delta)) {
                reconcileEditorState(binding.editor, next.text.toString());
              }
            }
          }
        } finally {
          next.suppress = false;
        }

        renderPeers(next);
        scheduleOfflinePreview(next);
      }
    });

    render();

    local.ready.then(async (hasLocalCopy) => {
      const [storedId, unsentDraft, replacedDraft] = await Promise.all([
        next.local.persistence.get("server-document-id"),
        next.local.persistence.get("unsent-startup-draft"),
        next.local.recoverReplacedDraft(),
      ]);

      if (sessions.get(next.path) !== next) {
        return;
      }

      next.serverDocumentId = storedId || next.local.activeGeneration || null;
      next.hasLocalCopy = hasLocalCopy;
      next.pendingConflict = typeof unsentDraft === "string"
        ? unsentDraft : (typeof replacedDraft === "string" ? replacedDraft : null);
      next.recoveredGenerationDraft = typeof replacedDraft === "string";
      next.hydrated = true;

      if (hasLocalCopy) {
        next.initialized = true;
        for (const binding of next.bindings.values()) {
          reconcileEditorState(binding.editor, next.text.toString());
        }
        fsShim._contentCache.set(next.path, next.text.toString());
        unlockEditors(next);
        scheduleOfflinePreview(next);
      }

      render();
      sendJoin(next);
    }).catch((error) => {
      console.error("[collab] Local draft initialization failed:", error);

      if (sessions.get(next.path) === next) {
        next.storageError = error;
        render();
      }
    });
  }

  function syncActive() {
    // A Yjs document is owned by its vault/path, not by whichever pane most
    // recently gained focus. Every visible editor is a view of that document.
    const visible = new Map();

    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      const path = view?.file?.path;

      if (!path?.toLowerCase().endsWith(".md") || !view.editor) {
        continue;
      }

      if (!visible.has(path)) {
        visible.set(path, []);
      }

      visible.get(path).push(view);
    }

    // Release stale panes BEFORE rebinding any new document. This also makes
    // the transition atomic at the editor-command ownership boundary.
    for (const current of sessions.values()) {
      if (!visible.has(current.path)) {
        dispose(current);
        continue;
      }

      const stillPresent = new Set(visible.get(current.path).map(view => view.editor));

      for (const binding of current.bindings.values()) {
        if (!stillPresent.has(binding.editor)) {
          binding.detach();
        }
      }
    }

    for (const [path, views] of visible) {
      if (!sessions.has(path)) {
        openSession(views[0]);
      }

      const current = sessions.get(path);
      const editors = new Set(views.map((view) => view.editor));

      for (const view of views) {
        bindEditor(current, view.editor);
      }

      for (const binding of current.bindings.values()) {
        if (!editors.has(binding.editor)) {
          binding.detach();
        }
      }

      if (!editors.has(current.editor)) {
        current.editor = views[0].editor;
      }
    }

    const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const active = activeView?.file ? sessions.get(activeView.file.path) || null : null;

    if (session !== active) {
      clearSelection(session);
      peopleModal?.close();
    }

    session = active;
    status.setAttribute("title", session
      ? `Collaboration status for ${session.path}`
      : "No active Markdown note");

    if (session && session.bindings.has(activeView.editor)) {
      session.editor = activeView.editor;
      scheduleSelection(session);
    }

    render();
  }

  function scheduleActive() {
    clearTimeout(activeTimer);
    activeTimer = setTimeout(syncActive, 0);
  }

  const unsubscribe = [
    channel.subscribe("init", async (msg) => {
      const current = sessions.get(msg.path);

      if (!current?.hydrated) {
        return;
      }

      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(msg.documentId)) {
        current.protocolError = "Server did not provide a valid note identity";
        channel.send("leave", { path: current.path });
        render();
        return;
      }

      let decision;
      try {
        // The server supplied a Yjs snapshot, not a plain string. Inspect
        // its independent text before letting it touch a local Y.Doc.
        let incomingText = "";
        if (current.hasLocalCopy && !current.serverDocumentId) {
          const candidate = new Y.Doc();
          try {
            Y.applyUpdate(candidate, decodeUpdate(msg.state));
            incomingText = candidate.getText("content").toString();
          } finally {
            candidate.destroy();
          }
        }
        decision = classifyDocumentAncestry({
          hasLocalCopy: current.hasLocalCopy,
          localDocumentId: current.serverDocumentId,
          incomingDocumentId: msg.documentId,
          localText: current.text.toString(), incomingText,
          localHasOperations: Y.decodeStateVector(
            Y.encodeStateVector(current.doc)).size > 0,
        });
      } catch {
        current.protocolError = "Could not verify incoming note history";
        channel.send("leave", { path: current.path });
        render();
        return;
      }

      if (decision === "replaced" || decision === "independent") {
        // A deleted/recreated path is NOT the old note. It cannot accept old
        // offline operations merely because the filename was reused. The
        // same applies to two separate originals never sharing a document ID.
        current.generationMismatch = msg.documentId;
        current.joinConflictReason = decision;
        current.joined = false;
        current.pendingConflict = current.text.toString();
        current.people.clear();

        for (const binding of current.bindings.values()) {
          binding.unlock ||= guardEditor(binding.editor);
        }

        channel.send("leave", { path: current.path });
        render();
        return;
      }

      if (decision === "adopt-identical") {
        // Visible bytes are the same, but CRDT struct IDs are NOT. Do not
        // merge the two Yjs histories. Durably switch to the exact server
        // generation, leaving the old journal untouched for recovery.
        current.generationMismatch = msg.documentId;
        for (const binding of current.bindings.values()) {
          binding.unlock ||= guardEditor(binding.editor);
        }
        try {
          const adopted = await current.local.activateGeneration(msg.documentId, null,
            () => sessions.get(current.path) === current);
          if (!adopted) return;
          if (sessions.get(current.path) === current) {
            dispose(current);
            syncActive();
          }
        } catch (error) {
          current.storageError = error;
          current.protocolError = "Could not safely switch identical note history";
          channel.send("leave", { path: current.path });
          render();
        }
        return;
      }

      const preJoinText = current.editor.getValue();
      const changedWhileJoining = !current.initialized && preJoinText !== current.initial;

      try {
        current.local.stageServerIdentity(msg.documentId);
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

        for (const binding of current.bindings.values()) {
          reconcileEditorState(binding.editor, current.text.toString());
        }
        fsShim._contentCache.set(current.path, current.text.toString());
        unlockEditors(current);
        current.serverDocumentId = msg.documentId;
        current.identitySaving = true;
        current.local.markInitialized()
          .then(() => current.local.setServerIdentity(msg.documentId))
          .catch((error) => {
            current.storageError = error;
          }).finally(() => {
            current.identitySaving = false;
            render();
          });
        scheduleOfflinePreview(current);
        // Full state exchange includes local edits retained while disconnected.
        sendUpdate(current, Y.encodeStateAsUpdate(current.doc));
        ensureCausalConvergence(current);
        render();
        renderPeers(current);
        scheduleSelection(current);
      } catch (error) {
        console.error("[collab] Failed to initialize note:", error);
        status.setText("Collab: initialization failed");
      }
    }),
    channel.subscribe("update", (msg) => {
      const current = sessions.get(msg.path);

      if (!current?.initialized || current.generationMismatch) {
        return;
      }

      try {
        const bytes = decodeUpdate(msg.update);

        // Remote state is always live. Only the composing DOM is deferred,
        // so another pane can display changes without disturbing IME input.
        Y.applyUpdate(current.doc, bytes, REMOTE);
        ensureCausalConvergence(current);
      } catch (error) {
        console.error("[collab] Invalid remote update:", error);
      }
    }),
    channel.subscribe("presence", (msg) => {
      const current = sessions.get(msg.path);

      if (current?.joined && !current.generationMismatch &&
          (!msg.documentId || msg.documentId === current.serverDocumentId)) {
        current.participants = msg.participants;
        if (Array.isArray(msg.people)) {
          current.people = new Map(msg.people.map((person) => [person.id, person]));
          current.self = current.people.get(current.self?.id) || current.self;
        }

        render();
        renderPeers(current);
        if (peopleModal?.isOpen && current === session) {
          peopleModal.refreshPeople();
        }
      }
    }),
    channel.subscribe("cursor", (msg) => {
      const current = sessions.get(msg.path);

      if (!current?.joined || current.generationMismatch ||
          (msg.documentId && msg.documentId !== current.serverDocumentId) ||
          msg.id === current.self?.id) {
        return;
      }

      const person = current.people.get(msg.id);

      if (person) {
        person.anchor = msg.anchor;
        person.head = msg.head;
        person.selections = Array.isArray(msg.selections)
          ? msg.selections : msg.anchor && msg.head
            ? [{ anchor: msg.anchor, head: msg.head }] : [];
        person.mainIndex = Number.isSafeInteger(msg.mainIndex)
          ? msg.mainIndex : 0;
        renderPeers(current);
      }
    }),
    channel.subscribe("error", (msg) => {
      const current = sessions.get(msg.path);

      if (current) {
        console.error("[collab]", msg.error);
        current.protocolError = msg.error;
        render();
      }
    }),
    channel.subscribe("saved", (msg) => {
      const current = sessions.get(msg.path);

      if (!current || !Number.isSafeInteger(msg.seq)) {
        return;
      }

      current.confirmedSeq = Math.max(current.confirmedSeq, msg.seq);
      current.serverSaveError = false;
      current.protocolError = null;

      if (current.confirmedSeq >= current.sentSeq && current.joined) {
        current.dirty = false;
      }

      render();
    }),
    channel.subscribe("save-error", (msg) => {
      const current = sessions.get(msg.path);

      if (current) {
        current.serverSaveError = true;
        current.dirty = true;
        render();
      }
    }),
    ws.onStateChange((state) => {
      transportState = state;
      for (const current of sessions.values()) {
        current.joined = false;
        if (state !== "open") {
          clearTimeout(current.causalRepairTimer);
          current.causalRepairTimer = null;
          current.causalRepairAttempts = 0;
        }

        if (state === "open") {
          sendJoin(current);
        } else {
          current.people.clear();
          current.participants = 1;
          renderPeers(current);
        }
      }

      render();
    }),
  ];
  if (writes?.onStateChange) {
    unsubscribe.push(writes.onStateChange(() => render()));
    unsubscribe.push(writes.onFailure(() => render()));
    unsubscribe.push(writes.onFailureChange(() => render()));
  }

  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", scheduleActive));
  plugin.registerEvent(plugin.app.workspace.on("file-open", scheduleActive));
  plugin.registerEvent(plugin.app.workspace.on("layout-change", scheduleActive));
  plugin.registerEvent(plugin.app.workspace.on("editor-change", (editor) => {
    for (const current of sessions.values()) {
      if (!current.bindings.has(editor) || !current.initialized ||
          current.suppress ||
          current.generationMismatch) {
        continue;
      }

      current.sourceEditor = editor;

      try {
        if (current.composing && current.composingEditor === editor) {
          // Publish provisional phonetic/converted text to other clients on
          // each editor transaction, while never reconciling the composing
          // CodeMirror view against remote Yjs changes.
          current.imeGuard = widenCompositionGuard(
            current.imeGuard, current.imeSnapshot.text.toString(),
            editor.getValue());
          if (publishComposition(current.doc, current.imeSnapshot, editor.getValue(), LOCAL)) {
            current.compositionPublished = true;
          }
        } else {
          applyLocalChange(current.text, editor.getValue());
        }
      } finally {
        current.sourceEditor = null;
      }

      if (current === session) {
        current.editor = editor;
        scheduleSelection(current);
      }

      break;
    }
  }));

  plugin.app.workspace.onLayoutReady(scheduleActive);
  scheduleActive();

  return () => {
    clearTimeout(activeTimer);
    peopleModal?.close();
    mobileMenu?.close();

    for (const current of sessions.values()) {
      dispose(current);
    }

    for (const off of unsubscribe) {
      off();
    }

    status.remove();
    unmountNavbarAction();
    delete window.__ignis.collaboration;
  };
}

export { applyLocalChange };
