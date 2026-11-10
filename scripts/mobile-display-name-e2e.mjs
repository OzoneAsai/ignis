// Headless iPhone-size regression for one Ignis action inside Obsidian's
// existing navbar: status, file import, participant name and persistence.
// Usage: BASE_URL=http://127.0.0.1:35642 COLLAB_TEST_VAULT=TestVault
//        node scripts/mobile-display-name-e2e.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const base = process.env.BASE_URL || "http://127.0.0.1:35642";
const vault = process.env.COLLAB_TEST_VAULT || "TestVault";
const vaultRoot = process.env.COLLAB_TEST_ROOT || "";
const browser = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-mobile-name-"));
const profile = path.join(tmp, "chrome");
const uploadName = "iphone-upload-parity.txt";
const uploadPath = path.join(tmp, uploadName);
const uploadContent = "iPhone file picker + WebVault parity: 日本語\n";
await fs.writeFile(uploadPath, uploadContent, { encoding: "utf8" });
const imagePath = path.resolve("images/favicon.png");
const imageBytes = await fs.readFile(imagePath);
const chrome = spawn(browser, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=390,844", "about:blank"
], { stdio: "ignore" });

async function poll(fn, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // The page may still be loading.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("PWA name control did not become available");
}

class Browser {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result || {});
    });
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({
        id, method, params, ...(sessionId ? { sessionId } : {})
      }));
    });
  }
  async evaluate(sessionId, expression) {
    const data = await this.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (data.exceptionDetails) {
      throw new Error(data.exceptionDetails.exception?.description ||
        data.exceptionDetails.text);
    }
    return data.result?.value;
  }
}

