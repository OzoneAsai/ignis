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

  const read = tab => cdp.evaluate(tab,
    "window.app.workspace.activeLeaf?.view?.editor?.getValue() || ''");
  const status = tab => cdp.evaluate(tab,
    "document.querySelector('.ignis-collaboration-status')?.textContent || ''");
  await poll(async () => (await status(a)).includes('online') &&
    (await status(b)).includes('online'), 20000);
  console.log('IME_BROWSER_BOOT',await status(a),await status(b));

  const runMarker=Date.now().toString(36);
  const provisional='未確定にほんご-'+runMarker;
  await cdp.activate(a);
  await cdp.evaluate(a, `(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    editor.cm.focus();editor.setCursor({line:0,ch:3});
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
    return true;
  })()`);
  await new Promise(resolve=>setTimeout(resolve,180));
  await cdp.activate(b);
  await cdp.evaluate(b, `(() => {
    window.__imeCursorFrames=[];
    const original=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data){
      try{const frame=JSON.parse(data);
        if(frame.channel==='collab' && ['cursor','cursor-away'].includes(frame.type)){
          window.__imeCursorFrames.push({type:frame.type,path:frame.path});
        }
      }catch{}
      return original.apply(this,arguments);
    };
    const editor=window.app.workspace.activeLeaf.view.editor;
    editor.cm.focus();
    editor.setCursor(editor.offsetToPos(editor.getValue().length));
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',bubbles:true}));
    return true;
  })()`);
  await new Promise(resolve=>setTimeout(resolve,220));
  console.log('IME_BEFORE_START_AWARENESS',JSON.stringify(await cdp.evaluate(b,
    `(() => ({carets:document.querySelectorAll('.ignis-collab-remote-caret').length,
       roster:document.querySelectorAll('.ignis-collab-people-jump').length}))()`)));
  await cdp.evaluate(b, `(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    editor.cm.focus();
    editor.setCursor(editor.offsetToPos(editor.getValue().length));
    editor.cm.dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    editor.replaceRange(${JSON.stringify(provisional)},editor.offsetToPos(editor.getValue().length));
    return {started:true,value:editor.getValue()};
  })()`);
  await poll(async()=> (await read(a)).includes(provisional),15000);
  console.log('IME_PROVISIONAL_VISIBLE_ON_PEER=PASS');

  // The composing participant must retain a remote identity/caret. Browser
  // IME focus should not broadcast cursor-away to the other participant.
  const before=await cdp.evaluate(b, `(() => {
    const caret=[...document.querySelectorAll('.ignis-collab-remote-caret')];
    return {count:caret.length,
      labels:caret.map(x=>x.querySelector('.ignis-collab-remote-label')?.textContent)};
  })()`);
  console.log('IME_CURSOR_AT_COMPOSITIONSTART',JSON.stringify(before));
  console.log('IME_WIRE_FRAMES',JSON.stringify(await cdp.evaluate(b, 'window.__imeCursorFrames')));
  if(before.count<1)throw Error('Focused composing tab cannot display stationary peer caret');

  const peerEdit='[REMOTE-DISJOINT-IME]';
  await cdp.evaluate(a,`(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(peerEdit+'\n')},{line:0,ch:0});return true;
  })()`);
  await poll(async()=>{
    const value=await read(b);
    return value.includes(provisional)&&value.includes(peerEdit);
  },15000);
  const during=await cdp.evaluate(b,`(() => ({
    text:window.app.workspace.activeLeaf.view.editor.getValue(),
    composing:!!window.app.workspace.activeLeaf.view.editor.cm.composing,
  }))()`);
  console.log('REMOTE_APPLIED_TO_COMPOSING_BROWSER_BEFORE_COMMIT=PASS',JSON.stringify({composing:during.composing,textLength:during.text.length}));

  const converted='未確定日本語-'+runMarker;
  await cdp.evaluate(b, `(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    const s=editor.getValue();const at=s.lastIndexOf(${JSON.stringify(provisional)});
    if(at<0)throw Error('Candidate disappeared');
    editor.replaceRange(${JSON.stringify(converted)},editor.offsetToPos(at),
      editor.offsetToPos(at+${provisional.length}));
    return true;
  })()`);
  await poll(async()=> (await read(a)).includes(converted),15000);
  await cdp.evaluate(b,`(() => {
    window.app.workspace.activeLeaf.view.editor.cm.dom.dispatchEvent(
      new CompositionEvent('compositionend',{bubbles:true}));return true;
  })()`);
  await poll(async()=>{
    const [aText,bText]=await Promise.all([read(a),read(b)]);
    return aText===bText && aText.includes(peerEdit) &&
      aText.includes(converted) && !aText.includes(provisional);
  },20000);
  console.log('IME_CONFIRM_CONVERGENCE=PASS');

  // A remote stationary caret must remain at the original line end when the
  // other participant inserts a newline at that exact position. Absolute
  // index changes for own edits are allowed; peer cursor affinity is not.
  await cdp.evaluate(b,`(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    const first=editor.getLine(0);editor.cm.focus();
    editor.setCursor({line:0,ch:first.length});
    editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
    return true;
  })()`);
  await new Promise(resolve=>setTimeout(resolve,170));
  const peerCaretBefore=await cdp.evaluate(a,`(() => {
    const el=document.querySelector('.ignis-collab-remote-caret');
    return el ? {top:parseFloat(el.style.top||'0'),display:el.style.display,
      label:el.querySelector('.ignis-collab-remote-label')?.textContent} : null;
  })()`);
  const linesBefore=await cdp.evaluate(a,
    "window.app.workspace.activeLeaf.view.editor.cm.state.doc.lines");
  await cdp.evaluate(a,`(() => {
    const editor=window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange('\\n',{line:0,ch:editor.getLine(0).length});return true;
  })()`);
  await poll(async()=> (await read(a))===(await read(b)),15000);
  const linesAfter=await cdp.evaluate(a,
    "window.app.workspace.activeLeaf.view.editor.cm.state.doc.lines");
  const peerCaretAfter=await cdp.evaluate(a,`(() => {
    const el=document.querySelector('.ignis-collab-remote-caret');
    return el ? {top:parseFloat(el.style.top||'0'),display:el.style.display,
      label:el.querySelector('.ignis-collab-remote-label')?.textContent} : null;
  })()`);
  console.log('REMOTE_NEWLINE_CURSOR_GEOMETRY',JSON.stringify({before:peerCaretBefore,after:peerCaretAfter}));
  if (!peerCaretBefore || !peerCaretAfter ||
      peerCaretBefore.label!==peerCaretAfter.label ||
      Math.abs(peerCaretBefore.top-peerCaretAfter.top)>1 ||
      linesAfter<=linesBefore) {
    throw Error('Stationary remote caret followed another editor newline: '+
      JSON.stringify({peerCaretBefore,peerCaretAfter,linesBefore,linesAfter}));
  }
  console.log('STATIONARY_REMOTE_CURSOR_AT_NEWLINE=PASS');
  console.log('IME_FIRST_BROWSER_E2E=PASS');
  cdp.ws.close();
} finally {
  thirdPeer?.close();
  if (cdp?.ws.readyState === WebSocket.OPEN) cdp.ws.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,500));
  await fs.rm(temp,{recursive:true,force:true});
}
