import { describe, it, expect } from "vitest";
import { bindCollaborativeHistory } from "./collaboration-undo.js";

describe("collaborative editor history command routing", () => {
  it("retains Yjs Undo/Redo routing when Obsidian overwrites editor commands", () => {
    const calls = [];
    const editor = {
      undo() { calls.push("native-undo"); },
      redo() { calls.push("native-redo"); },
    };
    const originalUndo = editor.undo;
    const release = bindCollaborativeHistory(editor, {
      isActive: () => true,
      isLocked: () => false,
      undo: () => calls.push("yjs-undo"),
      redo: () => calls.push("yjs-redo"),
    });

    editor.undo = () => calls.push("new-native-undo");
    editor.redo = () => calls.push("new-native-redo");
    expect(editor.undo).not.toBe(originalUndo);
    editor.undo();
    editor.redo();
    expect(calls).toEqual(["yjs-undo", "yjs-redo"]);

    release();
    editor.undo();
    editor.redo();
    expect(calls).toEqual([
      "yjs-undo", "yjs-redo", "new-native-undo", "new-native-redo",
    ]);
  });

  it("restores prototype commands when no reassignment occurred", () => {
    class Editor {
      undo() { this.native++; }
      redo() { this.native++; }
    }

    const editor = new Editor();
    editor.native = 0;
    const release = bindCollaborativeHistory(editor, {
      isActive: () => true, isLocked: () => false,
      undo: () => {}, redo: () => {},
    });
    expect(Object.hasOwn(editor, "undo")).toBe(true);
    release();
    expect(Object.hasOwn(editor, "undo")).toBe(false);
    expect(Object.hasOwn(editor, "redo")).toBe(false);
    editor.undo();
    expect(editor.native).toBe(1);
  });

  it("routes native commands only while the editor is not collaborative", () => {
    const calls = [];
    let active = false;
    const editor = { undo: () => calls.push("native") };
    const release = bindCollaborativeHistory(editor, {
      isActive: () => active, isLocked: () => false,
      undo: () => calls.push("crdt"), redo: () => {},
    });
    editor.undo();
    active = true;
    editor.undo();
    expect(calls).toEqual(["native", "crdt"]);
    release();
  });

  it("blocks both histories if an old note generation is locked for recovery", () => {
    const calls = [];
    const editor = { undo: () => calls.push("native"), redo: () => calls.push("native") };
    const release = bindCollaborativeHistory(editor, {
      isActive: () => true, isLocked: () => true,
      undo: () => calls.push("crdt"), redo: () => calls.push("crdt"),
    });
    editor.undo();
    editor.redo();
    expect(calls).toEqual([]);
    release();
  });
});
