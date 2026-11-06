import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { cursorHighlightTint } from
  "../../../packages/bridge/src/cursor-label-layout.js";

// A remote selection belongs to document text, not to an approximate screen
// rectangle. CodeMirror splits mark decorations along wrapped lines and syntax
// spans, including bidirectional text and inline widgets.
export type RemoteMark = {
  from: number;
  to: number;
  color: string;
};

export const MAX_REMOTE_MARKS = 480;

export const replaceRemoteMarks = StateEffect.define<readonly RemoteMark[]>();

export function makeMarkDecorations(
  marks: readonly RemoteMark[], length: number
): DecorationSet {
  const ranges = [];
  for (const { from, to, color } of marks.slice(0, MAX_REMOTE_MARKS)) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
    const start = Math.max(0, Math.min(length, from));
    const end = Math.max(0, Math.min(length, to));
    if (start >= end) continue;
    ranges.push(Decoration.mark({
      class: "ignis-native-remote-highlight",
      attributes: { style: `background-color: ${cursorHighlightTint(color)};` },
      inclusive: false
    }).range(start, end));
  }
  // Decoration.set sorts logical ranges, not pixel coordinates. It handles
  // overlapping selections and CM6's internal syntax highlighting correctly.
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

export const remoteSelectionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(replaceRemoteMarks)) {
        next = makeMarkDecorations(effect.value, transaction.state.doc.length);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export const remoteSelectionExtension: Extension = remoteSelectionField;
