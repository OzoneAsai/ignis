// Browser Markdown collaboration: bind the existing Obsidian Editor to Y.Text.
// The shared Ignis WebSocket transports Yjs updates, not whole-file snapshots.
import { MarkdownView, Modal } from "obsidian";
import * as Y from "yjs";
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
  constructor(app, getPeople, getName, setName) {
    super(app);
    this.getPeople = getPeople;
    this.getName = getName;
    this.setName = setName;
  }

  onOpen() {
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.replaceChildren();
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
    root.createEl("h4", { text: "People in this note" });
    const participants = this.getPeople();

    for (const person of participants) {
      const entry = root.createDiv({ cls: "ignis-collab-person" });
      const color = entry.createSpan({ cls: "ignis-collab-person-color" });
      color.style.setProperty("--ignis-peer-color", person.color);
      entry.createSpan({ text: person.name + (person.isSelf ? " (you)" : "") });
      entry.createEl("small", { text: `· ${person.id.slice(0, 6)}` });
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

function changeSpan(before, after) {
  let prefix = 0;

  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) {
    prefix++;
  }

  let suffix = 0;

  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

function applyLocalChange(ytext, value) {
  const before = ytext.toString();

  if (before === value) {
    return;
  }

  const { from, to, insert } = changeSpan(before, value);

  ytext.doc.transact(() => {
    if (to > from) {
      ytext.delete(from, to - from);
    }

    if (insert) {
      ytext.insert(from, insert);
    }
  }, LOCAL);
}

function reconcileEditor(session) {
  const editor = session.editor;
  const before = editor.getValue();
  const after = session.text.toString();

  if (before === after) {
    return;
  }

  const { from, to, insert } = changeSpan(before, after);
  const oldCursor = editor.posToOffset(editor.getCursor());
  const nextCursor = oldCursor < from
    ? oldCursor
    : oldCursor > to
      ? oldCursor + insert.length - (to - from)
      : from + insert.length;

  session.suppress = true;

  try {
    editor.replaceRange(insert, editor.offsetToPos(from), editor.offsetToPos(to));
    editor.setCursor(editor.offsetToPos(Math.min(after.length, nextCursor)));
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
      status.setText("");
      return;
    }

    if (!ws.isOpen()) {
      status.setText("Collab: offline");
    } else if (!session.joined) {
      status.setText("Collab: joining…");
    } else {
      status.setText(`Collab: ${session.participants} online`);
    }

    renderPeers(session);
    if (peopleModal?.isOpen) {
      peopleModal.render();
    }
  }

  function sendJoin() {
    if (session && ws.isOpen()) {
      channel.send("join", { path: session.path, name: ownDisplayName() });
    }
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
    current.removeEditorListeners?.();
    current.overlay?.destroy();
    current.doc.destroy();
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

    const doc = new Y.Doc();
    const text = doc.getText("content");
    const next = {
      path: file.path,
      editor,
      doc,
      text,
      initial: editor.getValue(),
      initialized: false,
      joined: false,
      suppress: false,
      participants: 1,
      people: new Map(),
      self: null,
      lastSelection: null,
      selectionTimer: null,
    };

    next.overlay = createCursorOverlay(next);

    const onCursorMotion = () => scheduleSelection(next);
    const cmDom = editor.cm?.dom;
    const events = ["keyup", "mouseup", "pointerup", "focusin"];

    for (const event of events) {
      cmDom?.addEventListener(event, onCursorMotion);
    }

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
    };

    doc.on("update", (update, origin) => {
      if (origin !== REMOTE && session === next && next.joined && ws.isOpen()) {
        channel.send("update", { path: next.path, update: encodeUpdate(update) });
      }
    });

    text.observe(() => {
      if (session === next && next.initialized) {
        reconcileEditor(next);
        renderPeers(next);
      }
    });

    session = next;
    render();
    sendJoin();
  }

  function scheduleActive() {
    clearTimeout(activeTimer);
    activeTimer = setTimeout(syncActive, 0);
  }

  const unsubscribe = [
    channel.subscribe("init", (msg) => {
      if (!session || msg.path !== session.path) {
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
          // Preserve edits made during the initial WebSocket handshake.
          applyLocalChange(current.text, preJoinText);
        }

        reconcileEditor(current);
        // Full state exchange also catches any edits made while disconnected.
        channel.send("update", {
          path: current.path,
          update: encodeUpdate(Y.encodeStateAsUpdate(current.doc)),
        });
        render();
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
        Y.applyUpdate(session.doc, decodeUpdate(msg.update), REMOTE);
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
        status.setText("Collab: " + msg.error);
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
    if (session?.editor === editor && session.initialized && !session.suppress) {
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
  };
}

export { changeSpan, applyLocalChange };
