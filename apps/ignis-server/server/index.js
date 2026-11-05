const express = require("express");
const path = require("path");
const compression = require("compression");
const config = require("./config");
const settings = require("./settings");
const { cacheControlFor } = require("./static/cache-headers");
const { buildIndexHtml } = require("./static/index-html");
const { getObsidianTerms } = require("./static/obsidian-terms");
const {
  setupWebSocket,
  watcher,
  writeCoalescer,
  resolveVaultPath,
} = require("@ignis/server-core");
const {
  BRIDGE_PLUGIN_ID,
  migratePluginsFromAllVaults,
} = require("./plugin-system/migrate-bridge");
const {
  initPlugins,
  shutdownPlugins,
  getBundledPluginDirs,
  getPluginDataDir,
} = require("./plugin-system/manager");
const obCli = require("./obsidian-account/ob-cli");
const pluginRoutes = require("./routes/plugins");
const { flushAll } = writeCoalescer;

writeCoalescer.configure({ writeCoalesceMs: settings.get("writeCoalesceMs") });
watcher.configure({ ignoredPaths: settings.resolveIgnoreLines() });
obCli.init({
  obHome: path.join(
    getPluginDataDir(config.dataRoot, "headless-sync"),
    "ob-home",
  ),
});

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

const app = express();

// Reject oversized requests by Content-Length before parsing.
app.use((req, res, next) => {
  const declared = Number(req.headers["content-length"]);

  if (Number.isFinite(declared) && declared > settings.get("maxBodyBytes")) {
    return res.status(413).json({ error: "Request body too large" });
  }

  next();
});

// The legacy file API has a configurable, much larger body ceiling. Native
// Sync is intentionally bounded to 4 MiB file payloads; parse it with its
// own 6 MiB wire limit BEFORE the legacy global JSON parser allocates RAM.
// This also bounds chunked requests with no Content-Length header.
app.use("/api/sync/v1", express.json({ limit: "6mb" }));
app.use("/api/sync/v1", (error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      code: "PAYLOAD_TOO_LARGE", error: "Sync request exceeds 6 MiB"
    });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({
      code: "INVALID_JSON", error: "Invalid Sync JSON payload"
    });
  }
  next(error);
});
app.use(express.json({ limit: settings.MAX_BODY_BACKSTOP }));
app.use(compression());

// logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  const origEnd = res.end;

  res.end = function (...args) {
    const duration = Date.now() - start;
    const status = res.statusCode;

    const color =
      status >= 500 ? ANSI_RED : status >= 400 ? ANSI_YELLOW : ANSI_GREEN;

    const path =
      req.originalUrl.length > 80
        ? req.originalUrl.slice(0, 80) + "..."
        : req.originalUrl;

    console.log(
      `${color}${req.method} ${status}${ANSI_RESET} ${path} (${duration}ms)`,
    );

    origEnd.apply(this, args);
  };

  next();
});

const fsRoutes = require("./routes/fs");
const vaultRoutes = require("./routes/vault");
const proxyRoutes = require("./routes/proxy");
const versionRoutes = require("./routes/version");
const settingsRoutes = require("./routes/settings");
const bootstrapRoutes = require("./routes/bootstrap");
const bootstrapCache = require("./cache");
const treeReconcile = require("./cache/reconcile");
const { createMetadataChannel } = require("./cache/metadata-channel");
const { registerCacheListeners } = require("./cache/listeners");
const vaultLifecycle = require("./vault/lifecycle");
const collaboration = require("./collab");
const { VaultSyncStore, permittedPath } = require("./sync/store");
const { createSyncRouter, registerSyncChannel } = require("./sync/http");
const { parseTailnetAccess, tailnetPrincipal } = require("./sync/tailnet-auth");
const { startDiscoveryFromEnv } = require("./sync/discovery");

// Opt-in until the surrounding Ignis HTTP API has authenticated access
// control. Keep this state in DATA_ROOT, never in a synced Vault.
const syncToken = process.env.IGNIS_SYNC_TOKEN;
const tailnetAccess = parseTailnetAccess(process.env.IGNIS_TAILNET_ACCESS);
if (tailnetAccess.size && process.env.IGNIS_BIND_HOST !== "127.0.0.1" &&
    process.env.IGNIS_BIND_HOST !== "::1") {
  throw new Error("Tailnet identity auth requires IGNIS_BIND_HOST=127.0.0.1 or ::1");
}
if (tailnetAccess.size && !syncToken) {
  throw new Error("Tailnet identity auth requires the Ignis Sync server to be enabled");
}
const syncStore = syncToken ? new VaultSyncStore({
  dataRoot: config.dataRoot,
  getVaultPath: config.getVaultPath,
  collaboration,
  writeCoalescer,
}) : null;
if (syncStore) {
  app.use("/api/sync/v1", createSyncRouter({
    store: syncStore, token: syncToken, tailnetAccess
  }));
}
let discoveryHandle = null;

