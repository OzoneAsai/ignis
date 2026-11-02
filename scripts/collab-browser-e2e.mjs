// Integration exercise of two actual Obsidian browser editors via Chrome DevTools.
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
const notePath = "Browser CRDT Test.md";
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
    return sessionId;
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

    const opened = await cdp.evaluate(tab, `(async () => {
      const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
      if (!file) throw new Error("Browser test note is missing");
      await window.app.workspace.getLeaf(false).openFile(file);
      return Boolean(window.app.workspace.activeLeaf?.view?.editor);
    })()`);

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

  await Promise.all([
    cdp.evaluate(a, "window.app.workspace.activeLeaf.view.editor.replaceRange('Alice ', {line:0,ch:0}); true"),
    cdp.evaluate(b, "window.app.workspace.activeLeaf.view.editor.replaceRange('Bob ', {line:0,ch:0}); true"),
  ]);

  const merged = await poll(async () => {
    const first = await read(a);
    const second = await read(b);
    return first === second && first.includes("Alice ") && first.includes("Bob ") && first;
  }, 20000);
  console.log("PASS: two real Obsidian editors converged:", JSON.stringify(merged));
  socket.close();
} finally {
  if (cdp?.ws.readyState === WebSocket.OPEN) {
    cdp.ws.close();
  }

  chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(temp, { recursive: true, force: true });
}
