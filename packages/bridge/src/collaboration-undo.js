// Obsidian may recreate Markdown editor commands when a view is initialized,
// focused or reconfigured. Assigning `editor.undo = ...` once is therefore not
// sufficient: a later native Undo assignment silently restores CodeMirror's
// private history and can turn its rollback into a NEW local CRDT deletion.
//
// Keep one stable command entry point for the lifetime of each collaborative
// editor binding. Native command replacements remain available for teardown,
// but cannot bypass the Yjs UndoManager while the note is collaborative.
export function bindCollaborativeHistory(editor, { isActive, isLocked, undo, redo }) {
  const detach = [];

  for (const command of ["undo", "redo"]) {
    const prior = Object.getOwnPropertyDescriptor(editor, command);

    if (prior && !prior.configurable) {
      throw new Error(`Cannot safely bind collaborative ${command} command`);
    }

    let nativeCommand = editor[command];
    let replaced = false;
    const collaborativeCommand = command === "undo" ? undo : redo;
    const routed = (...args) => {
      if (isLocked()) {
        // The old generation is in recovery mode: neither history may mutate.
        return;
      }

      if (isActive()) {
        return collaborativeCommand();
      }

      return nativeCommand.apply(editor, args);
    };

    Object.defineProperty(editor, command, {
      configurable: true,
      enumerable: prior?.enumerable ?? false,
      get: () => routed,
      set(value) {
        // A native implementation reinstalled by Obsidian is remembered for
        // teardown, but never becomes the active collaborative command.
        if (typeof value === "function" && value !== routed) {
          nativeCommand = value;
          replaced = true;
        }
      },
    });

    detach.push(() => {
      if (prior) {
        Object.defineProperty(editor, command,
          replaced && "value" in prior ? { ...prior, value: nativeCommand } : prior);
      } else {
        delete editor[command];

        if (replaced) {
          editor[command] = nativeCommand;
        }
      }
    });
  }

  return () => {
    for (const release of detach.reverse()) {
      release();
    }
  };
}
