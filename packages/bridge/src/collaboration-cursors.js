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

function addSelectionRects(container, cm, root, color, start, end) {
  if (start === end) {
    return;
  }

  const doc = cm.state.doc;
  let count = 0;

  for (let position = start; position < end && count < 250;) {
    const line = doc.lineAt(position);
    const lineEnd = Math.min(line.to, end);
    const first = cm.coordsAtPos(position);
    const last = cm.coordsAtPos(lineEnd);

    if (first && last) {
      const mark = document.createElement("span");
      mark.className = "ignis-collab-remote-selection";
      mark.style.setProperty("--ignis-peer-color", color);
      mark.style.left = `${first.left - root.left}px`;
      mark.style.top = `${first.top - root.top}px`;
      mark.style.height = `${Math.max(1, last.bottom - first.top)}px`;
      mark.style.width = `${Math.max(2, last.left - first.left)}px`;
      container.appendChild(mark);
    }

    position = Math.max(position + 1, lineEnd + 1);
    count++;
  }
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

  function paint() {
    raf = 0;
    root.replaceChildren();
    const bounds = cm.dom.getBoundingClientRect();

    for (const peer of peers) {
      const selection = resolveCursorSelection(session.text, peer);

      if (!selection) {
        continue;
      }

      const offset = Math.max(0, Math.min(cm.state.doc.length, selection.head));
      const caretCoords = cm.coordsAtPos(offset);

      if (!caretCoords || caretCoords.bottom < bounds.top || caretCoords.top > bounds.bottom) {
        continue;
      }

      const color = /^#[0-9a-fA-F]{6}$/.test(peer.color) ? peer.color : "#59baf2";
      const wrapper = document.createElement("div");
      wrapper.className = "ignis-collab-remote-caret";
      wrapper.dataset.collabPeer = peer.id;
      wrapper.style.setProperty("--ignis-peer-color", color);
      wrapper.style.left = `${caretCoords.left - bounds.left}px`;
      wrapper.style.top = `${caretCoords.top - bounds.top}px`;
      wrapper.style.height = `${Math.max(1, caretCoords.bottom - caretCoords.top)}px`;

      const label = document.createElement("span");
      label.className = "ignis-collab-remote-label";
      label.textContent = peer.label || peer.name;
      wrapper.appendChild(label);
      root.appendChild(wrapper);

      const from = Math.min(selection.anchor, selection.head);
      const to = Math.max(selection.anchor, selection.head);
      addSelectionRects(root, cm, bounds, color, from, to);
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

      root.replaceChildren();
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