// Secret-free invitation URL for mobile Obsidian. Opening an invite never
// changes a Vault; the Tailnet identity must have explicit access.
app.get("/join/:vaultId", (req, res) => {
  const login = tailnetPrincipal(req.headers, req.socket.remoteAddress,
    tailnetAccess, req.params.vaultId);
  const host = req.get("Host") || "";
  if (!login || !config.getVaultPath(req.params.vaultId) ||
      !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) {
    return res.status(404).type("text/plain").send("Connection link unavailable");
  }
  const invite = "https://" + host + "/join/" +
    encodeURIComponent(req.params.vaultId);
  const open = "obsidian://ignis-connector?link=" + encodeURIComponent(invite);
  res.set("Cache-Control", "no-store");
  res.type("html").send([
    '<!doctype html><html lang="en"><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Connect Obsidian to Ignis</title>',
    '<style>body{font:16px system-ui;margin:2rem auto;max-width:32rem;',
    'padding:0 1rem;background:#17171b;color:#f1f1f1;line-height:1.6}',
    'a{display:block;background:#815ae5;color:white;padding:1rem;',
    'border-radius:.7rem;text-align:center;text-decoration:none;font-weight:bold}',
    'code{overflow-wrap:anywhere;color:#d3c4ff}</style>',
    '<h1>Connect to Ignis</h1><p>Your Tailscale account can access ',
    '<strong>', req.params.vaultId, '</strong>. Review your connection in Obsidian.</p>',
    '<p><a href="', open, '">Open in Obsidian</a></p>',
    '<p>Or paste this into Ignis Connector settings:<br><code>',
    invite, '</code></p><p>No password or token is contained in this link.</p>',
    '</html>'
  ].join(""));
});

app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/ignis-offline-sw.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "assets", "ignis-offline-sw.js"));
});

app.use("/api/fs", fsRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/proxy", proxyRoutes);
app.use("/api/version", versionRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/plugins", pluginRoutes);
app.use("/api/bootstrap", bootstrapRoutes);

// Serve vault files for resource URLs (images, attachments, etc.)
// Vault ID is the first path segment: /vault-files/<vault-id>/path/to/file
app.use("/vault-files", (req, res, next) => {
  // Extract vault ID from the first path segment
  const parts = req.path.split("/").filter(Boolean);

  if (parts.length === 0) {
    return res.status(400).json({ error: "Missing vault ID" });
  }

  const vaultId = decodeURIComponent(parts[0]);
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  let resolved = null;

  try {
    const relPath = parts.slice(1).map(decodeURIComponent).join("/");
    resolved = relPath ? resolveVaultPath(vaultPath, relPath) : null;
  } catch {
    // resolved stays null and gets handled by static handler
  }

  const buffered = resolved ? writeCoalescer.getPending(resolved) : null;

  // Serve buffered content if exists.
  if (buffered) {
    const body = writeCoalescer.pendingBuffer(buffered.data, buffered.encoding);

    const ext = path.extname(resolved);

    if (ext) {
      res.type(ext);
    }

    return res.send(body);
  }

  // Rewrite req.url to strip the vault ID prefix, then serve statically
  req.url = "/" + parts.slice(1).join("/");
  express.static(vaultPath)(req, res, next);
});

app.get(["/", "/index.html"], (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(buildIndexHtml());
});

app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(REPO_ROOT, "images", "favicon.png"));
});

// Cache headers for static assets, by version query.
// Set before express.static, which only fills Cache-Control when it is not already present.
app.use((req, res, next) => {
  const cacheControl = cacheControlFor(req.path, !!req.query.v);

  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }

  next();
});

app.use(express.static(path.join(REPO_ROOT, "packages", "ui", "dist")));
app.use(express.static(path.join(REPO_ROOT, "packages", "shim", "dist")));

app.use(express.static(config.obsidianAssetsPath));

// Explicitly support loopback-only development instances. Keep the ordinary
// Ignis binding unchanged unless the operator selects a specific interface.
const listenArgs = process.env.IGNIS_BIND_HOST
  ? [config.port, process.env.IGNIS_BIND_HOST]
  : [config.port];
