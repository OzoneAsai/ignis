import { fsShim } from "./fs/index.js";
import { installRequestUrlShim } from "./request-url.js";
import { vaultService } from "@ignis/services";
import { registerReadTransform } from "./fs/transforms.js";
import {
  resolveWorkspaceName,
  loadPresetIfRequested,
  initWorkspacePatch,
  isValidWorkspaceName,
} from "./workspace.js";
import { prefetchVaultContent } from "./fs/indexer-prefetch.js";
import { setInputCacheLimits } from "./fs/input-cache.js";
import { setSilentByDefault } from "./fs/write-durability.js";
import { setDirectFetchHosts } from "./util/url.js";
import { initNativeMenuGuard } from "./guards/native-menu-guard.js";
import { initSettingsWindowGuard } from "./guards/settings-window-guard.js";
import { initSpellcheckGuard } from "./guards/spellcheck-guard.js";
import { initPopoutGuard } from "./guards/popout-guard.js";
import { saveOfflineBootstrap, loadOfflineBootstrap } from "./offline-boot.js";

let bootstrapVirtualPlugins = [];

// Settings the client must act on come from the bootstrap response and are applied at page load.
// This includes cache sizes, and the hosts the browser fetches directly instead of via the proxy.
// The server owns and enforces the rest.
function applyServerSettings(s) {
  if (!s) {
    return;
  }

  if (Number.isFinite(s.contentCacheBytes)) {
    fsShim._contentCache.setMaxSize(s.contentCacheBytes);
  }

  setInputCacheLimits({ maxSize: s.inputCacheBytes, ttlMs: s.inputCacheTtlMs });
  setDirectFetchHosts(s.directFetchHosts);

  window.__ignis.flags = {
    suppressWriteFailures: s.devSuppressWriteFailures === true,
    forceReadingView: s.devForceReadingView === true,
  };

  setSilentByDefault(window.__ignis.flags.suppressWriteFailures);
}

export function getBootstrapVirtualPlugins() {
  return bootstrapVirtualPlugins;
}

