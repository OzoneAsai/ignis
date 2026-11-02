// Browser Markdown collaboration: bind the existing Obsidian Editor to Y.Text.
// The shared Ignis WebSocket transports Yjs updates, not whole-file snapshots.
import { MarkdownView } from "obsidian";
import * as Y from "yjs";

const REMOTE = "remote";
const LOCAL = "local";

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
  }

  function sendJoin() {
    if (session && ws.isOpen()) {
      channel.send("join", { path: session.path });
    }
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
    };

    doc.on("update", (update, origin) => {
      if (origin !== REMOTE && session === next && next.joined && ws.isOpen()) {
        channel.send("update", { path: next.path, update: encodeUpdate(update) });
      }
    });

    text.observe(() => {
      if (session === next && next.initialized) {
        reconcileEditor(next);
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
        render();
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
        session.joined = state === "open" ? false : session.joined;

        if (state === "open") {
          sendJoin();
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
    }
  }));

  plugin.app.workspace.onLayoutReady(scheduleActive);
  scheduleActive();

  return () => {
    clearTimeout(activeTimer);
    dispose();

    for (const off of unsubscribe) {
      off();
    }

    status.remove();
  };
}

export { changeSpan, applyLocalChange };
