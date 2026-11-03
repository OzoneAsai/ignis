// One editing model, two directions: local changes become distinct Yjs operations;
// remote Yjs deltas become one CodeMirror transaction without resetting editor UI.
import diff from "fast-diff";

export function localChanges(before, after) {
  if (before === after) {
    return [];
  }

  const result = [];

  for (const [kind, content] of diff(before, after)) {
    if (kind === diff.EQUAL) {
      result.push({ retain: content.length });
    } else if (kind === diff.DELETE) {
      result.push({ delete: content.length });
    } else {
      result.push({ insert: content });
    }
  }

  return result;
}

export function deltaToChanges(delta) {
  const changes = [];
  let pos = 0;
  let from = null;
  let deleted = 0;
  let inserted = "";

  function flush() {
    if (from !== null) {
      changes.push({ from, to: from + deleted, insert: inserted });
      from = null;
      deleted = 0;
      inserted = "";
    }
  }

  for (const operation of delta) {
    if (Number.isInteger(operation.retain)) {
      flush();
      pos += operation.retain;
    } else if (Number.isInteger(operation.delete)) {
      if (from === null) {
        from = pos;
      }

      deleted += operation.delete;
      pos += operation.delete;
    } else if (typeof operation.insert === "string") {
      if (from === null) {
        from = pos;
      }

      inserted += operation.insert;
    } else {
      throw new Error("Unexpected non-text CRDT operation");
    }
  }

  flush();
  return changes;
}

export function patchEditor(editor, text, delta) {
  const cm = editor?.cm;

  if (!cm?.dispatch || !cm.state?.doc || !cm.state?.changes) {
    return false;
  }

  const changes = deltaToChanges(delta);

  if (changes.length === 0) {
    return true;
  }

  const originalLength = cm.state.doc.length;
  const changedLength = changes.reduce(
    (length, change) => length + change.insert.length - (change.to - change.from),
    originalLength,
  );

  if (changedLength !== text.length || changes.at(-1).to > originalLength) {
    // The editor and CRDT are out of step (e.g. a native plugin write).
    // Do not silently replace the entire editor or collapse its selection.
    return false;
  }

  // Length alone does not establish that the old editor and Yjs states
  // coincide. The view may have been modified by an ordinary plugin write.
  // Validate the exact post-transaction document BEFORE touching the editor.
  // A mismatch falls back to a single minimal reconciliation transaction.
  try {
    if (cm.state.changes(changes).apply(cm.state.doc).toString() !== text.toString()) {
      return false;
    }
  } catch {
    return false;
  }

  // CodeMirror maps all existing selection ranges through the transaction.
  // No DOM replacement, no explicit cursor reset, no scroll-to-position request.
  cm.dispatch({ changes });
  return true;
}

export function reconcileEditor(editor, target) {
  const before = editor.getValue();

  if (before === target) {
    return true;
  }

  const changes = deltaToChanges(localChanges(before, target));
  const cm = editor.cm;

  if (!cm?.dispatch) {
    return false;
  }

  cm.dispatch({ changes });
  return true;
}