function fetchVaultInfo(vaultId) {
  try {
    const vaultParam = vaultId ? "?vault=" + encodeURIComponent(vaultId) : "";
    const xhr = new XMLHttpRequest();

    xhr.open("GET", "/api/vault/info" + vaultParam, false);
    xhr.send();

    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch (e) {
    console.error("[ignis] Failed to fetch vault config:", e);
  }

  return null;
}

export function resolveVaultId() {
  const urlParams = new URLSearchParams(window.location.search);
  window.__currentVaultId =
    urlParams.get("vault") || localStorage.getItem("last-vault") || "";

  if (!window.__currentVaultId) {
    const info = fetchVaultInfo("");
    window.__currentVaultId = info ? info.id : "";
  }

  const workspace = urlParams.get("workspace") || "";
  window.__workspaceName = isValidWorkspaceName(workspace) ? workspace : "";
}

// Single round-trip bootstrap: vault info + vault list + metadata tree + plugins.
// Returns the parsed response, or null if the call failed (no vault, network error, etc.)
function fetchBootstrap() {
  if (!window.__currentVaultId) {
    return null;
  }

  try {
    const xhr = new XMLHttpRequest();

    xhr.open(
      "GET",
      "/api/bootstrap?vault=" + encodeURIComponent(window.__currentVaultId),
      false,
    );
    xhr.send();

    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch (e) {
    console.warn("[ignis] Bootstrap fetch failed:", e);
  }

  return null;
}

function applyVaultInfo(info) {
  window.__currentVaultId = info.id;
  localStorage.setItem("last-vault", info.id);
  window.__obsidianVersion = info.version || "0.0.0";

  window.__vaultConfig = {
    id: info.id,
    path: "/",
  };

  if (info.trustPlugins) {
    vaultService.setVaultTrust(info.id);
  }

  console.log("[ignis] Vault:", window.__vaultConfig);
  console.log("[ignis] Obsidian version:", window.__obsidianVersion);
}

function applyTree(tree) {
  fsShim._metadataCache.populate(tree);
  fsShim._metadataCache.set("", { type: "directory" });
  fsShim._metadataCache.set("/", { type: "directory" });

  console.log(
    "[ignis] Metadata cache populated:",
    fsShim._metadataCache.size,
    "entries",
  );
}

function applyBootstrapData(bootstrap) {
  applyVaultInfo(bootstrap.vault);
  window.__vaultList = bootstrap.vaultList;
  applyTree(bootstrap.tree);
  fsShim._watcherClient.setTreeEtag(bootstrap.etag);
  applyCoreSyncGuard(bootstrap.plugins);
  bootstrapVirtualPlugins = bootstrap.virtualPlugins || [];
  applyServerSettings(bootstrap.settings);
}

function initVaultConfigFallback() {
  const info = fetchVaultInfo(window.__currentVaultId);

  if (info) {
    applyVaultInfo(info);
  } else {
    console.warn("[ignis] No vault found, will show manager");
  }
}

function initVaultListFallback() {
  try {
    vaultService.listVaultsSync();
  } catch {
    window.__vaultList = [];
  }
}

function initMetadataCacheFallback() {
  try {
    const vaultParam = window.__currentVaultId
      ? "?vault=" + encodeURIComponent(window.__currentVaultId)
      : "";

    const xhr = new XMLHttpRequest();

    xhr.open("GET", "/api/fs/tree" + vaultParam, false);
    xhr.send();

    if (xhr.status === 200) {
      applyTree(JSON.parse(xhr.responseText));
    } else {
      console.error("[ignis] Failed to fetch metadata tree:", xhr.status);
    }
  } catch (e) {
    console.error("[ignis] Failed to init metadata cache:", e);
  }
}

// if headless sync is active, we transform reads of core-plugins.json to hide the sync setting from Obsidian.
// this prevents headless sync from being disabled as a result of a different device syncing "Active core plugins list".
// i.e ensure Ignis always has sync: false if headless sync is active.
// This may be somewhat overengineered. Could revisit later.
function applyCoreSyncGuard(plugins) {
  const vaultId = window.__currentVaultId;

  if (!vaultId || !plugins) {
    return;
  }

  const headlessSync = plugins.find(
    (p) => p.id === "headless-sync" && p.bundledPluginId,
  );

  if (!headlessSync || !headlessSync.enabledVaults.includes(vaultId)) {
    return;
  }

  console.log(
    "[ignis] Headless sync active for this vault, patching core-plugins.json reads",
  );
  window.__ignisHeadlessSyncActive = true;

  registerReadTransform(".obsidian/core-plugins.json", (data) => {
    if (!window.__ignisHeadlessSyncActive) {
      return data;
    }

    let text = typeof data === "string" ? data : new TextDecoder().decode(data);

    try {
      const config = JSON.parse(text);

      if (config.sync === true) {
        config.sync = false;
        return JSON.stringify(config);
      }
    } catch {}

    return data;
  });
}

function initCoreSyncGuardFallback() {
  const vaultId = window.__currentVaultId;

  if (!vaultId) {
    return;
  }

  try {
    const xhr = new XMLHttpRequest();

    xhr.open("GET", "/api/plugins", false);
    xhr.send();

    if (xhr.status === 200) {
      applyCoreSyncGuard(JSON.parse(xhr.responseText));
    }
  } catch (e) {
    console.warn("[ignis] Failed to init core sync guard:", e);
  }
}

// Reflect the priority prefetch's byte progress on the boot splash so the awaited slice reads as active rather than hung.
// The splash logo keeps pulsing through a transit stall, when the byte count would otherwise freeze.
function updateBootProgress(received, total) {
  // Once the injector starts appending Obsidian's scripts it owns the splash label, so stop writing progress over it.
  if (window.__ignisBootStarted) {
    return;
  }

  const label = document.getElementById("ignis-status-label");

  if (!label || !total) {
    return;
  }

  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  label.textContent = `Loading plugins... ${mb(received)}/${mb(total)} MB`;
}

// Resolve the active workspace and snapshot the appearance config.
function resolveWorkspaceAndAppearance() {
  resolveWorkspaceName();
  loadPresetIfRequested();
  initNativeMenuGuard();
  initSettingsWindowGuard();
  initSpellcheckGuard();
}

export function initialize() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/ignis-offline-sw.js", { scope: "/" })
      .catch((error) => console.warn("[ignis] Offline shell unavailable:", error));
  }

  resolveVaultId();

  const bootstrap = fetchBootstrap();

  if (bootstrap) {
    applyBootstrapData(bootstrap);

    // Warm the caches before Obsidian boots.
    // The priority slice (configs and plugin entry files) resolves window.__ignisBootReady, which the index.html injector waits on before appending Obsidian's scripts, so Obsidian's early reads hit the cache.
    // The bulk slice streams afterward without blocking boot.
    const { priority } = prefetchVaultContent(
      window.__currentVaultId,
      bootstrap.tree,
      fsShim._contentCache,
      { onProgress: updateBootProgress },
    );

    window.__ignisBooting = true;

    // Persist exactly the boot metadata/config files that Obsidian may read
    // synchronously. The online copy is always preferred on later launches.
    priority.then(() => saveOfflineBootstrap(
      window.__currentVaultId, bootstrap, fsShim._contentCache,
    )).catch((error) => console.warn("[ignis] Offline bootstrap cache:", error));

    // Chain workspace/appearance resolution onto readiness so its config reads hit the warm priority slice instead of the network.
    window.__ignisBootReady = priority
      .catch(() => {})
      .then(resolveWorkspaceAndAppearance);
  } else {
    window.__ignisBooting = true;
    const label = document.getElementById("ignis-status-label");

    if (label) {
      label.textContent = "Opening locally saved vault…";
    }

    // CacheStorage is asynchronous and synchronous XHR cannot reliably read
    // through a Service Worker. Hold Obsidian script injection until IndexedDB
    // has restored its metadata and sync-file cache.
    window.__ignisBootReady = loadOfflineBootstrap(window.__currentVaultId)
      .then((offline) => {
        if (offline) {
          applyBootstrapData(offline.bootstrap);

          for (const [path, content] of Object.entries({
            ...offline.files,
            ...offline.notes,
          })) {
            fsShim._contentCache.set(path, content);
          }

          window.__ignisOfflineBoot = true;
          console.log("[ignis] Restored offline vault bootstrap from IndexedDB");
        } else {
          initVaultConfigFallback();
          initVaultListFallback();
          initMetadataCacheFallback();
          initCoreSyncGuardFallback();
        }

        resolveWorkspaceAndAppearance();
      })
      .catch((error) => {
        console.warn("[ignis] Offline vault initialization failed:", error);
        initVaultConfigFallback();
        initVaultListFallback();
        initMetadataCacheFallback();
        initCoreSyncGuardFallback();
        resolveWorkspaceAndAppearance();
      });
  }

  installRequestUrlShim();
  initWorkspacePatch();
  initPopoutGuard();
}
