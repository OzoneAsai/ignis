// Ephemeral cursor awareness. The serialized positions point into Y.Text, so
// insertions/deletions can rebase the remote caret without absolute offsets.
import * as Y from "yjs";
import {
  createOverlaySpace, cursorLabelTextColor, layoutCursorLabels,
  visibleContentObstacles,
} from "./cursor-label-layout.js";

export const MAX_SHARED_SELECTIONS = 32;

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

export function encodeCursorSelections(text, ranges, mainIndex = 0) {
  if (!Array.isArray(ranges) || ranges.length === 0 ||
      ranges.length > MAX_SHARED_SELECTIONS ||
      !Number.isSafeInteger(mainIndex) || mainIndex < 0 ||
      mainIndex >= ranges.length) return null;
  const selections = ranges.map(({ anchor, head }) =>
    encodeCursorSelection(text, anchor, head));
  if (selections.some(({ anchor, head }) =>
    anchor.length > 512 || head.length > 512)) return null;
  return { selections, mainIndex, ...selections[mainIndex] };
}

export function selectionEntries(peer) {
  if (Array.isArray(peer?.selections)) {
    if (peer.selections.length > MAX_SHARED_SELECTIONS) return [];
    return peer.selections;
  }
  return peer?.anchor && peer?.head
    ? [{ anchor: peer.anchor, head: peer.head }] : [];
}

