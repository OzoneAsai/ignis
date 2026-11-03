// Two-browser Yjs Undo/Redo regression: native command reinstallation and remote inserts.
// Usage: BASE_URL=http://127.0.0.1:3191 node scripts/collab-browser-e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const base = process.env.BASE_URL || "http://127.0.0.1:3191";
const chromePath = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const vaultId = process.env.COLLAB_TEST_VAULT || "Collab Lab";
const notePath = process.env.COLLAB_TEST_NOTE || "Browser CRDT Test.md";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-browser-e2e-"));
const chromeProfile = path.join(temp, "chrome");

async function poll(test, ms = 30000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    try {
      const result = await test();

      if (result) {
        return result;
      }
    } catch {
      // An uninitialized page cannot be evaluated yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Browser readiness or collaboration timed out");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.targets = new Map();
    ws.on("message", (buffer) => {
      const msg = JSON.parse(buffer.toString());
      const pending = this.pending.get(msg.id);

      if (!pending) {
        return;
      }

      this.pending.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result || {});
      }
    });
  }

  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(sessionId, expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ": " +
        (result.exceptionDetails.exception?.description || ""));
    }

    return result.result?.value;
  }

  async newTab(url) {
    const { targetId } = await this.command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.command("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await this.command("Page.enable", {}, sessionId);
    await this.command("Runtime.enable", {}, sessionId);
    await this.command("Page.navigate", { url }, sessionId);
    this.targets.set(sessionId, targetId);
    return sessionId;
  }

  async activate(tab) {
    await this.command("Target.activateTarget", { targetId: this.targets.get(tab) });
  }
}

const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--remote-debugging-port=0",
  `--user-data-dir=${chromeProfile}`,
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });

let cdp;