let socket;
try {
  const url = await poll(async () => {
    const raw = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
    const [port, route] = raw.trim().split("\n");
    return `ws://127.0.0.1:${port}${route}`;
  }, 12000);
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const cdp = new Browser(socket);
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", {
    targetId, flatten: true,
  });
  await cdp.call("Page.enable", {}, sessionId);
  await cdp.call("Runtime.enable", {}, sessionId);
  // Obsidian language is independent of the Mac's OS language. Keep the
  // Japanese interaction regression deterministic in a clean browser.
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: 'try { localStorage.setItem("language", "ja"); } catch {}',
  }, sessionId);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  }, sessionId);
  await cdp.call("Page.navigate", {
    url: base + "/?vault=" + encodeURIComponent(vault),
  }, sessionId);

  const state = await poll(() => cdp.evaluate(sessionId, `(() => {
    const bar = document.querySelector(".mobile-navbar .mobile-navbar-actions");
    const action = bar?.querySelector(".ignis-navbar-action");
    const button = action?.querySelector(".ignis-navbar-trigger");
    if (!button || !bar) return null;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    if (style.display === "none" || rect.width < 36 || rect.height < 40 ||
        rect.top < 0 || rect.bottom > innerHeight + 1 ||
        rect.left < 0 || rect.right > innerWidth + 1) return null;
    const target = document.elementFromPoint(
      (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    if (!button.contains(target) && target !== button) return null;
    const controls = [...bar.querySelectorAll(".mobile-navbar-action > button, .mobile-navbar-action > .clickable-icon")].map(control => {
      const box = control.getBoundingClientRect();
      const elem = document.elementFromPoint(
        (box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { label: control.textContent, visible: box.width > 0 && box.height >= 44 &&
        box.left >= 0 && box.right <= innerWidth + 1 &&
        box.top >= 0 && box.bottom <= innerHeight + 1 &&
        (elem === control || control.contains(elem)),
        kind: control.closest(".mobile-navbar-action")?.dataset.connection || null };
    });
    if (controls.length < 3 || controls.some(control => !control.visible) ||
        document.querySelector(".ignis-mobile-actions") ||
        bar.querySelectorAll(".ignis-navbar-action").length !== 1) return null;
    return { label: button.getAttribute("aria-label"), viewport: [innerWidth, innerHeight],
      rect: [rect.left, rect.top, rect.right, rect.bottom],
      aria: button.getAttribute("aria-label"), controls,
      navbar: [bar.getBoundingClientRect().top, bar.getBoundingClientRect().bottom] };
  })()`), 30000);
  if (!state.label?.includes("Ignis")) {
    throw new Error("Mobile PWA button label missing: " + JSON.stringify(state));
  }
  console.log("PASS: one Ignis icon inside iPhone-size native navbar; no floating dock",
    JSON.stringify(state));
  const connection = await poll(() => cdp.evaluate(sessionId, `(() => {
    const status = document.querySelector(".ignis-navbar-action");
    return status?.dataset.connection === "connected" &&
      window.__ignis?.ws?.isOpen?.() ? status.querySelector("button")?.getAttribute("aria-label") : null;
  })()`), 12000);
  console.log("PASS: navbar connection dot reflects the actual open WebSocket",
    connection);

  const opened = await cdp.evaluate(sessionId, `(() => {
    document.querySelector(".ignis-navbar-trigger").click();
    const dialog = document.querySelector(".ignis-mobile-action-menu");
    return dialog ? { status: dialog.querySelector(".ignis-mobile-action-state")?.textContent,
      actions: [...dialog.querySelectorAll("button")].map(el => el.textContent) } : null;
  })()`);
  if (!opened || !opened.status?.includes("接続") ||
      !opened.actions.includes("ファイル追加") ||
      !opened.actions.includes("ファイル名を変更") ||
      !opened.actions.includes("参加者・表示名")) {
    throw new Error("Ignis navbar action menu not usable: " + JSON.stringify(opened));
  }
  console.log("PASS: navbar menu has status, upload and participant actions", opened);
  const english = await cdp.evaluate(sessionId, `(() => {
    localStorage.setItem("language", "en");
    document.querySelector(".ignis-navbar-trigger").click();
    const dialog = [...document.querySelectorAll(".ignis-mobile-action-menu")].at(-1);
    const labels = [...dialog.querySelectorAll("button")].map(button => button.textContent);
    const status = dialog.querySelector(".ignis-mobile-action-state")?.textContent;
    localStorage.setItem("language", "ja");
    document.querySelector(".ignis-navbar-trigger").click();
    return { labels, status };
  })()`);
  if (!english.labels.includes("Add files") ||
      !english.labels.includes("Participants & display name") ||
      !english.status?.includes("Connection & sync")) {
    throw new Error("Obsidian English preference not respected: " + JSON.stringify(english));
  }
  console.log("PASS: mobile action menu respects switched Obsidian English preference", english);

  // Set a real test file into the system file-input using CDP. This exercises
  // the same File API and vault.createBinary route used by Safari/iOS PWA.
  await cdp.evaluate(sessionId, `(() => {
    window.__ignisUploadErrors = [];
    window.__ignisUploadTargets = [];
    const vault = window.app.vault;
    const create = vault.createBinary;
    vault.createBinary = function(path, ...args) {
      window.__ignisUploadTargets.push(path);
      return create.call(this, path, ...args);
    };
    const previous = console.error.bind(console);
    console.error = (...arguments_) => {
      if (String(arguments_[0]).includes("Upload failed")) {
        window.__ignisUploadErrors.push(arguments_.map(value =>
          value?.message || String(value)).join(" | "));
      }
      previous(...arguments_);
    };
    return true;
  })()`);
  await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = await cdp.evaluate(sessionId, `(() => {
      if (!document.querySelector(".ignis-mobile-action-menu"))
        document.querySelector(".ignis-navbar-trigger").click();
      const upload = [...document.querySelectorAll(".ignis-mobile-action-menu > button")]
        .find(button => button.textContent === "ファイル追加");
      upload?.click();
      const el = document.querySelector(".ignis-upload-file-input");
      return el ? { multiple: el.multiple, type: el.type,
        hiddenByDisplay: getComputedStyle(el).display === "none" } : null;
    })()`);
    if (!input || !input.multiple || input.hiddenByDisplay || input.type !== "file") {
      throw new Error("Mobile file picker not connected: " + JSON.stringify(input));
    }
    const { root } = await cdp.call("DOM.getDocument", {}, sessionId);
    const { nodeId } = await cdp.call("DOM.querySelector", {
      nodeId: root.nodeId, selector: ".ignis-upload-file-input",
    }, sessionId);
    if (!nodeId) throw new Error("File input is not in DOM");
    await cdp.call("DOM.setFileInputFiles", {
      files: [uploadPath], nodeId,
    }, sessionId);
    const pathInVault = attempt === 0 ? uploadName : "iphone-upload-parity (1).txt";
    const feedback = await poll(() => cdp.evaluate(sessionId, `(() => {
      const known = Boolean(window.app?.vault?.getAbstractFileByPath?.(${JSON.stringify(pathInVault)}));
      const errors = window.__ignisUploadErrors;
      return known || errors.length ? { known, errors, targets: window.__ignisUploadTargets } : null;
    })()`), 9000);
    if (!feedback.known || feedback.errors?.length) {
      const debug = await cdp.evaluate(sessionId, `(() => ({
        errors: window.__ignisUploadErrors,
        targets: window.__ignisUploadTargets,
        selected: Boolean(window.app?.vault?.getAbstractFileByPath?.(${JSON.stringify(uploadName)})),
        expectedName: ${JSON.stringify(pathInVault)}
      }))()`);
      throw new Error("Mobile upload failed: " + JSON.stringify(feedback) + " " + JSON.stringify(debug));
    }
    if (vaultRoot) {
      const actual = await poll(() =>
        fs.readFile(path.join(vaultRoot, vault, pathInVault), "utf8"), 12000);
      if (actual !== uploadContent) {
        throw new Error("Uploaded file differs from original system File data");
      }
    }
    const cache = await cdp.evaluate(sessionId, `(() => ({
      known: Boolean(window.app?.vault?.getAbstractFileByPath?.(${JSON.stringify(pathInVault)})),
      navbar: document.querySelector(".ignis-navbar-trigger")?.getAttribute("aria-label")
    }))()`);
    console.log("UPLOADED_FILE", pathInVault, JSON.stringify(cache));
  }
  console.log("PASS: iPhone-like file input uploads real UTF-8 files without overwriting duplicates");

  // A real PNG from Ignis's checked-in assets: upload twice, then rename one
  // without damaging the other file or converting binary data to text.
  for (let attempt = 0; attempt < 2; attempt++) {
    const chosen = await cdp.evaluate(sessionId, `(() => {
      document.querySelector(".ignis-navbar-trigger").click();
      const upload = [...document.querySelectorAll(".ignis-mobile-action-menu > button")]
        .find(button => button.textContent === "ファイル追加");
      upload?.click();
      return Boolean(document.querySelector(".ignis-upload-file-input"));
    })()`);
    if (!chosen) throw new Error("PNG upload picker did not open");
    const { root } = await cdp.call("DOM.getDocument", {}, sessionId);
    const { nodeId } = await cdp.call("DOM.querySelector", {
      nodeId: root.nodeId, selector: ".ignis-upload-file-input",
    }, sessionId);
    await cdp.call("DOM.setFileInputFiles", { files: [imagePath], nodeId }, sessionId);
    const candidate = attempt === 0 ? "favicon.png" : "favicon (1).png";
    await poll(() => cdp.evaluate(sessionId,
      `Boolean(window.app?.vault?.getAbstractFileByPath?.(${JSON.stringify(candidate)}))`), 12000);
    if (vaultRoot) {
      const actual = await poll(() => fs.readFile(path.join(vaultRoot, vault, candidate)), 12000);
      if (!actual.equals(imageBytes)) throw new Error("PNG content differs from original binary");
    }
  }
  console.log("PASS: iPhone-like picker accepts real PNG bytes and duplicates safely");

  const editor = await cdp.evaluate(sessionId, `(() => {
    document.querySelector(".ignis-navbar-trigger").click();
    const action = [...document.querySelectorAll(".ignis-mobile-action-menu > button")]
      .find(button => button.textContent === "ファイル名を変更");
    action?.click();
    const search = document.querySelector(".ignis-rename-file-search");
    if (!search) return { error: "search not available" };
    search.value = "favicon.png";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const options = [...document.querySelectorAll(".ignis-rename-file-select")];
    options.find(button => button.textContent === "favicon.png")?.click();
    const input = document.querySelector(".ignis-rename-form input");
    return { available: Boolean(input), basename: input?.value,
      extension: document.querySelector(".ignis-rename-form")?.textContent };
  })()`);
  if (!editor.available || editor.basename !== "favicon" || !editor.extension?.includes(".png")) {
    throw new Error("Image file rename form missing: " + JSON.stringify(editor));
  }
  const conflict = await cdp.evaluate(sessionId, `(() => {
    const form = document.querySelector(".ignis-rename-form");
    form.querySelector("input").value = "favicon (1)";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return form.querySelector(".ignis-rename-feedback")?.textContent;
  })()`);
  const collisionStatus = conflict || await poll(() => cdp.evaluate(sessionId,
    `document.querySelector(".ignis-rename-feedback")?.textContent || null`), 3000);
  if (!collisionStatus.includes("同じ名前")) {
    throw new Error("Image rename overwrite prevention failed: " + collisionStatus);
  }

  const submitting = await cdp.evaluate(sessionId, `(() => {
    const form = document.querySelector(".ignis-rename-form");
    form.querySelector("input").value = "旅行の写真";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!submitting) throw new Error("Image rename could not submit");
  const renamedPath = "旅行の写真.png";
  await poll(() => cdp.evaluate(sessionId, `(() => {
    const vault = window.app?.vault;
    return vault?.getAbstractFileByPath?.(${JSON.stringify(renamedPath)}) &&
      !vault?.getAbstractFileByPath?.("favicon.png") &&
      vault?.getAbstractFileByPath?.("favicon (1).png") ? true : null;
  })()`), 15000);
  if (vaultRoot) {
    const renamedBytes = await poll(() =>
      fs.readFile(path.join(vaultRoot, vault, renamedPath)), 12000);
    const stillExistingBytes = await fs.readFile(path.join(vaultRoot, vault, "favicon (1).png"));
    if (!renamedBytes.equals(imageBytes) || !stillExistingBytes.equals(imageBytes)) {
      throw new Error("Image rename changed binary data or damaged the other image");
    }
    try {
      await fs.access(path.join(vaultRoot, vault, "favicon.png"));
      throw new Error("Renamed PNG original was not moved");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  console.log("PASS: image rename from bottom navbar preserves PNG, blocks name collisions and retains image bytes");

  const name = "PWA 日本語テスト";
  const saved = await cdp.evaluate(sessionId, `(() => {
    document.querySelector(".ignis-navbar-trigger").click();
    const people = [...document.querySelectorAll(".ignis-mobile-action-menu > button")]
      .find(button => button.textContent === "参加者・表示名");
    people?.click();
    const peopleModal = [...document.querySelectorAll(".modal-content")]
      .find(root => root.querySelector("h3")?.textContent === "Live collaborators");
    const input = peopleModal?.querySelector("form input");
    if (!input) return { error: "participant name modal missing" };
    input.value = ${JSON.stringify(name)};
    input.closest("form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }));
    return { persistent: localStorage.getItem("ignis-collab-display-name"),
      tab: sessionStorage.getItem("ignis-collab-display-name") };
  })()`);
  if (saved.persistent !== name || saved.tab !== name) {
    throw new Error("Mobile name did not persist: " + JSON.stringify(saved));
  }
  console.log("PASS: participant modal saves persistent local preference");

  await cdp.evaluate(sessionId,
    'sessionStorage.removeItem("ignis-collab-display-name"); true');
  await cdp.call("Page.reload", { ignoreCache: true }, sessionId);
  const restored = await poll(() => cdp.evaluate(sessionId, `(() => {
    const button = document.querySelector(".ignis-navbar-trigger");
    if (!button || !window.app?.workspace) return null;
    button.click();
    const people = [...document.querySelectorAll(".ignis-mobile-action-menu > button")]
      .find(element => element.textContent === "参加者・表示名");
    people?.click();
    const peopleModal = [...document.querySelectorAll(".modal-content")]
      .find(root => root.querySelector("h3")?.textContent === "Live collaborators");
    const input = peopleModal?.querySelector("form input");
    return input?.value || null;
  })()`), 30000);
  if (restored !== name) {
    throw new Error("PWA name not restored after reload: " + restored);
  }
  console.log("PASS: display name survives new PWA page load without sessionStorage", restored);
  await cdp.evaluate(sessionId, `(() => {
    document.querySelectorAll(".modal-container").forEach(modal => {
      const close = modal.querySelector(".modal-close-button");
      close?.click();
    });
    return true;
  })()`);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 320, height: 720, deviceScaleFactor: 3, mobile: true,
  }, sessionId);
  const compact = await poll(() => cdp.evaluate(sessionId, `(() => {
    const bar = document.querySelector(".mobile-navbar .mobile-navbar-actions");
    const actions = [...(bar?.querySelectorAll(".mobile-navbar-action") || [])];
    if (!actions.length) return null;
    const allInside = actions.every(action => {
      const rect = action.getBoundingClientRect();
      return rect.width >= 34 && rect.left >= 0 && rect.right <= innerWidth + 1;
    });
    const ignis = bar.querySelector(".ignis-navbar-trigger");
    return allInside && ignis && !document.querySelector(".ignis-mobile-actions")
      ? { width: innerWidth, count: actions.length,
        rect: [...["left", "top", "right", "bottom"].map(key => ignis.getBoundingClientRect()[key])] }
      : null;
  })()`), 10000);
  console.log("PASS: all native navbar actions remain inside 320px viewport", compact);
  // Obsidian replaces its entire mobile navbar with the editing toolbar
  // when a note receives focus. Ignis must move to that toolbar, rather
  // than disappear until the user dismisses the keyboard.
  await cdp.evaluate(sessionId, "(" + (async () => {
    const path = "Toolbar focus probe.md";
    const file = window.app.vault.getAbstractFileByPath(path) ||
      await window.app.vault.create(path, "Mobile toolbar focus test");
    await window.app.workspace.getLeaf(false).openFile(file);
    window.app.workspace.activeLeaf.view.editor.cm.focus();
    return true;
  }).toString() + ")()");
  const editing = await poll(() => cdp.evaluate(sessionId, "(" + (() => {
    if (!document.body.classList.contains("mod-toolbar-open")) return null;
    const list = document.querySelector(".mobile-toolbar .mobile-toolbar-options-list");
    const action = list?.querySelector(".ignis-navbar-action.mobile-toolbar-option");
    const button = action?.querySelector(".ignis-navbar-trigger");
    if (!button || list.firstElementChild !== action ||
        document.querySelectorAll(".ignis-navbar-trigger").length !== 1) return null;
    const rect = button.getBoundingClientRect();
    const atCenter = document.elementFromPoint(
      (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    if (rect.width < 36 || rect.height < 40 ||
        rect.left < 0 || rect.right > innerWidth + 1 ||
        rect.top < 0 || rect.bottom > innerHeight + 1 ||
        (!button.contains(atCenter) && atCenter !== button)) return null;
    button.click();
    const menu = [...document.querySelectorAll(".ignis-mobile-action-menu")].at(-1);
    return menu ? {
      toolbar: true, viewport: innerWidth,
      actions: [...menu.querySelectorAll("button")].map(el => el.textContent),
      navbarPresent: Boolean(document.querySelector(".mobile-navbar")),
      fixedDock: Boolean(document.querySelector(".ignis-mobile-actions"))
    } : null;
  }).toString() + ")()"), 12000);
  if (!editing.actions.includes("ファイル追加") ||
      !editing.actions.includes("参加者・表示名") || editing.fixedDock) {
    throw new Error("Editing toolbar Ignis actions not accessible: " + JSON.stringify(editing));
  }
  console.log("PASS: 320px editor toolbar retains Ignis action when navbar disappears", editing);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  const hiddenOnDesktop = await poll(() => cdp.evaluate(sessionId, `(() => {
    return !document.querySelector(".ignis-mobile-actions") &&
      !document.querySelector(".ignis-native-mobile-actions");
  })()`));
  if (!hiddenOnDesktop) throw new Error("Desktop ribbon parity: mobile dock overlap");
  console.log("PASS: no fixed Ignis mobile dock on any viewport");
  await cdp.call("Target.closeTarget", { targetId });
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  chrome.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 400));
  await fs.rm(tmp, { recursive: true, force: true });
}