export function resolveCursorSelections(text, peer) {
  return selectionEntries(peer).map((entry) =>
    resolveCursorSelection(text, entry));
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

function selectionRects(cm, space, start, end, budget) {
  const rects = [];
  const doc = cm.state.doc;
  const visibleFrom = Math.max(start, cm.viewport?.from ?? 0);
  const visibleTo = Math.min(end, cm.viewport?.to ?? doc.length);
  let count = 0;

  for (let position = visibleFrom;
    position < visibleTo && count < Math.min(250, budget);) {
    const line = doc.lineAt(position);
    const lineEnd = Math.min(line.to, visibleTo);
    const first = cm.coordsAtPos(position);
    const last = cm.coordsAtPos(lineEnd);

    if (first && last) {
      const a = space.toLocal(first);
      const b = space.toLocal(last);
      rects.push({
        left: a.left,
        top: a.top,
        height: Math.max(1, b.bottom - a.top),
        width: Math.max(2, b.left - a.left),
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
  const roster = document.createElement("details");
  roster.className = "ignis-collab-people-roster";
  const rosterTitle = document.createElement("summary");
  roster.appendChild(rosterTitle);
  const rosterList = document.createElement("div");
  rosterList.className = "ignis-collab-people-roster-list";
  roster.appendChild(rosterList);
  cm.dom.appendChild(roster);
  let rosterFingerprint = "";
  let raf = 0;
  let peers = [];
  const nodes = new Map();
  const lastBadgePositions = new Map();

  function updateRoster() {
    roster.hidden = peers.length === 0;
    rosterTitle.textContent = peers.length + " other editor" +
      (peers.length === 1 ? "" : "s") + " · show locations";
    const fingerprint = peers.map((peer) =>
      [peer.id, peer.name, peer.color, peer.label].join(":")).join("|");
    if (fingerprint === rosterFingerprint) return;
    rosterFingerprint = fingerprint;
    rosterList.replaceChildren();
    for (const peer of peers) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.collabPeer = peer.id;
      button.className = "ignis-collab-people-jump";
      button.textContent = peer.label || peer.name;
      button.title = "Go to " + (peer.label || peer.name) + "'s cursor";
      button.style.borderLeftColor = /^#[0-9a-fA-F]{6}$/.test(peer.color)
        ? peer.color : "#59baf2";
      button.addEventListener("click", () => {
        const current = peers.find((p) => p.id === peer.id);
        if (!current) return;
        const selections = resolveCursorSelections(session.text, current);
        const mainIndex = Number.isSafeInteger(current.mainIndex) &&
          current.mainIndex >= 0 && current.mainIndex < selections.length
          ? current.mainIndex : 0;
        const head = selections[mainIndex]?.head;
        if (head === undefined) return;
        // Use the mounted editor's own geometry, not a StateEffect created
        // by another bundled copy of CodeMirror (Obsidian may own one).
        const pos = Math.max(0, Math.min(head, cm.state.doc.length));
        const block = cm.lineBlockAt(pos);
        cm.scrollDOM.scrollTop = Math.max(0,
          block.top - cm.scrollDOM.clientHeight / 2);
      });
      rosterList.appendChild(button);
    }
  }

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
    lastBadgePositions.delete(id);
  }

  function ensure(peer, key) {
    if (nodes.has(key)) {
      return nodes.get(key);
    }

    const caret = document.createElement("div");
    caret.className = "ignis-collab-remote-caret";
    caret.dataset.collabPeer = peer.id;
    caret.dataset.collabSelection = key;
    const label = document.createElement("span");
    label.className = "ignis-collab-remote-label";
    caret.appendChild(label);
    root.appendChild(caret);
    const record = { caret, label, marks: [] };
    nodes.set(key, record);
    return record;
  }

  function paint() {
    raf = 0;
    const space = createOverlaySpace(cm.dom);
    if (!space) {
      for (const record of nodes.values()) {
        record.caret.style.display = "none";
      }
      return;
    }
    const bounds = space.bounds;
    const scroll = cm.scrollDOM?.getBoundingClientRect() || cm.dom.getBoundingClientRect();
    const scrollBounds = space.toLocal(scroll);
    const viewport = {
      left: Math.max(0, scrollBounds.left),
      top: Math.max(0, scrollBounds.top),
      right: Math.min(bounds.right, scrollBounds.right),
      bottom: Math.min(bounds.bottom, scrollBounds.bottom),
    };
    const displayed = new Set();
    const badgeItems = [];
    const caretBlockers = [];
    // Carets remain visible for every participant, while long overlapping
    // selections share a bounded DOM budget rather than freezing mobile.
    let remainingMarks = 480;
    let highlightsLimited = false;

    for (const peer of peers) {
      const selected = resolveCursorSelections(session.text, peer);
      const mainIndex = Number.isSafeInteger(peer.mainIndex) &&
        peer.mainIndex >= 0 && peer.mainIndex < selected.length
        ? peer.mainIndex : 0;
      for (const [index, selection] of selected.entries()) {
        if (!selection) continue;
        const key = peer.id + ":" + index;
        displayed.add(key);
      const offset = Math.max(0, Math.min(cm.state.doc.length, selection.head));
      const caretCoords = cm.coordsAtPos(offset);
      const caretLocal = caretCoords ? space.toLocal(caretCoords) : null;
      const visible = caretLocal && caretLocal.bottom >= viewport.top &&
        caretLocal.top <= viewport.bottom && caretLocal.right >= viewport.left &&
        caretLocal.left <= viewport.right;
      const color = /^#[0-9a-fA-F]{6}$/.test(peer.color) ? peer.color : "#59baf2";
      const record = ensure(peer, key);
      record.caret.style.display = visible ? "" : "none";
      record.caret.style.setProperty("--ignis-peer-color", color);
      record.caret.style.setProperty("--ignis-peer-text", cursorLabelTextColor(color));
      const name = index === mainIndex ? peer.label || peer.name : "";

      if (record.label.textContent !== name) {
        record.label.textContent = name;
      }

      record.label.style.display = index === mainIndex ? "" : "none";
      record.label.style.visibility = "hidden";
      if (visible) {
        const { left, top, bottom } = caretLocal;
        record.caret.style.left = `${left}px`;
        record.caret.style.top = `${top}px`;
        record.caret.style.height = `${Math.max(1, bottom - top)}px`;
        caretBlockers.push({
          left: left - 1, top, right: left + 3, bottom
        });
        if (index === mainIndex && name) {
          const measured = record.label.getBoundingClientRect();
          badgeItems.push({
            key, caret: { left, top, bottom },
            width: measured.width / space.scaleX,
            height: measured.height / space.scaleY,
            label: record.label
          });
        }
      }

      const from = Math.min(selection.anchor, selection.head);
      const to = Math.max(selection.anchor, selection.head);
      const selectedInViewport = Math.max(from, cm.viewport?.from ?? 0) <
        Math.min(to, cm.viewport?.to ?? cm.state.doc.length);
      if (selectedInViewport && remainingMarks === 0) highlightsLimited = true;
      const rects = selectionRects(cm, space, from, to, remainingMarks);
      remainingMarks -= rects.length;

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
    }

    for (const id of nodes.keys()) {
      if (!displayed.has(id)) {
        discard(id);
      }
    }
    const textRects = visibleContentObstacles(cm.contentDOM, space, viewport);
    const obstacles = textRects ? [...textRects, ...caretBlockers] : [];
    if (!roster.hidden) {
      obstacles.push(space.toLocal(roster.getBoundingClientRect()));
    }
    // Never cover possibly unmeasured text. Keep all carets and the roster,
    // and hide only the badges that cannot fit in genuinely empty space.
    const placements = textRects
      ? layoutCursorLabels(badgeItems, obstacles, viewport, lastBadgePositions)
      : new Map();
    for (const item of badgeItems) {
      const placement = placements.get(item.key);
      if (!placement) continue;
      item.label.style.left = `${placement.left - item.caret.left}px`;
      item.label.style.top = `${placement.top - item.caret.top}px`;
      item.label.style.visibility = "visible";
      lastBadgePositions.set(item.key, placement);
    }
    rosterTitle.textContent = peers.length + " other editor" +
      (peers.length === 1 ? "" : "s") +
      (highlightsLimited ? " · highlights limited" : " · show locations");
  }

  function render(nextPeers) {
    if (nextPeers) {
      peers = nextPeers;
      updateRoster();
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
  // Text reflow may move an anchor while the editor bounds remain unchanged.
  // contentDOM never contains this overlay, so observing it cannot self-loop.
  const mutationObserver = typeof MutationObserver !== "undefined" && cm.contentDOM
    ? new MutationObserver(onScroll) : null;
  mutationObserver?.observe(cm.contentDOM, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["style", "class"],
  });
  const fonts = document.fonts;
  fonts?.addEventListener?.("loadingdone", onScroll);
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
      mutationObserver?.disconnect();
      fonts?.removeEventListener?.("loadingdone", onScroll);
      root.remove();
      roster.remove();
    },
  };
}