try {
  const debug = await poll(async () => {
    const info = await fs.readFile(path.join(chromeProfile, "DevToolsActivePort"), "utf-8");
    const [port, route] = info.trim().split("\n");
    return `ws://127.0.0.1:${port}${route}`;
  }, 15000);
  const socket = new WebSocket(debug);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cdp = new CDP(socket);

  const url = base + "/?vault=" + encodeURIComponent(vaultId);
  const a = await cdp.newTab(url);
  const b = await cdp.newTab(url);

  for (const tab of [a, b]) {
    await poll(() => cdp.evaluate(tab,
      "Boolean(window.app?.workspace?.getLeaf && window.app?.vault?.getAbstractFileByPath)"),
    50000);

    await poll(() => cdp.evaluate(tab,
      `Boolean(window.app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}))`),
    40000);

    const opened = await poll(() => cdp.evaluate(tab, `(async () => {
      const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
      if (!file) throw new Error("Browser test note is missing");
      await window.app.workspace.getLeaf(false).openFile(file);
      return Boolean(window.app.workspace.activeLeaf?.view?.editor);
    })()`), 30000);

    if (!opened) {
      throw new Error("Obsidian Markdown editor was not opened");
    }
  }

  const read = (tab) => cdp.evaluate(tab,
    "window.app.workspace.activeLeaf?.view?.editor?.getValue() || ''");
  const status = (tab) => cdp.evaluate(tab,
    "document.querySelector('.ignis-collaboration-status')?.textContent || ''");

  await poll(async () => (await status(a)).includes("online") &&
    (await status(b)).includes("online"), 15000);
  console.log("Both Markdown editors joined:", await status(a), await status(b));

  // Dedicated 2-tab stress: each browser owns a different Y.Doc client ID.
  // The same-origin BroadcastChannel, WebSocket relay, native editor lifecycle,
  // Yjs UndoManager and CM6 commands remain active throughout all iterations.
  const iterations = Number(process.env.COLLAB_UNDO_ROUNDS || 16);
  const scriptID = `${process.pid}-${Date.now()}`;
  const routed = await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    const undo = Object.getOwnPropertyDescriptor(editor, 'undo');
    const redo = Object.getOwnPropertyDescriptor(editor, 'redo');
    return {
      guarded: Boolean(undo?.get && undo?.set && redo?.get && redo?.set),
      undoOwn: Boolean(undo),
      redoOwn: Boolean(redo),
      undoString: String(editor.undo).slice(0, 160),
      redoString: String(editor.redo).slice(0, 160),
      traces: window.__ignis.collaboration?.debug?.(),
      leafPaths: window.app.workspace.getLeavesOfType('markdown')
        .map(l => l.view.file?.path),
      active: window.app.workspace.activeLeaf?.view?.file?.path,
    };
  })()`);

  if (!routed.guarded) {
    throw new Error('Yjs Undo/Redo routing must survive native method reinitialization: ' +
      JSON.stringify(routed));
  }

  async function add(tab, value, front) {
    return cdp.evaluate(tab, `(() => {
      const editor = window.app.workspace.activeLeaf.view.editor;
      editor.replaceRange(${JSON.stringify(value)}, ${front
        ? '{line:0,ch:0}' : 'editor.offsetToPos(editor.getValue().length)'});
      return true;
    })()`);
  }

  async function settle(condition, label, duration = 15000) {
    try {
      return await poll(condition, duration);
    } catch {
      const [left, right] = await Promise.all([read(a), read(b)]);
      const trace = await cdp.evaluate(b,
        'window.__ignis.collaboration?.debug?.() || null').catch(() => null);
      throw new Error(`${label}: left=${JSON.stringify(left.slice(0, 120))}, ` +
        `right=${JSON.stringify(right.slice(0, 120))}, trace=${JSON.stringify(trace)}`);
    }
  }

  for (let i = 0; i < iterations; i++) {
    const own = `[OWN-${scriptID}-${i}]`;
    const peer = `[PEER-${scriptID}-${i}]`;
    await cdp.evaluate(b, `(() => {
      const editor = window.app.workspace.activeLeaf.view.editor;
      // Simulate the native Obsidian editor overwriting its undo/redo methods.
      editor.undo = () => { window.__nativeUndoLeak = (window.__nativeUndoLeak || 0) + 1; };
      editor.redo = () => { window.__nativeRedoLeak = (window.__nativeRedoLeak || 0) + 1; };
      return true;
    })()`);

    // Alternate temporal order and true concurrency. A remote insert must
    // remain untouched regardless of whether it arrives before or after our
    // local transaction within the same UndoManager capture interval.
    if (i % 3 === 0) {
      await Promise.all([add(a, peer, true), add(b, own, false)]);
    } else if (i % 3 === 1) {
      await add(b, own, false);
      await add(a, peer, true);
    } else {
      await add(a, peer, true);
      await add(b, own, false);
    }

    await settle(async () => {
      const [first, second] = await Promise.all([read(a), read(b)]);
      return first === second && first.includes(peer) && first.includes(own);
    }, `convergence before undo round ${i}`);

    const useShortcut = i % 4 === 0;
    if (useShortcut) {
      await cdp.evaluate(b, `(() => {
        const target = window.app.workspace.activeLeaf.view.editor.cm.contentDOM;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'z', metaKey: true, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);
    } else {
      await cdp.evaluate(b, 'window.app.workspace.activeLeaf.view.editor.undo(); true');
    }
    await settle(async () => {
      const [first, second] = await Promise.all([read(a), read(b)]);
      return first === second && first.includes(peer) && !first.includes(own);
    }, `foreign edit removed by local undo round ${i}`);

    if (useShortcut) {
      await cdp.evaluate(b, `(() => {
        const target = window.app.workspace.activeLeaf.view.editor.cm.contentDOM;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);
    } else {
      await cdp.evaluate(b, 'window.app.workspace.activeLeaf.view.editor.redo(); true');
    }
    await settle(async () => {
      const [first, second] = await Promise.all([read(a), read(b)]);
      return first === second && first.includes(peer) && first.includes(own);
    }, `redo divergence round ${i}`);

    const nativeCalls = await cdp.evaluate(b,
      '({undo:window.__nativeUndoLeak||0,redo:window.__nativeRedoLeak||0})');
    if (nativeCalls.undo || nativeCalls.redo) {
      throw new Error(`Native CodeMirror history escaped guard: ${JSON.stringify(nativeCalls)}`);
    }

    if (i % 4 === 0) {
      console.log(`PASS: ${i + 1}/${iterations} native-method replacements and foreign-edit Undo/Redo`);
    }

    await new Promise((resolve) => setTimeout(resolve, 530));
  }

  console.log(`PASS: ${iterations} repeated concurrent two-browser Undo/Redo cycles, no remote deletion`);

  // An Obsidian leaf sometimes reuses the same editor object across note
  // switches. The old room's cleanup must not replace the new room's guards.
  const alternate = "Undo Guard Alternate Note.md";
  await cdp.evaluate(b, `(async () => {
    const leaf = window.app.workspace.activeLeaf;
    const note = window.app.vault.getAbstractFileByPath(${JSON.stringify(alternate)}) ||
      await window.app.vault.create(${JSON.stringify(alternate)}, '# Alternate note\\n');
    await leaf.openFile(note);
    return true;
  })()`);
  await settle(() => cdp.evaluate(b, `(() => {
    const leaf = window.app.workspace.activeLeaf;
    const descriptor = Object.getOwnPropertyDescriptor(leaf?.view?.editor, 'undo');
    return leaf?.view?.file?.path === ${JSON.stringify(alternate)} &&
      descriptor?.get && document.querySelector('.ignis-collaboration-status')
        ?.textContent.includes('online');
  })()`), "alternate note did not acquire Yjs Undo command");

  await cdp.evaluate(b, `(async () => {
    const leaf = window.app.workspace.activeLeaf;
    await leaf.openFile(window.app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}));
    return true;
  })()`);
  await settle(() => cdp.evaluate(b, `(() => {
    const leaf = window.app.workspace.activeLeaf;
    const descriptor = Object.getOwnPropertyDescriptor(leaf?.view?.editor, 'undo');
    return leaf?.view?.file?.path === ${JSON.stringify(notePath)} &&
      descriptor?.get && document.querySelector('.ignis-collaboration-status')
        ?.textContent.includes('online');
  })()`), "restored note lost the Yjs history guard");

  const finalOwn = `[AFTER-SWITCH-OWN-${scriptID}]`;
  const finalRemote = `[AFTER-SWITCH-REMOTE-${scriptID}]`;
  await add(b, finalOwn, false);
  await add(a, finalRemote, true);
  await settle(async () => {
    const [first, second] = await Promise.all([read(a), read(b)]);
    return first === second && first.includes(finalOwn) && first.includes(finalRemote);
  }, "convergence after note switching");
  await cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.undo(); true");
  await settle(async () => {
    const [first, second] = await Promise.all([read(a), read(b)]);
    return first === second && !first.includes(finalOwn) && first.includes(finalRemote);
  }, "foreign edit removed after switching notes");
  console.log("PASS: switching Markdown notes preserves the active room's Undo ownership");
  socket.close();
} finally {
  if (cdp?.ws.readyState === WebSocket.OPEN) {
    cdp.ws.close();
  }

  chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(temp, { recursive: true, force: true });
}
