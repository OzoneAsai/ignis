// End-to-end resilience: real Obsidian + IndexedDB + Service Worker, with the
// actual test server stopped, browser reloaded, and CRDT states reconciled.
// It uses a dedicated ephemeral port and vault; installed Ignis is untouched.
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const obsidianAssets = process.env.OBSIDIAN_ASSETS_PATH ||
  "/Users/o3/Library/Application Support/Obsidian-WebUI/obsidian-app";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-offline-e2e-"));
const vaultRoot = path.join(temporary, "vaults");
const dataRoot = path.join(temporary, "data");
const file = path.join(vaultRoot, "Lab", "Offline Draft.md");
const profile = path.join(temporary, "chrome-profile");

let child = null;
let chrome = null;
let socket = null;

function assert(condition, reason) {
  if (!condition) {
    throw new Error(reason);
  }
}

async function poll(callback, timeout = 35000, label = "operation") {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const value = await callback();

      if (value) {
        return value;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function getPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(port) {
  child = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      IGNIS_BIND_HOST: "127.0.0.1",
      VAULT_ROOT: vaultRoot,
      DATA_ROOT: dataRoot,
      OBSIDIAN_ASSETS_PATH: obsidianAssets,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (part) => { log += part.toString(); });
  child.stderr.on("data", (part) => { log += part.toString(); });

  await poll(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Ignis crashed: ${log.slice(-2000)}`);
    }

    return fetch(`http://127.0.0.1:${port}/api/vault/info`)
      .then((response) => response.ok).catch(() => false);
  }, 15000, "test server");
}

async function stopServer() {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }

  const exiting = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exiting.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
  ]);

  if (!stopped) {
    child.kill("SIGKILL");
    await exiting;
  }

  child = null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.requests = new Map();
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const request = this.requests.get(message.id);

      if (!request) {
        return;
      }

      this.requests.delete(message.id);

      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result || {});
      }
    });
  }

  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.requests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(sessionId, expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }

    return result.result?.value;
  }
}

async function browser(port) {
  chrome = spawn(chromeBinary, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--window-size=1350,950", "about:blank",
  ], { stdio: "ignore" });

  const debugUrl = await poll(async () => {
    const [debugPort, debugPath] = (await fs.readFile(
      path.join(profile, "DevToolsActivePort"), "utf-8",
    )).trim().split("\n");
    return `ws://127.0.0.1:${debugPort}${debugPath}`;
  }, 15000, "Chrome debugger");

  socket = new WebSocket(debugUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const cdp = new CDP(socket);
  const { targetId } = await cdp.command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.command("Target.attachToTarget", { targetId, flatten: true });
  await cdp.command("Page.enable", {}, sessionId);
  await cdp.command("Runtime.enable", {}, sessionId);
  const address = `http://127.0.0.1:${port}/?vault=Lab`;

  async function newTab() {
    const { targetId: another } = await cdp.command("Target.createTarget", { url: "about:blank" });
    const { sessionId: next } = await cdp.command("Target.attachToTarget", {
      targetId: another, flatten: true,
    });
    await cdp.command("Page.enable", {}, next);
    await cdp.command("Runtime.enable", {}, next);
    return next;
  }

  async function openPage(tab = sessionId) {
    await cdp.command("Page.navigate", { url: address }, tab);
    await poll(() => cdp.evaluate(tab,
      "Boolean(window.app?.workspace?.getLeaf && window.app?.vault?.getAbstractFileByPath)"),
    60000, "Obsidian startup");
    await poll(() => cdp.evaluate(tab,
      "Boolean(window.app.vault.getAbstractFileByPath('Offline Draft.md'))"),
    30000, "offline note metadata");
    const opened = await poll(() => cdp.evaluate(tab, `(async () => {
      const note = window.app.vault.getAbstractFileByPath('Offline Draft.md');
      await window.app.workspace.getLeaf(false).openFile(note);
      return Boolean(window.app.workspace.activeLeaf?.view?.editor);
    })()`), 30000, "Markdown pane startup");
    assert(opened, "Could not open Markdown editor");
    await poll(() => cdp.evaluate(tab, `(() => {
      const status = document.querySelector('.ignis-collaboration-status')?.textContent || '';
      return status.includes('saved') || status.includes('offline') ||
        status.includes('review unsent') || status.includes('note replaced');
    })()`), 30000, "collaboration initialization");
  }

  const read = (tab = sessionId) => cdp.evaluate(tab,
    "window.app.workspace.activeLeaf.view.editor.getValue()");
  const status = (tab = sessionId) => cdp.evaluate(tab,
    "document.querySelector('.ignis-collaboration-status')?.textContent || ''");
  const append = (content, tab = sessionId) => cdp.evaluate(tab, `(() => {
    const editor = window.app.workspace.activeLeaf.view.editor;
    editor.replaceRange(${JSON.stringify(content)}, editor.offsetToPos(editor.getValue().length));
    return editor.getValue();
  })()`);

  return { cdp, sessionId, address, newTab, openPage, read, status, append };
}

