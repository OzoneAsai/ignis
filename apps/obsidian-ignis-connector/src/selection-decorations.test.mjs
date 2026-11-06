// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  remoteSelectionExtension, remoteSelectionField, replaceRemoteMarks,
  makeMarkDecorations, MAX_REMOTE_MARKS
} from "./selection-decorations.ts";

const source = "one two\n日本語 abc\nlast line";
function marks(decorations) {
  const result = [];
  decorations.between(0, 10000, (from, to, value) => {
    result.push({from, to, style: value.spec.attributes?.style});
  });
  return result;
}

describe("native CM6 glyph-accurate remote selection marks", () => {
  it("marks just selected characters, across lines and reversed/overlapping ranges", () => {
    const state = EditorState.create({
      doc: source,
      extensions: [remoteSelectionExtension]
    });
    const update = state.update({ effects: replaceRemoteMarks.of([
      { from: 10, to: 15, color: "#59baf2" }, // part of a Japanese line
      { from: 1, to: 3, color: "#ee6b72" },
      { from: 2, to: 6, color: "#33cc44" }
    ]) });
    const ranges = marks(update.state.field(remoteSelectionField));
    expect(ranges.map(({from, to}) => [from, to])
      .sort((a,b) => a[0]-b[0])).toEqual([
      [1, 3], [2, 6], [10, 15]
    ]);
    expect(ranges.every(r => r.style?.startsWith("background-color: rgba("))).toBe(true);
  });
  it("renders actual CodeMirror marked glyph spans, not rectangular overlay nodes", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = new EditorView({
      parent,
      state: EditorState.create({doc: source, extensions: [remoteSelectionExtension]})
    });
    try {
      editor.dispatch({effects: replaceRemoteMarks.of([
        {from: 9, to: 12, color: "#59baf2"}
      ])});
      const marked = [...parent.querySelectorAll(".ignis-native-remote-highlight")];
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.map(el => el.textContent).join("")).toBe(source.slice(9, 12));
      expect(parent.querySelectorAll(".ignis-native-remote-selection")).toHaveLength(0);
      expect(marked[0].style.backgroundColor).toMatch(/rgba?\(/);
      editor.dispatch({effects: replaceRemoteMarks.of([])});
      expect(parent.querySelector(".ignis-native-remote-highlight")).toBeNull();
    } finally {
      editor.destroy();
      parent.remove();
    }
  });
  it("maps existing decorations through document changes and clears on cursor-away", () => {
    let state = EditorState.create({ doc: source, extensions: [remoteSelectionExtension] });
    state = state.update({effects: replaceRemoteMarks.of([
      {from: 8, to: 11, color: "#59baf2"}
    ])}).state;
    state = state.update({changes: {from: 0, insert: "new "}}).state;
    expect(marks(state.field(remoteSelectionField)).map(x => [x.from,x.to]))
      .toEqual([[12,15]]);
    state = state.update({effects: replaceRemoteMarks.of([])}).state;
    expect(marks(state.field(remoteSelectionField))).toEqual([]);
  });
  it("ignores malformed ranges and bounds allocations for crowded editors", () => {
    const input = Array.from({ length: MAX_REMOTE_MARKS + 120 }, (_, i) => ({
      from: i, to: i + 1, color: "#59baf2"
    }));
    const result = makeMarkDecorations(input, 10000);
    expect(marks(result)).toHaveLength(MAX_REMOTE_MARKS);
    expect(marks(makeMarkDecorations([
      {from: -500, to: 999, color: "expression(alert(1))"},
      {from: 5, to: 5, color: "#59baf2"},
      {from: Number.NaN, to: 10, color: "#59baf2"}
    ], 12))).toEqual([{from: 0,to: 12,style: "background-color: rgba(89, 186, 242, 0.24);"}]);
  });
});
