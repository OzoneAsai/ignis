// Cross-device acceptance: a real Mac Ignis WebUI editor plus native Obsidian
// on SLS. Only an already-isolated, hand-created acceptance note is edited.
// Usage: BASE_URL=http://127.0.0.1:3195 node scripts/collab-native-webui-e2e.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const base = process.env.BASE_URL || "http://127.0.0.1:3195";
const vault = process.env.LIVE_VAULT || "SLS-TextClone";
const note = process.env.LIVE_NOTE || "IGNIS-Mac-Return-20261107.md";
const fromMac = "[IGNIS-WEBUI-LIVE-20261108]";
const fromSls = "[IGNIS-SLS-LIVE-20261108]";
const verifyOnly = process.env.LIVE_VERIFY_ONLY === "1";
const chromePath = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-native-webui-"));
const profile = path.join(temporary, "chrome");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(work, timeout = 45000, label = "readiness") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await work();
      if (result) return result;
    } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(label + " timed out" + (last ? ": " + last.message : ""));
}
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.counter = 0;
    this.calls = new Map();
    ws.on("message", (bytes) => {
      const reply = JSON.parse(bytes.toString());
      const call = this.calls.get(reply.id);
      if (!call) return;
      this.calls.delete(reply.id);
      if (reply.error) call.reject(new Error(reply.error.message));
      else call.resolve(reply.result || {});
    });
  }
  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.calls.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id, method, params, ...(sessionId ? { sessionId } : {}),
      }));
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.command("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(
      result.exceptionDetails.text +
      (result.exceptionDetails.exception?.description || "")
    );
    return result.result?.value;
  }
}

const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking",
  "--remote-debugging-port=0", "--window-size=1200,880",
  "--user-data-dir=" + profile, "about:blank",
], { stdio: "ignore" });
let cdp;
try {
  const debugUrl = await poll(async () => {
    const [port, route] = (await fs.readFile(
      path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    return "ws://127.0.0.1:" + port + route;
  }, 17000, "Chrome DevTools startup");
  const ws = new WebSocket(debugUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve); ws.once("error", reject);
  });
  cdp = new CDP(ws);
  const { targetId } = await cdp.command("Target.createTarget",
    { url: "about:blank" });
  const { sessionId } = await cdp.command("Target.attachToTarget", {
    targetId, flatten: true,
  });
  await cdp.command("Page.enable", {}, sessionId);
  await cdp.command("Runtime.enable", {}, sessionId);
  await cdp.command("Page.navigate", {
    url: base + "/?vault=" + encodeURIComponent(vault),
  }, sessionId);
  const evaluate = (source) => cdp.evaluate(sessionId, source);
  await poll(() => evaluate(
    "Boolean(window.app?.workspace?.getLeaf && window.app?.vault?.getAbstractFileByPath)"
  ), 55000, "Mac WebUI Obsidian boot");
  await poll(() => evaluate(
    "Boolean(window.app.vault.getAbstractFileByPath(" + JSON.stringify(note) + "))"
  ), 20000, "shared acceptance note");
  await evaluate("(async () => {" +
    "const file=window.app.vault.getAbstractFileByPath(" + JSON.stringify(note) + ");" +
    "await window.app.workspace.getLeaf(false).openFile(file);" +
    "return true;" +
    "})()");
  await poll(() => evaluate(
    "Boolean(window.app.workspace.activeLeaf?.view?.editor?.getValue()?.includes('IGNIS'))"
  ), 30000, "WebUI Markdown editor");
  await poll(() => evaluate(
    "document.querySelector('.ignis-collaboration-status')?.textContent?.includes('online')"
  ), 22000, "Mac WebUI Yjs room");
  console.log("WEBUI_REAL_OBSIDIAN_YJS_READY=" + note);

  const people = await poll(() => evaluate(
    "document.querySelector('.ignis-collaboration-status')?.textContent?.includes('2 online') " +
    "? document.querySelector('.ignis-collaboration-status').textContent : null"
  ), 130000, "SLS native Yjs participant");
  console.log("CROSS_DEVICE_YJS_PRESENCE=" + people);

  const renamed = await evaluate("(() => {" +
    "document.querySelector('.ignis-collaboration-status').click();" +
    "const input=document.querySelector('.modal-container form input');" +
    "if(!input)return false;" +
    "input.value='Mac IGNIS WebUI';" +
    "input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));" +
    "return true;" +
    "})()");
  if (!renamed) throw new Error("Could not set Mac WebUI participant identity");
  await evaluate("(() => {" +
    "const editor=window.app.workspace.activeLeaf.view.editor;" +
    "editor.setSelection({line:0,ch:1},{line:0,ch:5});" +
    "editor.cm.focus();" +
    "editor.cm.dom.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',bubbles:true}));" +
    "return true;" +
    "})()");
  console.log("WEBUI_SELECTION_PUBLISHED=Mac IGNIS WebUI");

  const before = await evaluate(
    "window.app.workspace.activeLeaf.view.editor.getValue()"
  );
  if (verifyOnly) {
    // A cursor belongs to a focused editor, unlike room membership. An idle
    // SLS window may keep a healthy Yjs session without displaying a caret.
    // The restart check verifies membership and persisted CRDT text; the
    // interactive case below additionally requires remote cursor geometry.
    if (!before.includes(fromMac) || !before.includes(fromSls)) {
      throw new Error("Reconnected Yjs generation lost a previous editor's edit");
    }
    console.log("CROSS_DEVICE_YJS_RESTART_PRESERVED_BOTH_EDITS=PASS");
  } else {
    const remoteCursor = await poll(() => evaluate("(() => {" +
      "const labels=[...document.querySelectorAll('.ignis-collab-remote-label')];" +
      "return document.querySelector('.ignis-collab-remote-caret')&&labels.length" +
      "?labels.map(e=>e.textContent):null;" +
      "})()"), 100000, "SLS native cursor rendered in Mac WebUI");
    console.log("MAC_SEES_SLS_NATIVE_REMOTE_CARET=" + JSON.stringify(remoteCursor));

    if (before.includes(fromMac) || before.includes(fromSls)) {
      throw new Error("Acceptance note has old test markers; no duplicate writes");
    }
    await evaluate("(() => {" +
      "const editor=window.app.workspace.activeLeaf.view.editor;" +
      "editor.replaceRange(" + JSON.stringify("\n" + fromMac + "\n") +
      ",editor.offsetToPos(editor.getValue().length));" +
      "return true;" +
      "})()");
    await poll(() => evaluate(
      "window.app.workspace.activeLeaf.view.editor.getValue().includes(" +
      JSON.stringify(fromMac) + ")"
    ), 10000, "Mac WebUI local edit");
    console.log("MAC_WEBUI_LIVE_EDIT_APPLIED=" + fromMac);

    await poll(() => evaluate(
      "window.app.workspace.activeLeaf.view.editor.getValue().includes(" +
      JSON.stringify(fromSls) + ")"
    ), 125000, "SLS native edit arriving live at Mac WebUI");
    const final = await evaluate(
      "window.app.workspace.activeLeaf.view.editor.getValue()"
    );
    if (!final.includes(fromMac) || !final.includes(fromSls)) {
      throw new Error("Yjs content convergence failure");
    }
    console.log("MAC_WEBUI_RECEIVED_NATIVE_SLS_EDIT=" + fromSls);
    console.log("CROSS_DEVICE_YJS_WEBUI_CONVERGENCE=PASS");
  }
} finally {
  cdp?.ws.close();
  chrome.kill("SIGTERM");
  await sleep(650);
  await fs.rm(temporary, { recursive: true, force: true });
}