try {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, "Lab", ".obsidian"), { recursive: true });
  await fs.writeFile(file, "Server start\n", "utf-8");
  const port = await getPort();
  await startServer(port);
  const page = await browser(port);

  await page.openPage();
  await poll(() => page.cdp.evaluate(page.sessionId,
    "Boolean(navigator.serviceWorker.controller)"), 20000, "offline service worker controller");

  // A controlled online reload makes all Obsidian assets and note reads
  // available in CacheStorage before network access disappears.
  await page.openPage();
  const cacheSnapshot = () => page.cdp.evaluate(page.sessionId, `(async () => {
    const shell = await caches.open('ignis-collab-shell-v1');
    const data = await caches.open('ignis-collab-vault-v1');
    const offline = await new Promise((resolve, reject) => {
      const opened = indexedDB.open('ignis-collab-offline-bootstrap-v1');
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const names = Array.from(db.objectStoreNames);
        if (!names.includes('vaults') || !names.includes('notes')) {
          db.close(); resolve({boot: false, note: false}); return;
        }
        const tx = db.transaction(['vaults', 'notes'], 'readonly');
        const boot = tx.objectStore('vaults').get('Lab');
        const note = tx.objectStore('notes').get(JSON.stringify(['Lab','Offline Draft.md']));
        tx.oncomplete = () => {
          resolve({boot: Boolean(boot.result?.bootstrap), note: Boolean(note.result?.content)});
          db.close();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    return {controlled: Boolean(navigator.serviceWorker.controller),
      shell:(await shell.keys()).map(x=>new URL(x.url).pathname).slice(0,45),
      data:(await data.keys()).map(x=>new URL(x.url).pathname).slice(0,45),
      offline};
  })()`);
  await poll(async () => {
    const snapshot = await cacheSnapshot();
    return snapshot.shell.includes('/app.js') && snapshot.shell.includes('/shim-loader.js') &&
      snapshot.offline.boot && snapshot.offline.note;
  }, 25000, "cached Obsidian shell, vault bootstrap and offline note");
  console.log("PASS: app shell, vault bootstrap and note cached for offline reload");

  await stopServer();
  await poll(async () => (await page.status()).includes("offline"), 12000, "offline status");
  await page.append("OFFLINE FIRST\n");
  await poll(async () => (await page.status()).includes("saved on device"),
    12000, "locally durable first edit");

  const secondTab = await page.newTab();
  await page.openPage(secondTab);
  await poll(async () => (await page.read(secondTab)).includes("OFFLINE FIRST"),
    15000, "second tab recovery while disconnected");
  await page.append("OFFLINE SECOND TAB\n", secondTab);
  await poll(async () => (await page.read()).includes("OFFLINE SECOND TAB"),
    15000, "same-origin live offline BroadcastChannel sync");
  await poll(async () => (await page.status(secondTab)).includes("saved on device"),
    12000, "second tab local durable edit");
  console.log("PASS: two Chrome tabs converge offline without a running server");

  await page.openPage();
  assert((await page.read()).includes("OFFLINE FIRST") &&
    (await page.read()).includes("OFFLINE SECOND TAB"), "Lost cross-tab offline edits on page reload");
  console.log("PASS: browser reloaded while server offline, Yjs note recovered from IndexedDB");

  await page.append("OFFLINE AFTER RELOAD\n");
  await poll(async () => (await page.status()).includes("saved on device"),
    12000, "locally durable second edit");

  // Model a different editor writing to the Markdown file while this browser
  // remains disconnected. The server reconciles this file on room reopening.
  const current = await fs.readFile(file, "utf-8");
  await fs.writeFile(file, "REMOTE EDIT\n" + current, "utf-8");
  await startServer(port);
  await poll(async () => {
    const value = await page.read();
    const state = await page.status();
    return value.includes("REMOTE EDIT") && value.includes("OFFLINE FIRST") &&
      value.includes("OFFLINE SECOND TAB") && value.includes("OFFLINE AFTER RELOAD") &&
      state.includes("saved");
  }, 30000, "CRDT reconnection merge and server durability");
  const merged = await page.read();
  await poll(async () => (await fs.readFile(file, "utf-8")) === merged,
    15000, "canonical Markdown persistence");
  console.log("PASS: server restart + remote edit merged with both offline edits");

  // A deleted-and-recreated note is a NEW document, despite the same path.
  // Keep both browser tabs open with their old IndexedDB histories, remove the
  // server's CRDT history as a deletion would, then recreate a new Markdown
  // note at that path. The old offline updates must never reappear in it.
  await stopServer();
  const replacementText = "A completely different document generation\n";
  await fs.rm(path.join(dataRoot, "collaboration"), { recursive: true, force: true });
  await fs.writeFile(file, replacementText, "utf-8");
  await startServer(port);
  await poll(async () => (await page.status()).includes("note replaced"),
    30000, "generation mismatch warning");
  assert(await fs.readFile(file, "utf-8") === replacementText,
    "Stale offline CRDT state overwrote a replacement note");
  assert((await page.read()).includes("OFFLINE FIRST"),
    "Original offline recovery copy was discarded before user consent");
  console.log("PASS: new note generation rejects old offline changes and retains recovery copy");

  await page.cdp.evaluate(page.sessionId, `(() => {
    document.querySelector('.ignis-collaboration-status').click();
    const button = [...document.querySelectorAll('button')].find(
      (element) => element.textContent.includes('Open new server note'));
    if (!button) throw new Error('Missing safe generation switch action');
    button.click();
    return true;
  })()`);
  await poll(async () => (await page.read()) === replacementText,
    30000, "replaced note loading from its own IndexedDB generation");
  await poll(async () => (await fs.readFile(file, "utf-8")) === replacementText,
    15000, "replacement Markdown still unmodified");
  const recovered = await page.cdp.evaluate(page.sessionId, `(() => {
    document.querySelector('.ignis-collaboration-status').click();
    return [...document.querySelectorAll('textarea')].map((item) => item.value)
      .find((text) => text.includes('OFFLINE FIRST')) || null;
  })()`);
  assert(recovered?.includes("OFFLINE SECOND TAB"),
    "Protected previous generation was not accessible through the recovery UI");
  await page.openPage();
  assert((await page.read()) === replacementText,
    "The selected new note generation did not survive a page reload");
  assert(await fs.readFile(file, "utf-8") === replacementText,
    "Reload mixed two distinct note generations");
  console.log("PASS: explicit safe switch opens new note and preserves old draft across reload");
} finally {
  socket?.close();
  chrome?.kill("SIGTERM");
  await stopServer();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(temporary, { recursive: true, force: true });
}
