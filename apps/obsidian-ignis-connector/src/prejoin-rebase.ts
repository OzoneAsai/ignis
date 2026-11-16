import diff from "fast-diff";

export type TextEdit = { from: number; to: number; insert: string };
export type PrejoinRebase =
  | { kind: "merged"; text: string }
  | { kind: "review" };

// A native editor may accept keystrokes before its WebSocket/Yjs handshake.
// Rebase those keystrokes only when the caller supplies a VERIFIED common
// ancestor (the same server file generation and its hashed initial bytes).
// Changes in different ancestor spans are independent; competing changes
// to one span remain separate drafts for review, not auto-resolved by order.
export function textEdits(before: string, after: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let position = 0;
  let start: number | null = null;
  let removed = 0;
  let inserted = "";
  const flush = () => {
    if (start !== null) {
      edits.push({ from: start, to: start + removed, insert: inserted });
      start = null;
      removed = 0;
      inserted = "";
    }
  };
  for (const [kind, content] of diff(before, after)) {
    if (kind === diff.EQUAL) {
      flush();
      position += content.length;
    } else if (kind === diff.DELETE) {
      if (start === null) start = position;
      removed += content.length;
      position += content.length;
    } else {
      if (start === null) start = position;
      inserted += content;
    }
  }
  flush();
  return edits;
}

function compete(left: TextEdit, right: TextEdit): boolean {
  // Insertions share no character interval. A common insertion boundary is
  // still ambiguous, as is an insertion inside an ancestor replacement.
  const li = left.from === left.to;
  const ri = right.from === right.to;
  if (li && ri) return left.from === right.from;
  if (li) return left.from >= right.from && left.from <= right.to;
  if (ri) return right.from >= left.from && right.from <= left.to;
  return left.from < right.to && right.from < left.to;
}

export function rebasePrejoinText(
  ancestor: string, local: string, remote: string
): PrejoinRebase {
  // Exact matching visible text is already on the server. Sending it again
  // under a fresh Yjs lineage could otherwise duplicate independent bytes.
  if (local === remote) return { kind: "merged", text: remote };
  if (local === ancestor) return { kind: "merged", text: remote };
  if (remote === ancestor) return { kind: "merged", text: local };
  const localEdits = textEdits(ancestor, local);
  const remoteEdits = textEdits(ancestor, remote);
  if (localEdits.some(left => remoteEdits.some(right => compete(left, right)))) {
    return { kind: "review" };
  }
  let text = remote;
  // Apply from right to left, translating each base-indexed local edit
  // through all remote edits strictly before its source boundary.
  for (const edit of localEdits.reverse()) {
    const shift = remoteEdits
      .filter(remoteEdit => remoteEdit.to < edit.from ||
        (remoteEdit.to === edit.from && remoteEdit.from !== remoteEdit.to))
      .reduce((value, change) => value + change.insert.length -
        (change.to - change.from), 0);
    const from = edit.from + shift;
    const to = edit.to + shift;
    if (from < 0 || to > text.length || from > to) return { kind: "review" };
    text = text.slice(0, from) + edit.insert + text.slice(to);
  }
  return { kind: "merged", text };
}

// Express only the new local difference on top of the server's Yjs text.
// Reconstructing the entire merged string as an unrelated Y.Doc would
// discard the remote operation IDs and duplicate previously committed text.
export function deltaForText(before: string, after: string): Array<{
  retain?: number; delete?: number; insert?: string;
}> {
  return diff(before, after).map(([kind, value]) => kind === diff.EQUAL
    ? { retain: value.length }
    : kind === diff.DELETE ? { delete: value.length } : { insert: value });
}
