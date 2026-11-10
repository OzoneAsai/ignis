/* IGNIS Obsidian clone: isolated, opt-in UI automation bridge.
 * This file is injected ONLY into dev.ignis.obsidian.lab, never an original app.
 *
 * Commands arrive through the clone-only URL scheme, not a TCP listener.
 * A per-build random token is required even for read-only probes. Results
 * contain no note text, Vault paths, authentication tokens, or HTML.
 */
(() => {
  "use strict";
  if (window.__ignisUITest) return;
  const SCHEME = "ignis-obsidian-lab:";
  const SECRET = "__IGNIS_LAB_TOKEN__";
  const PREFIX = "IGNIS UI Lab · ";
  const SAFE_TARGETS = Object.freeze({
    marker: "#ignis-ui-lab-probe",
    settings: '[aria-label="Settings"]',
  });
  const INSPECTABLE =
    "button,input,textarea,select,summary,a[href],[role=button],[role=textbox]";
  let current = "loading";
  let receiptIndex = 0;
  let startup = false;
  let marker = null;

  function findNative(name) {
    return window.Capacitor?.Plugins?.[name] || null;
  }

  function metrics() {
    return {
      state: document.readyState,
      overlayPresent: !!document.getElementById("ignis-ui-lab-probe"),
      appContainer: !!document.querySelector(".app-container"),
      workspace: !!document.querySelector(".workspace"),
      buttons: document.querySelectorAll("button,[role=button]").length,
      webViewPresent: !!window.Capacitor,
    };
  }

  function controls() {
    return Array.from(document.querySelectorAll(INSPECTABLE))
      .filter((el) => {
        const bounds = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return bounds.width > 0 && bounds.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .slice(0, 48).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        label: (el.getAttribute("aria-label") || "").slice(0, 90),
        text: (el instanceof HTMLInputElement ? "" :
          (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90)),
        placeholder: (el.getAttribute("placeholder") || "").slice(0, 90),
        disabled: !!el.disabled,
      }));
  }

  function elementAt(index) {
    if (!Number.isInteger(index) || index < 0 || index > 47) return null;
    const elements = Array.from(document.querySelectorAll(INSPECTABLE))
      .filter((el) => {
        const bounds = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return bounds.width > 0 && bounds.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      }).slice(0, 48);
    return elements[index] || null;
  }

  async function writeReceipt(action, ok, details = {}) {
    const report = {
      protocol: "ignis-ui-automation-v1",
      action,
      ok: !!ok,
      index: ++receiptIndex,
      timestamp: new Date().toISOString(),
      ...metrics(),
      ...details,
    };
    current = ok ? "ready" : "failed";
    if (marker) {
      marker.textContent = PREFIX + (ok ? "Ready" : "Check failed");
      marker.setAttribute("aria-label", marker.textContent);
    }
    try {
      const filesystem = findNative("Filesystem");
      if (!filesystem?.writeFile) {
        throw new Error("Capacitor Filesystem unavailable");
      }
      await filesystem.writeFile({
        path: "ignis-ui-automation-receipt.json",
        directory: "DOCUMENTS",
        data: JSON.stringify(report),
        encoding: "utf8",
        recursive: true,
      });
    } catch {
      // Never access Obsidian Vault or data as a fallback.
      console.warn("[IGNIS Lab] Native receipt unavailable");
    }
    return report;
  }

  function createMarker() {
    if (marker || !document.body) return;
    marker = document.createElement("button");
    marker.id = "ignis-ui-lab-probe";
    marker.type = "button";
    marker.textContent = PREFIX + "Starting";
    marker.setAttribute("aria-label", marker.textContent);
    marker.style.cssText =
      "position:fixed;right:10px;top:env(safe-area-inset-top,10px);" +
      "z-index:2147483647;background:#174e8f;color:#fff;" +
      "border:2px solid #fff;border-radius:15px;padding:10px;" +
      "font:600 13px system-ui;opacity:.95;pointer-events:auto";
    marker.addEventListener("click", () => {
      void writeReceipt("marker-tap", true);
    });
    document.body.append(marker);
  }

  async function command(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== SCHEME ||
        parsed.hostname !== "automation" ||
        parsed.searchParams.get("token") !== SECRET) return null;
    createMarker();
    const action = parsed.searchParams.get("action") || "probe";
    if (action === "probe" || action === "overlay") {
      return writeReceipt(action, true);
    }
    if (action === "inspect") {
      return writeReceipt(action, true, { controls: controls() });
    }
    if (action === "connector-settings") {
      const host = window.app;
      const pluginLoaded = !!host?.plugins?.getPlugin?.("ignis-connector");
      const open = host?.setting?.open;
      if (!pluginLoaded || typeof open !== "function") {
        return writeReceipt(action, false, {
          error: "Ignis Connector not loaded in this test Vault",
          pluginLoaded,
        });
      }
      host.setting.open();
      host.setting.openTabById?.("ignis-connector");
      return writeReceipt(action, true, { pluginLoaded });
    }
    if (action === "connector-auth-from-file") {
      const filesystem = findNative("Filesystem");
      const password = document.querySelector('input[type="password"]');
      if (!filesystem?.readFile || !(password instanceof HTMLInputElement)) {
        return writeReceipt(action, false, { error: "Connector token field unavailable" });
      }
      try {
        const record = await filesystem.readFile({
          path: "ignis-mobile-scoped-token.txt",
          directory: "DOCUMENTS",
          encoding: "utf8",
        });
        const token = String(record?.data || "").trim();
        if (!/^ignis_dev_[A-Za-z0-9_-]{43}$/.test(token)) {
          return writeReceipt(action, false, { error: "Scoped test credential invalid" });
        }
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          ?.set?.call(password, token);
        password.dispatchEvent(new Event("input", { bubbles: true }));
        password.dispatchEvent(new Event("change", { bubbles: true }));
        return writeReceipt(action, true, { credentialApplied: true });
      } catch {
        return writeReceipt(action, false, { error: "Scoped test credential cannot be read" });
      }
    }
    if (action === "control-tap") {
      const index = Number(parsed.searchParams.get("index"));
      const element = elementAt(index);
      if (!element || element.matches("input,textarea,select") ||
          /delete|erase|remove all|reset vault|削除|消去|初期化/i.test(
            element.getAttribute("aria-label") || element.textContent || "")) {
        return writeReceipt(action, false, { error: "control not allowed" });
      }
      await writeReceipt(action, true, { target: "control-" + index });
      element.click();
      return null;
    }
    if (action === "control-type") {
      const index = Number(parsed.searchParams.get("index"));
      const value = parsed.searchParams.get("value") || "";
      const element = elementAt(index);
      if (!element || !element.matches("input,textarea,[role=textbox]") ||
          value.length > 80 ||
          /password|token|secret/i.test(element.getAttribute("type") || "")) {
        return writeReceipt(action, false, { error: "text target not allowed" });
      }
      if ("value" in element) {
        const proto = element instanceof HTMLTextAreaElement ?
          HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
      } else {
        element.textContent = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return writeReceipt(action, true, { target: "control-" + index });
    }
    if (action === "tap") {
      const target = parsed.searchParams.get("target");
      const selector = SAFE_TARGETS[target];
      if (!selector) return writeReceipt(action, false, { error: "target not allowed" });
      const element = document.querySelector(selector);
      if (!element || !(element instanceof HTMLElement)) {
        return writeReceipt(action, false, { error: "target not found" });
      }
      element.click();
      return writeReceipt(action, true, { target });
    }
    return writeReceipt(action, false, { error: "unknown action" });
  }

  async function activate() {
    if (startup) return;
    startup = true;
    createMarker();
    await writeReceipt("boot", true);
    const app = findNative("App");
    if (!app?.addListener) return;
    await app.addListener("appUrlOpen", (event) => {
      void command(event?.url || "");
    });
    if (app?.getLaunchUrl) {
      const value = await app.getLaunchUrl();
      if (value?.url) void command(value.url);
    }
  }

  Object.defineProperty(window, "__ignisUITest", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: "1",
      probe: () => writeReceipt("probe", true),
      state: () => current,
    }),
  });
  const setup = () => {
    let checks = 0;
    const timer = setInterval(() => {
      if (!document.body || !findNative("Filesystem")) {
        if (++checks > 90) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      void activate();
    }, 250);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();
