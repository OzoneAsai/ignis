// Ephemeral cursor awareness. The serialized positions point into Y.Text, so
// insertions/deletions can rebase the remote caret without absolute offsets.
import * as Y from "yjs";

function encode(bytes) {
  let value = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return btoa(value);
}

function decode(value) {
  if (typeof value !== "string" || value.length > 512) {
    return null;
  }

  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function encodeCursorSelection(text, anchor, head) {
  const size = text.length;
  const at = (index) => encode(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(size, index))),
  ));

  return { anchor: at(anchor), head: at(head) };
}

export function resolveCursorSelection(text, peer) {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decode(peer.anchor)), text.doc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decode(peer.head)), text.doc,
    );

    if (!start || !end || start.type !== text || end.type !== text) {
      return null;
    }

    return { anchor: start.index, head: end.index };
  } catch {
    return null;
  }
}

function selectionRects(cm, root, start, end) {
  const rects = [];
  const doc = cm.state.doc;
  const visibleFrom = Math.max(start, cm.viewport?.from ?? 0);
  const visibleTo = Math.min(end, cm.viewport?.to ?? doc.length);
  let count = 0;

  for (let position = visibleFrom; position < visibleTo && count < 250;) {
    const line = doc.lineAt(position);
    const lineEnd = Math.min(line.to, visibleTo);
    const first = cm.coordsAtPos(position);
    const last = cm.coordsAtPos(lineEnd);

    if (first && last) {
      rects.push({
        left: first.left - root.left,
        top: first.top - root.top,
        height: Math.max(1, last.bottom - first.top),
        width: Math.max(2, last.left - first.left),
      });
    }

    position = Math.max(position + 1, lineEnd + 1);
    count++;
  }

  return rects;
}

export function createCursorOverlay(session) {
  const cm = session.editor?.cm;

  if (!cm?.dom || !cm.coordsAtPos || !cm.state) {
    return { render() {}, destroy() {} };
  }

  const root = document.createElement("div");
  root.className = "ignis-collab-cursors";
  root.setAttribute("aria-hidden", "true");
  cm.dom.appendChild(root);
  let raf = 0;
  let peers = [];
  const nodes = new Map();

  function discard(id) {
    const record = nodes.get(id);

    if (!record) {
      return;
    }

    record.caret.remove();

    for (const mark of record.marks) {
      mark.remove();
    }

    nodes.delete(id);
  }

  function ensure(peer) {
    if (nodes.has(peer.id)) {
      return nodes.get(peer.id);
    }

    const caret = document.createElement("div");
    caret.className = "ignis-collab-remote-caret";
    caret.dataset.collabPeer = peer.id;
    const label = document.createElement("span");
    label.className = "ignis-collab-remote-label";
    caret.appendChild(label);
    root.appendChild(caret);
    const record = { caret, label, marks: [] };
    nodes.set(peer.id, record);
    return record;
  }

  function paint() {
    raf = 0;
    const bounds = cm.dom.getBoundingClientRect();
    const displayed = new Set();

    for (const peer of peers) {
      const selection = resolveCursorSelection(session.text, peer);

      if (!selection) {
        continue;
      }

      displayed.add(peer.id);
      const offset = Math.max(0, Math.min(cm.state.doc.length, selection.head));
      const caretCoords = cm.coordsAtPos(offset);
      const visible = caretCoords && caretCoords.bottom >= bounds.top &&
        caretCoords.top <= bounds.bottom;
      const color = /^#[0-9a-fA-F]{6}$/.test(peer.color) ? peer.color : "#59baf2";
      const record = ensure(peer);
      record.caret.style.display = visible ? "" : "none";
      record.caret.style.setProperty("--ignis-peer-color", color);
      const name = peer.label || peer.name;

      if (record.label.textContent !== name) {
        record.label.textContent = name;
      }

      if (visible) {
        record.caret.style.left = `${caretCoords.left - bounds.left}px`;
        record.caret.style.top = `${caretCoords.top - bounds.top}px`;
        record.caret.style.height = `${Math.max(1, caretCoords.bottom - caretCoords.top)}px`;
      }

      const from = Math.min(selection.anchor, selection.head);
      const to = Math.max(selection.anchor, selection.head);
      const rects = selectionRects(cm, bounds, from, to);

      for (let i = 0; i < rects.length; i++) {
        let mark = record.marks[i];

        if (!mark) {
          mark = document.createElement("span");
          mark.className = "ignis-collab-remote-selection";
          root.appendChild(mark);
          record.marks.push(mark);
        }

        mark.style.setProperty("--ignis-peer-color", color);
        const rect = rects[i];
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
      }

      while (record.marks.length > rects.length) {
        record.marks.pop().remove();
      }
    }

    for (const id of nodes.keys()) {
      if (!displayed.has(id)) {
        discard(id);
      }
    }
  }

  function render(nextPeers) {
    if (nextPeers) {
      peers = nextPeers;
    }

    // Clearing awareness must not depend on animation frames: browsers pause
    // requestAnimationFrame in hidden tabs, but departed cursors must vanish.
    if (peers.length === 0) {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }

      for (const id of nodes.keys()) {
        discard(id);
      }
      return;
    }

    if (!raf) {
      raf = window.requestAnimationFrame(paint);
    }
  }

  const onScroll = () => render();
  cm.scrollDOM?.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  let observer = null;

  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(onScroll);
    observer.observe(cm.dom);
  }

  return {
    render,
    destroy() {
      if (raf) {
        window.cancelAnimationFrame(raf);
      }

      observer?.disconnect();
      cm.scrollDOM?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      root.remove();
    },
  };
}