const server = app.listen(...listenArgs, async () => {
  console.log(`[ignis] Server running on http://localhost:${config.port}`);
  console.log(`[ignis] Vault root: ${config.vaultRoot}`);
  console.log(`[ignis] Vaults: ${Object.keys(config.vaults).join(", ")}`);

  if (syncStore) {
    // This does not authenticate the existing /api/fs and /ws endpoints.
    // Remote deployments must protect the entire Ignis origin at the proxy.
    console.log("[sync] Experimental Vault Sync enabled; protect the entire Ignis origin at the HTTPS reverse proxy");
    discoveryHandle = startDiscoveryFromEnv();
  }

  getObsidianTerms();

  await initPlugins({ app, config, wss, watcher });

  const bundledPluginDirs = getBundledPluginDirs();

  for (const { distDir } of bundledPluginDirs) {
    app.use(express.static(distDir));
  }

  await migratePluginsFromAllVaults(config.vaultRoot, [
    BRIDGE_PLUGIN_ID,
    ...bundledPluginDirs.map((d) => d.bundledPluginId),
  ]);

  bootstrapCache
    .warmUp()
    .catch((e) => console.warn("[bootstrap] warm-up error:", e.message));
});

const wss = setupWebSocket(server, {
  getVaultPath: config.getVaultPath,
  originAllowlist: settings.get("wsOrigins"),
  authorizeConnection: (req, vaultId) => {
    const login = tailnetPrincipal(req.headers, req.socket.remoteAddress,
      tailnetAccess, vaultId);
    // A trusted local reverse proxy marks Tailnet-only WS connections.
    // Legacy loopback /ws access retains its original behavior.
    if (!login) return req.headers["x-ignis-tailnet-only"] === "1" ? false : null;
    const device = syncStore?.ensureTailnetDevice(login, vaultId, syncToken);
    return device ? { login, deviceId: device.deviceId } : false;
  },
  // A live CRDT room, not the conventional file watcher, owns the note body.
  // Metadata listeners are still notified independently.
  filterFileEvent: (vaultId, event) => !(
    event.type === "modified" && collaboration.getActive(vaultId, event.path)
  ),
});
collaboration.register({
  wss,
  getVaultPath: config.getVaultPath,
  dataRoot: config.dataRoot,
  writeCoalescer,
  resolveDocumentId: syncStore ? (vaultId, relPath, historicId) =>
    syncStore.ensureDocumentId(vaultId, relPath, historicId) : undefined,
  onPersist: syncStore ? (vaultId, relPath, documentId, digest, byteLength) =>
    syncStore.recordCollaborationSave(vaultId, relPath, documentId, digest, byteLength) : undefined,
});
if (syncStore) {
  registerSyncChannel(wss, syncStore, { token: syncToken, tailnetAccess });
  const scanTimers = new Map();
  watcher.addGlobalListener((vaultId, event) => {
    if (!permittedPath(event.path)) return;
    clearTimeout(scanTimers.get(vaultId));
    const timer = setTimeout(() => {
      scanTimers.delete(vaultId);
      syncStore.scan(vaultId).catch((e) =>
        console.warn("[sync] Vault refresh:", e.message));
    }, 400);
    timer.unref?.();
    scanTimers.set(vaultId, timer);
  });
}
vaultLifecycle.setWss(wss);

const metadataChannel = createMetadataChannel(wss);

registerCacheListeners({
  bootstrapCache,
  metadataChannel,
  watcher,
  writeCoalescer,
});

watcher.onWatcherStart((vaultId) => {
  bootstrapCache.markForRevalidation(vaultId);
  treeReconcile.startSchedule(vaultId);
});

bootstrapCache.onStaleEntryServed((vaultId) =>
  treeReconcile.scheduleReconcile(vaultId),
);

// Per-client listeners die along with their watcher.
watcher.onWatcherRebuild((vaultId) => {
  // force revalidation to ensure any missed changes are picked up
  bootstrapCache.invalidateVault(vaultId);
  wss.closeVaultSockets(vaultId);
});

writeCoalescer.onFlushGiveUp((absPath) => {
  const match = config.vaultForPath(absPath);

  if (!match) {
    return;
  }

  wss.broadcastToVault(match.vaultId, {
    type: "write-giveup",
    path: match.relPath,
  });
});

async function gracefulShutdown(signal) {
  discoveryHandle?.stop();
  console.log(`\n[ignis] Received ${signal}, shutting down gracefully...`);

  await collaboration.flushAll();
  await flushAll();
  await shutdownPlugins();

  server.close(() => {
    console.log("[ignis] Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[ignis] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
