// Integration exercise of two actual Obsidian browser editors via Chrome DevTools.
// Usage: BASE_URL=http://127.0.0.1:3191 node scripts/collab-browser-e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const Y = require("yjs");
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
let thirdPeer = null;

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

  async function checkBadgeGeometry(tab) {
    return cdp.evaluate(tab, `(() => {
      const cm = window.app.workspace.activeLeaf.view.editor.cm;
      const labels = [...document.querySelectorAll('.ignis-collab-remote-label')]
        .filter(label => {
          const style = getComputedStyle(label);
          return style.display !== 'none' && style.visibility === 'visible' &&
            getComputedStyle(label.parentElement).display !== 'none';
        });
      const glyphs = [];
      const range = document.createRange();
      const walker = document.createTreeWalker(cm.contentDOM, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        range.selectNodeContents(textNode);
        glyphs.push(...range.getClientRects());
      }
      const intersects = (a, b) => a.left < b.right && a.right > b.left &&
        a.top < b.bottom && a.bottom > b.top;
      const badgeRects = labels.map(label => label.getBoundingClientRect());
      const viewport = cm.scrollDOM.getBoundingClientRect();
      return {
        visible: labels.length,
        textOverlaps: badgeRects.flatMap((a, index) =>
          glyphs.filter(b => b.width && b.height && intersects(a, b))
            .map(() => index)).length,
        badgeOverlaps: badgeRects.flatMap((a, index) =>
          badgeRects.slice(index + 1).filter(b => intersects(a, b))).length,
        clipped: badgeRects.filter(rect => rect.left < viewport.left - 1 ||
          rect.right > viewport.right + 1 || rect.top < viewport.top - 1 ||
          rect.bottom > viewport.bottom + 1).length
      };
    })()`);
  }

  await poll(async () => (await status(a)).includes("online") &&
    (await status(b)).includes("online"), 15000);
  console.log("Both Markdown editors joined:", await status(a), await status(b));

  async function setName(tab, name) {
    return cdp.evaluate(tab, `(() => {
      const status = document.querySelector('.ignis-collaboration-status');
      status?.click();
      const input = document.querySelector('.modal-container .ignis-collab-person')?.closest('.modal')?.querySelector('form input') || document.querySelector('.modal-container form input');
      if (!input) return false;
      input.value = ${JSON.stringify(name)};
      input.closest('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      return true;
    })()`);
  }

  if (!await setName(a, "Alice") || !await setName(b, "Bob")) {
    throw new Error("Unable to set participant display names");
  }

  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.setSelection({line: 0, ch: 1}, {line: 0, ch: 5});
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup', {key:'Shift', bubbles:true}));
    return true;
  })()`);

  const awareness = await poll(async () => cdp.evaluate(b, `(() => {
    const caret = document.querySelector('.ignis-collab-remote-caret');
    const label = caret?.querySelector('.ignis-collab-remote-label')?.textContent;
    const selected = document.querySelectorAll('.ignis-collab-remote-selection').length;
    const color = caret ? getComputedStyle(caret).borderLeftColor : null;
    return label === 'Alice' && selected > 0 && color ? {label, selected, color} : null;
  })()`), 18000);

  console.log("PASS: distinct remote identity, caret, and text selection:", JSON.stringify(awareness));

  // The blank line allows a real badge to appear without hiding glyphs.
  // Inspect Chrome's actual Range rectangles rather than trusting CSS offsets
  // or simulated unit-test coordinates. Repeat at 150% zoom.
  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.setCursor({ line: 1, ch: 0 });
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    return true;
  })()`);
  const badges = await poll(async () => {
    const result = await checkBadgeGeometry(b);
    return result.visible ? result : null;
  }, 12000);
  if (badges.textOverlaps || badges.badgeOverlaps || badges.clipped) {
    throw new Error("Badge covers text or leaves viewport: " + JSON.stringify(badges));
  }
  await cdp.evaluate(b, "document.documentElement.style.zoom = '150%'; true");
  const zoomed = await poll(async () => {
    const result = await checkBadgeGeometry(b);
    return result.visible && !result.textOverlaps &&
      !result.badgeOverlaps && !result.clipped ? result : null;
  }, 12000);
  await cdp.evaluate(b, "document.documentElement.style.zoom = ''; true");
  console.log("PASS: measured labels avoid text at 100% and 150% zoom:",
    JSON.stringify({ badges, zoomed }));

  // Zooming the document and transforming an editor are different coordinate
  // systems. Regress both: overlay CSS pixels must match the actual glyph
  // geometry after a transformed editor is remeasured.
  for (const transform of ["scale(0.75)", "scale(1.25)"]) {
    await cdp.evaluate(b, `(async () => {
      const cm = window.app.workspace.activeLeaf.view.editor.cm;
      cm.dom.style.transformOrigin = 'top left';
      cm.dom.style.transform = ${JSON.stringify(transform)};
      cm.scrollDOM.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)));
      return true;
    })()`);
    const measured = await checkBadgeGeometry(b);
    if (!measured.visible || measured.textOverlaps ||
        measured.badgeOverlaps || measured.clipped) {
      throw new Error("Transformed editor collision: " +
        JSON.stringify({ transform, measured }));
    }
    await cdp.evaluate(b, `(async () => {
      const cm = window.app.workspace.activeLeaf.view.editor.cm;
      cm.dom.style.transform = '';
      cm.dom.style.transformOrigin = '';
      cm.scrollDOM.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      return true;
    })()`);
  }
  console.log("PASS: CSS transformed editor coordinates avoid text at 75% and 125%");

  // A single logical selection may span multiple visual rows when the text
  // wraps. Highlight the selected glyph fragments, never a tall rectangle
  // from the first line's caret to the last line's caret.
  const wrapText = "Wrap check: " +
    "日本語 mixed-direction ABC arabic مرحبا and long text ".repeat(8);
  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(wrapText + "\n")}, {line: 2, ch: 0});
    return true;
  })()`);
  await poll(async () => (await read(b)).includes(wrapText), 15000);
  await cdp.evaluate(b, `(() => {
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    cm.dom.style.width = '260px';
    for (const line of cm.contentDOM.querySelectorAll('.cm-line')) {
      line.style.whiteSpace = 'pre-wrap';
      line.style.overflowWrap = 'anywhere';
    }
    return true;
  })()`);
  // Verify our actual bundled browser adapter against Chrome glyph geometry.
  // Transport/presence are checked separately above and in the third-peer test.
  const glyphSource = path.join(path.dirname(fileURLToPath(import.meta.url)),
    '../packages/bridge/src/selection-glyphs.js');
  const glyphBundle = await esbuild.build({
    entryPoints:[glyphSource], bundle:true, write:false,
    platform:'browser',format:'iife',globalName:'__ignisGlyphTest'
  });
  await cdp.evaluate(b, glyphBundle.outputFiles[0].text + ';true');
  const glyphHighlights = await cdp.evaluate(b, `(() => {
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    const start = cm.state.doc.line(3).from + 2;
    const end = start + 143;
    const a = cm.domAtPos(start), b = cm.domAtPos(end);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const expected = [...range.getClientRects()].filter(r=>r.width>.25&&r.height>.5);
    const space = {toLocal:r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom})};
    const {rects,limited} = __ignisGlyphTest.visibleSelectionGlyphRects(
      cm,space,start,end,480);
    // A text node split by syntax/bidi markup may subdivide one DOM Range
    // rect into multiple exact glyph fragments. Compare their union, not
    // their fragment counts or one-to-one rectangle identities.
    const union = (parts) => {
      const rows = new Map();
      for (const r of parts) {
        const key = Math.round(r.top / 3);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push([r.left, r.left+r.width]);
      }
      return [...rows.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([key,spans]) => {
        spans.sort((a,b)=>a[0]-b[0]);
        const merged = [];
        for (const span of spans) {
          const last = merged.at(-1);
          if (last && span[0]<=last[1]+0.5) last[1]=Math.max(last[1],span[1]);
          else merged.push([...span]);
        }
        return merged.map(([from,to])=>[key,from,to]);
      });
    };
    const actualUnion = union(rects);
    const expectedUnion = union(expected);
    const same = actualUnion.length===expectedUnion.length &&
      actualUnion.every((item,i)=>item.every((v,k)=>
        Math.abs(v-expectedUnion[i][k])<2));
    return {
      ok: !limited && rects.length>=2 &&
        new Set(rects.map(r=>Math.round(r.top/5))).size>=2 && same,
      expected:expected.length, actual:rects.length,
      rows:new Set(rects.map(r=>Math.round(r.top/5))).size,
      samples:rects.slice(0,4), actualUnion, expectedUnion
    };
  })()`);
  if (!glyphHighlights.ok) throw new Error(
    'Wrapped multilingual glyph geometry mismatch: '+JSON.stringify(glyphHighlights));
  await cdp.evaluate(b, `(() => {
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    cm.dom.style.width = '';
    for (const line of cm.contentDOM.querySelectorAll('.cm-line')) {
      line.style.whiteSpace = '';
      line.style.overflowWrap = '';
    }
    return true;
  })()`);
  console.log("PASS: WebUI computes exact wrapped multilingual glyph fragments:",
    JSON.stringify({fragments:glyphHighlights.actual,rows:glyphHighlights.rows}));

  // A third online collaborator publishes three independent Yjs-relative
  // selections. WebUI must draw all three, keep the other editor in its
  // roster even when the cursor goes away, and clear nodes on departure.
  thirdPeer = new WebSocket(base.replace(/^http/, "ws") +
    "/ws?vault=" + encodeURIComponent(vaultId));
  await new Promise((resolve, reject) => {
    thirdPeer.once("open", resolve);
    thirdPeer.once("error", reject);
  });
  const thirdInit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Third participant did not join")), 10000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.channel === "collab" && message.type === "init" &&
          message.path === notePath) {
        clearTimeout(timer);
        thirdPeer.off("message", listener);
        resolve(message);
      }
    };
    thirdPeer.on("message", listener);
  });
  thirdPeer.send(JSON.stringify({
    channel: "collab", type: "join", path: notePath, name: "Third Editor"
  }));
  const info = await thirdInit;
  const thirdDoc = new Y.Doc();
  Y.applyUpdate(thirdDoc, Buffer.from(info.state, "base64"));
  const text = thirdDoc.getText("content");
  const at = (position) => Buffer.from(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(text, Math.min(position, text.length))
  )).toString("base64");
  const selections = [
    { anchor: at(1), head: at(3) },
    { anchor: at(Math.max(0, text.length - 70)),
      head: at(Math.max(0, text.length - 40)) },
    { anchor: at(9), head: at(9) }
  ];
  thirdPeer.send(JSON.stringify({
    channel: "collab", type: "cursor", path: notePath,
    documentId: info.documentId, mainIndex: 1, selections,
    ...selections[1]
  }));
  await poll(() => cdp.evaluate(b, `(() => {
    const id = ${JSON.stringify(info.self.id)};
    const carets = [...document.querySelectorAll('.ignis-collab-remote-caret')]
      .filter(element => element.dataset.collabPeer === id);
    const roster = [...document.querySelectorAll('.ignis-collab-people-jump')]
      .find(element => element.dataset.collabPeer === id);
    if (carets.length !== 3 || !roster) return false;
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    const before = cm.state.selection.main.head;
    window.__ignisCursorJumpScrollBefore = cm.scrollDOM.scrollTop;
    roster.click();
    return cm.state.selection.main.head === before;
  })()`), 15000);
  await poll(() => cdp.evaluate(b, `(() => {
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    return cm.scrollDOM.scrollTop >
      (window.__ignisCursorJumpScrollBefore || 0) + 150;
  })()`), 12000);
  console.log("PASS: three independent cursors and navigable third participant in real Chrome");
  thirdPeer.send(JSON.stringify({
    channel: "collab", type: "cursor-away", path: notePath,
    documentId: info.documentId
  }));
  await poll(() => cdp.evaluate(b, `(() => {
    const id = ${JSON.stringify(info.self.id)};
    return ![...document.querySelectorAll('.ignis-collab-remote-caret')]
      .some(element => element.dataset.collabPeer === id) &&
      [...document.querySelectorAll('.ignis-collab-people-jump')]
        .some(element => element.dataset.collabPeer === id);
  })()`), 15000);
  thirdPeer.close();
  thirdPeer = null;
  thirdDoc.destroy();
  console.log("PASS: cursor-away removes all remote caret nodes while presence remains");

  await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.setSelection({line: 0, ch: 2}, {line: 0, ch: 7});
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup', {key:'Shift', bubbles:true}));
    return true;
  })()`);
  await cdp.activate(a);

  await poll(async () => cdp.evaluate(a, `(() => {
    return document.querySelector('.ignis-collab-remote-label')?.textContent === 'Bob';
  })()`), 15000);
  console.log("PASS: both participants have visible remote cursors");

  const editorState = await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    const cm = editor.cm;
    cm.contentDOM.__ignisStableEditor = 'same-element';
    cm.scrollDOM.scrollTop = 450;
    return {
      anchor: cm.state.selection.main.anchor,
      head: cm.state.selection.main.head,
      selected: editor.getSelection(),
      scrollTop: cm.scrollDOM.scrollTop,
    };
  })()`);

  await cdp.evaluate(a, "window.app.workspace.activeLeaf.view.editor.replaceRange('~', {line:0,ch:0}); true");
  await poll(async () => cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    const cm = editor.cm;
    return cm.contentDOM.__ignisStableEditor === 'same-element' &&
      editor.getValue().startsWith('~') &&
      cm.state.selection.main.anchor === ${editorState.anchor + 1} &&
      cm.state.selection.main.head === ${editorState.head + 1} &&
      editor.getSelection() === ${JSON.stringify(editorState.selected)} &&
      ((${editorState.scrollTop} < 100) ||
        Math.abs(cm.scrollDOM.scrollTop - ${editorState.scrollTop}) < 70);
  })()`), 15000);
  console.log("PASS: remote edits preserve CodeMirror DOM, mapped selection and scroll state");

  // A displayed nickname is not a unique identity. Even when both participants
  // choose the same nickname, the overlay must disambiguate them.
  if (!await setName(b, "Alice")) {
    throw new Error("Unable to set duplicate display name");
  }


  await poll(async () => cdp.evaluate(a, `(() => {
    const label = document.querySelector('.ignis-collab-remote-label')?.textContent || '';
    return label.startsWith('Alice ·') && label.length > 'Alice ·'.length;
  })()`), 10000);
  console.log("PASS: duplicate display names receive unique ID suffixes");

  if (!await setName(b, "Bob")) {
    throw new Error("Unable to restore participant name");
  }

  await Promise.all([
    cdp.evaluate(a, "window.app.workspace.activeLeaf.view.editor.replaceRange('Alice ', {line:0,ch:0}); true"),
    cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.replaceRange('Bob ', {line:0,ch:0}); true"),
  ]);

  const merged = await poll(async () => {
    const first = await read(a);
    const second = await read(b);
    return first === second && first.includes("Alice ") && first.includes("Bob ") && first;
  }, 20000);
  console.log("PASS: two real Obsidian editors converged:",
    JSON.stringify(merged.slice(0, 110)), `(${merged.length} characters)`);

  const markerId = `${process.pid}-${Date.now()}`;
  const localMarker = `[LOCAL-UNDO-${markerId}]`;
  const remoteMarker = `[REMOTE-KEEP-${markerId}]`;
  const beforeOwnEdit = await read(b);
  await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(localMarker)}, editor.offsetToPos(editor.getValue().length));
    return true;
  })()`);
  await poll(async () => (await read(a)).includes(localMarker), 15000);
  await cdp.evaluate(a, `window.app.workspace.activeLeaf.view.editor.replaceRange(${JSON.stringify(remoteMarker)}, {line:0,ch:0}); true`);
  await poll(async () => (await read(b)).includes(remoteMarker), 15000);
  const afterRemote = await read(b);
  // Obsidian re-installs its own CodeMirror Undo/Redo when editor views are
  // reconfigured. Even an explicit reassignment MUST NOT bypass Yjs routing.
  const guardedCommands = await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    const undoDescriptor = Object.getOwnPropertyDescriptor(editor, 'undo');
    const redoDescriptor = Object.getOwnPropertyDescriptor(editor, 'redo');
    if (!undoDescriptor?.get || !undoDescriptor?.set ||
        !redoDescriptor?.get || !redoDescriptor?.set) return false;
    editor.undo = () => { throw new Error('CodeMirror native Undo leaked'); };
    editor.redo = () => { throw new Error('CodeMirror native Redo leaked'); };
    return true;
  })()`);

  if (!guardedCommands) {
    throw new Error("Obsidian restored a native history command without a stable guard");
  }

  await cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.undo(); true");
  const afterUndo = await read(b);
  if (afterUndo.includes(localMarker) || !afterUndo.includes(remoteMarker)) {
    throw new Error("Undo affected another participant's change: " + JSON.stringify({
      before: beforeOwnEdit.slice(0, 60), afterRemote: afterRemote.slice(0, 90),
      afterUndo: afterUndo.slice(0, 90),
      remoteKeptByOtherBrowser: (await read(a)).includes(remoteMarker),
    }));
  }

  await cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.redo(); true");
  await poll(async () => {
    const value = await read(b);
    return value.includes(localMarker) && value.includes(remoteMarker);
  }, 10000);
  console.log("PASS: local Undo/Redo preserve the remote participant's edits");

  // A Japanese IME composition is a single author-intent boundary. Incoming
  // updates must not rewrite the composing editor or destroy either change.
  const composingText = `[IME-${markerId}]`;
  const concurrentText = `[DURING-IME-${markerId}]`;
  await cdp.evaluate(b, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.cm.dom.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
    editor.replaceRange(${JSON.stringify(composingText)},
      editor.offsetToPos(editor.getValue().length));
    return true;
  })()`);
  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(concurrentText)}, {line:0,ch:0});
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const composingView = await read(b);


  if (!composingView.includes(composingText) || composingView.includes(concurrentText)) {
    throw new Error("Incoming remote edit interfered with the active composition: " + JSON.stringify({
      localPresent: composingView.includes(composingText),
      remotePresent: composingView.includes(concurrentText),
      status: await status(b),
      active: await cdp.evaluate(b, `(() => ({
        leaves: window.app.workspace.getLeavesOfType('markdown').map(l => l.view.file?.path),
        focused: Boolean(window.app.workspace.activeLeaf?.view?.editor?.cm?.hasFocus),
      }))()`),
    }));
  }

  await cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.cm.dom.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true})); true");
  await poll(async () => {
    const [first, second] = await Promise.all([read(a), read(b)]);
    return first === second && first.includes(composingText) && first.includes(concurrentText);
  }, 15000);
  console.log("PASS: IME composition and simultaneous remote edit merge without interrupting input");

  // Two Obsidian panes in ONE browser share one Y.Doc for the same note.
  // They must not trigger a leave/join each time focus changes, nor create a
  // second independent selection history or replace each other's DOM.
  const split = await cdp.evaluate(b, `(async () => {
    const workspace = window.app.workspace;
    const original = workspace.activeLeaf;
    const note = original.view.file;
    const second = workspace.getLeaf('split');
    await second.openFile(note);
    window.__ignisCollabTestPanes = {original, second};
    return {
      leaves: workspace.getLeavesOfType('markdown').map(leaf => ({
        path: leaf.view.file?.path, identical: leaf === original,
      })),
      differentEditors: original.view.editor !== second.view.editor,
    };
  })()`);

  if (split.leaves.filter((leaf) => leaf.path === notePath).length < 2 ||
      !split.differentEditors) {
    throw new Error("Unable to open two independent Markdown panes: " + JSON.stringify(split));
  }

  const splitLeft = `[SPLIT-L-${markerId}]`;
  const splitRight = `[SPLIT-R-${markerId}]`;
  const splitFromPeer = `[SPLIT-REMOTE-${markerId}]`;
  await cdp.evaluate(b, `(() => {
    const panes = window.__ignisCollabTestPanes;
    panes.original.view.editor.cm.contentDOM.__sameSplitNode = 'left';
    panes.second.view.editor.cm.contentDOM.__sameSplitNode = 'right';
    panes.original.view.editor.replaceRange(${JSON.stringify(splitLeft)}, {line:0,ch:0});
    return true;
  })()`);
  await poll(async () => cdp.evaluate(b, `(() => {
    const {original,second} = window.__ignisCollabTestPanes;
    return original.view.editor.getValue().includes(${JSON.stringify(splitLeft)}) &&
      second.view.editor.getValue().includes(${JSON.stringify(splitLeft)});
  })()`), 15000);
  await cdp.evaluate(b, `(() => {
    const editor = window.__ignisCollabTestPanes.second.view.editor;
    editor.replaceRange(${JSON.stringify(splitRight)}, editor.offsetToPos(editor.getValue().length));
    return true;
  })()`);
  await poll(async () => cdp.evaluate(b, `(() => {
    const {original,second} = window.__ignisCollabTestPanes;
    return original.view.editor.getValue() === second.view.editor.getValue() &&
      original.view.editor.getValue().includes(${JSON.stringify(splitRight)});
  })()`), 15000);
  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(splitFromPeer)}, {line:0,ch:0});
    return true;
  })()`);
  await poll(async () => cdp.evaluate(b, `(() => {
    const {original,second} = window.__ignisCollabTestPanes;
    return [original,second].every(leaf => leaf.view.editor.getValue().includes(
      ${JSON.stringify(splitFromPeer)})) &&
      original.view.editor.cm.contentDOM.__sameSplitNode === 'left' &&
      second.view.editor.cm.contentDOM.__sameSplitNode === 'right';
  })()`), 15000);
  console.log("PASS: two independent panes share one CRDT, preserve both DOM nodes and receive peer edits");

  // Switching to a different note in one pane must not unsubscribe the other
  // pane from its still-open room. Both notes have independent state and ACKs.
  const otherNote = "Collab Multi Pane Secondary.md";
  await cdp.evaluate(b, `(async () => {
    const {second} = window.__ignisCollabTestPanes;
    const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(otherNote)}) ||
      await window.app.vault.create(${JSON.stringify(otherNote)}, '# Second room\\n');
    await second.openFile(file);
    window.app.workspace.setActiveLeaf(second);
    return true;
  })()`);
  await poll(async () => (await status(b)).includes("online"), 15000);
  const backgroundMarker = `[BACKGROUND-ROOM-${markerId}]`;
  await cdp.evaluate(a, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(backgroundMarker)}, {line:0,ch:0});
    return true;
  })()`);
  await poll(async () => cdp.evaluate(b, `(() => {
    const {original,second} = window.__ignisCollabTestPanes;
    return original.view.file.path === ${JSON.stringify(notePath)} &&
      second.view.file.path === ${JSON.stringify(otherNote)} &&
      original.view.editor.getValue().includes(${JSON.stringify(backgroundMarker)}) &&
      !second.view.editor.getValue().includes(${JSON.stringify(backgroundMarker)});
  })()`), 15000);
  console.log("PASS: background Markdown pane stays synchronized while another note is active");

  await cdp.command("Target.closeTarget", { targetId: cdp.targets.get(a) });
  await cdp.activate(b);
  await poll(async () => cdp.evaluate(b, `(() => {
    const status = document.querySelector('.ignis-collaboration-status')?.textContent || '';
    return status.includes('1 online') && document.querySelectorAll('.ignis-collab-remote-caret').length === 0;
  })()`), 15000);
  console.log("PASS: departed user's remote caret removed");
  socket.close();
} finally {
  thirdPeer?.close();
  if (cdp?.ws.readyState === WebSocket.OPEN) {
    cdp.ws.close();
  }

  chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(temp, { recursive: true, force: true });
}
