// Ephemeral cursor awareness. The serialized positions point into Y.Text, so
// insertions/deletions can rebase the remote caret without absolute offsets.
import { resolveCursorSelections } from "./collab-cursor-protocol.js";
import { visibleSelectionGlyphRects, MAX_GLYPH_FRAGMENTS } from "./selection-glyphs.js";
export {
  MAX_SHARED_SELECTIONS, encodeCursorSelection, encodeCursorSelections,
  selectionEntries, resolveCursorSelection, resolveCursorSelections
} from "./collab-cursor-protocol.js";
import {
  createOverlaySpace, cursorLabelTextColor, cursorHighlightTint, layoutCursorLabels,
  visibleContentObstacles,
} from "./cursor-label-layout.js";

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
    let remainingMarks = MAX_GLYPH_FRAGMENTS;
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
      // Use DOM Range glyph fragments, not a rectangle spanning each line.
      // This matches native CM6 Decoration.mark across soft-wrap, inline
      // syntax, mixed text directions and partial line selections.
      const measured = visibleSelectionGlyphRects(cm, space, from, to, remainingMarks);
      const rects = measured.rects;
      remainingMarks -= rects.length;
      highlightsLimited ||= measured.limited;

      for (let i = 0; i < rects.length; i++) {
        let mark = record.marks[i];

        if (!mark) {
          mark = document.createElement("span");
          mark.className = "ignis-collab-remote-selection";
          mark.dataset.collabPeer = peer.id;
          mark.dataset.collabSelection = key;
          root.appendChild(mark);
          record.marks.push(mark);
        }

        mark.style.backgroundColor = cursorHighlightTint(color);
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
