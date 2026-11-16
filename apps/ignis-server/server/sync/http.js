// Shared HTTPS/WSS surface: one transport on desktop and Obsidian Mobile.
// WSS notifications deliberately do not replace the durable SQLite cursor.
const crypto = require("node:crypto");
const express = require("express");
const { tailnetPrincipal, authorizedVaults } = require("./tailnet-auth");
const {
  normalizeMediaBypassExtensions,
} = require("../../../../packages/sync-policy/src/media-bypass");

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSyncRouter({ store, token, tailnetAccess = new Map() }) {
  if (typeof token !== "string" || Buffer.byteLength(token) < 32) {
    throw new Error("IGNIS_SYNC_TOKEN must have at least 32 bytes");
  }
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/capabilities", (_req, res) => {
    res.json({ protocol: "ignis-sync/1", transport: ["https", "wss"],
      supported: ["manifest", "changes", "conditional-text",
        ...(store.contentScope.mode === "all" ||
          (store.db.prepare(
            "SELECT COUNT(*) AS count FROM vault_sync_media_bypass WHERE extensions_json <> '[]'"
          ).get().count > 0) ||
          [...store.contentScopeOverrides.values()].some((scope) => scope.mode === "all")
          ? ["conditional-binary-4MiB"] : []),
        "file-identity"],
      contentScope: store.contentScope.mode,
      scopedByVault: store.contentScopeOverrides.size > 0,
      auth: tailnetAccess.size ? ["scoped-device-token", "tailscale-serve"] :
        ["scoped-device-token"],
      experimental: true });
  });
  router.get("/link", (req, res) => {
    const login = tailnetPrincipal(req.headers, req.socket.remoteAddress, tailnetAccess);
    if (!login) {
      return res.status(401).json({ code: "IDENTITY_REQUIRED",
        error: "Open this server through Tailscale Serve to discover your Vaults" });
    }
    res.json({ auth: "tailnet", vaults: authorizedVaults(tailnetAccess, login)
      .filter((id) => !!store.getVaultPath(id)) });
  });
  function adminOnly(req, res, next) {
    if (!secureEqual(req.get("Authorization"), "Bearer " + token)) {
      return res.status(401).json({ code: "UNAUTHORIZED", error: "Administrator authorization required" });
    }
    next();
  }
  function route(fn) {
    return (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
      const status = e.status || (e.code === "ENOENT" ? 404 : 500);
      // Do not expose absolute paths and server error internals to a client.
      res.status(status).json({
        code: status === 500 ? "SYNC_ERROR" : (e.code || "SYNC_ERROR"),
        error: status === 500 ? "Sync operation failed" : e.message
      });
      if (status === 500) console.warn("[sync] route:", e);
    });
  }

  // Only the server owner may enroll/revoke devices. The bootstrap token
  // never authorizes ordinary Vault synchronization and is never handed to
  // native Obsidian; each device has one random secret scoped to one Vault.
  router.get("/admin/vaults/:vaultId/devices", adminOnly, route((req, res) => {
    res.json({ devices: store.listDevices(req.params.vaultId) });
  }));
  router.post("/admin/vaults/:vaultId/devices", adminOnly, route((req, res) => {
    const enrolled = store.enrollDevice(req.params.vaultId, req.body?.label);
    res.status(201).json(enrolled);
  }));
  router.delete("/admin/devices/:deviceId", adminOnly, route((req, res) => {
    if (!store.revokeDevice(req.params.deviceId)) {
      return res.status(404).json({ code: "NOT_FOUND", error: "Device not found" });
    }
    res.status(204).end();
  }));
  router.get("/admin/vaults/:vaultId/content-scope", adminOnly, route((req, res) => {
    const desired = req.query.mode;
    if (desired !== undefined && !["all", "markdown-only"].includes(desired)) {
      return res.status(400).json({
        code: "INVALID_CONTENT_SCOPE",
        error: "Preview mode must be all or markdown-only",
      });
    }
    res.json(store.previewContentScope(req.params.vaultId, desired || null));
  }));
  router.get("/admin/vaults/:vaultId/media-bypass", adminOnly, route((req, res) => {
    const raw = req.query.extensions;
    let proposed = null;
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.length > 300) {
        return res.status(400).json({
          code: "INVALID_BYPASS_EXTENSIONS", error: "Invalid preview extension list",
        });
      }
      try { proposed = normalizeMediaBypassExtensions(
        raw ? raw.split(",") : []
      ); } catch {
        return res.status(400).json({
          code: "INVALID_BYPASS_EXTENSIONS",
          error: "Choose supported media extensions",
        });
      }
    }
    res.json(store.previewMediaBypass(req.params.vaultId, proposed));
  }));
  router.put("/admin/vaults/:vaultId/media-bypass", adminOnly, route(async (req, res) => {
    let requested, expected;
    try {
      requested = normalizeMediaBypassExtensions(req.body?.extensions);
      expected = normalizeMediaBypassExtensions(req.body?.expectedExtensions);
    } catch {
      return res.status(400).json({
        code: "INVALID_BYPASS_EXTENSIONS",
        error: "Choose supported document/media extensions",
      });
    }
    res.json(await store.setMediaBypass(req.params.vaultId, requested, expected));
  }));
  router.put("/admin/vaults/:vaultId/content-scope", adminOnly, route(async (req, res) => {
    const { contentScope, expectedScope } = req.body || {};
    if (!["all", "markdown-only"].includes(contentScope) ||
        !["all", "markdown-only"].includes(expectedScope)) {
      return res.status(400).json({
        code: "INVALID_CONTENT_SCOPE",
        error: "Provide contentScope and expectedScope: all or markdown-only",
      });
    }
    res.json(await store.setContentScope(req.params.vaultId,
      contentScope, expectedScope));
  }));
  router.get("/admin/vaults/:vaultId/media-preflight", adminOnly, route(async (req, res) => {
    const requested = req.query.root;
    const roots = typeof requested === "string" ? [requested] :
      Array.isArray(requested) && requested.every((x) => typeof x === "string")
        ? requested : [];
    if (!roots.length || roots.length > 8) {
      return res.status(400).json({
        code: "INVALID_MEDIA_ROOTS", error: "Supply one to eight media root paths",
      });
    }
    try {
      const report = await store.preflightMediaOwnership(req.params.vaultId, roots);
      res.json(report);
    } catch (error) {
      if (error instanceof Error && /Invalid|root|Overlapping|path/.test(error.message)) {
        return res.status(400).json({
          code: "INVALID_MEDIA_ROOTS", error: "Invalid media synchronization roots",
        });
      }
      throw error;
    }
  }));

  router.use("/vaults/:vaultId", (req, res, next) => {
    const match = /^Bearer (ignis_dev_[A-Za-z0-9_-]{43})$/.exec(
      req.get("Authorization") || ""
    );
    const login = tailnetPrincipal(req.headers, req.socket.remoteAddress,
      tailnetAccess, req.params.vaultId);
    const device = match ? store.authenticateDevice(match[1], req.params.vaultId) :
      login ? store.ensureTailnetDevice(login, req.params.vaultId, token) : null;
    if (!device) {
      return res.status(401).json({ code: "UNAUTHORIZED", error: "Device authorization required" });
    }
    req.ignisSyncDevice = device;
    req.ignisSyncAuth = login && !match ? "tailnet" : "device";
    // The request's body and opId remain byte-for-byte compatible with old
    // operation receipts. A separate precondition header allows upgraded
    // Connectors to prevent commits to a replacement journal even when the
    // server changes between a manifest check and an outgoing POST.
    const expectedLineage = req.get("X-Ignis-Journal-Lineage");
    if (req.method !== "GET" && expectedLineage &&
        expectedLineage !== store.journalLineage(req.params.vaultId)) {
      return res.status(409).json({ code: "JOURNAL_LINEAGE_MISMATCH",
        error: "Server Sync history changed; local operations must be reviewed" });
    }
    const checkpointSeq = req.get("X-Ignis-Journal-Cursor");
    const checkpointProof = req.get("X-Ignis-Journal-Proof");
    if (req.method !== "GET" &&
        (checkpointSeq !== undefined || checkpointProof !== undefined)) {
      const seq = Number(checkpointSeq);
      if (!expectedLineage || checkpointSeq === undefined ||
          !/^(0|[1-9][0-9]*)$/.test(checkpointSeq) ||
          !Number.isSafeInteger(seq) ||
          typeof checkpointProof !== "string" ||
          !/^[a-f0-9]{64}$/.test(checkpointProof)) {
        return res.status(400).json({code:"INVALID_CHECKPOINT",
          error:"A complete valid Sync history checkpoint is required"});
      }
      // The client can remain behind unrelated editors without losing write
      // access; the exact former operation, not the latest server HEAD, is
      // the CAS condition. This closes a restore/catch-up race between a
      // client's manifest verification and a delayed outgoing write.
      if (store.journalCheckpoint(req.params.vaultId,seq).proof !== checkpointProof) {
        return res.status(409).json({code:"JOURNAL_CHECKPOINT_MISMATCH",
          error:"Server Sync history differs from a previously verified checkpoint"});
      }
    }
    next();
  });
  router.get("/vaults/:vaultId/session", (req, res) => {
    const device = req.ignisSyncDevice;
    res.json({ deviceId: device.deviceId, vaultId: device.vaultId,
      label: device.label, auth: req.ignisSyncAuth,
      journalLineage: store.journalLineage(device.vaultId),
      contentScope: store.contentScopeFor(device.vaultId),
      mediaBypassExtensions: store.mediaBypassFor(device.vaultId) });
  });
  router.get("/vaults/:vaultId/manifest", route(async (req, res) => {
    res.json(await store.scan(req.params.vaultId));
  }));
  router.get("/vaults/:vaultId/checkpoint", route(async (req, res) => {
    const seq = Number(req.query.seq);
    if (!Number.isSafeInteger(seq) || seq < 0 || req.query.seq === undefined) {
      return res.status(400).json({code:"INVALID_CURSOR",error:"Invalid checkpoint sequence"});
    }
    // A read-only indexed witness for the exact historical frontier already
    // acknowledged by this client. Do not advance, rescan or mutate a Vault
    // when another client is verifying continuity before replaying writes.
    res.json(store.journalCheckpoint(req.params.vaultId, seq));
  }));
  router.get("/vaults/:vaultId/changes", route(async (req, res) => {
    const since = Number(req.query.since ?? 0);
    const limit = Number(req.query.limit ?? 200);
    if (!Number.isSafeInteger(since) || since < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return res.status(400).json({ code: "INVALID_CURSOR", error: "Invalid cursor or limit" });
    }
    await store.scan(req.params.vaultId);
    res.json(store.changes(req.params.vaultId, since, limit));
  }));
  router.get("/vaults/:vaultId/operations/:opId", route(async (req, res) => {
    await store.recover(req.params.vaultId);
    const receipt = store.operationReceipt(req.params.vaultId, req.params.opId);
    if (!receipt) return res.status(404).json({
      code: "OPERATION_NOT_FOUND", error: "Operation not recorded"
    });
    await store.retireCommittedCreateMarker(req.params.vaultId, req.params.opId);
    res.json(receipt);
  }));
  router.post("/vaults/:vaultId/operations/:opId/abandon", route(async (req, res) => {
    res.json(await store.abandonOperation(req.params.vaultId, req.params.opId));
  }));
  router.get("/vaults/:vaultId/files/:fileId", route(async (req, res) => {
    const result = await store.read(req.params.vaultId, req.params.fileId);
    res.setHeader("X-Ignis-File-Hash", result.file.hash);
    res.setHeader("X-Ignis-Generation", result.file.generation_id);
    res.type("application/octet-stream").send(result.bytes);
  }));
  router.post("/vaults/:vaultId/operations", route(async (req, res) => {
    const result = await store.apply(req.params.vaultId, req.body);
    res.json(result);
  }));
  return router;
}

function registerSyncChannel(wss, store, { token, tailnetAccess = new Map() } = {}) {
  const authorized = new WeakMap();
  const peers = new Set();
  const channel = wss.channel("sync");
  channel.on("auth", (msg, ws) => {
    const login = ws.ignisTailnetLogin;
    const device = typeof msg.token === "string" && msg.token ?
      store.authenticateDevice(msg.token, ws.ignisVaultId) :
      login && tailnetAccess.get(login)?.has(ws.ignisVaultId) ?
        store.ensureTailnetDevice(login, ws.ignisVaultId, token) : null;
    if (!device || authorized.has(ws)) {
      ws.send(JSON.stringify({ channel: "sync", type: "auth-error", code: "UNAUTHORIZED" }));
      ws.close(4003, "Sync authorization failed");
      return;
    }
    authorized.set(ws, device.deviceId);
    ws.ignisSyncAuthorized = true;
    peers.add(ws);
    ws.send(JSON.stringify({ channel: "sync", type: "ready",
      vaultId: ws.ignisVaultId, deviceId: device.deviceId,
      vaultSeq: store.head(ws.ignisVaultId),
      journalLineage: store.journalLineage(ws.ignisVaultId) }));
  });
  channel.on("resume", (msg, ws) => {
    if (!store.deviceActive(authorized.get(ws), ws.ignisVaultId)) {
      ws.close(4003, "Sync authentication required");
      return;
    }
    const since = msg.since;
    if (!Number.isSafeInteger(since) || since < 0) {
      ws.send(JSON.stringify({ channel: "sync", type: "error", code: "INVALID_CURSOR" }));
      return;
    }
    ws.send(JSON.stringify({
      channel: "sync", type: "changes",
      ...store.changes(ws.ignisVaultId, since, 200)
    }));
  });
  const detach = store.onChange((event) => {
    for (const ws of peers) {
      if (ws.ignisVaultId === event.vaultId && ws.readyState === ws.OPEN) {
        if (!store.deviceActive(authorized.get(ws), event.vaultId)) {
          ws.close(4003, "Device revoked");
          continue;
        }
        ws.send(JSON.stringify({ channel: "sync", type: "changed",
          vaultSeq: event.seq }));
      }
    }
  });
  const stopRevocation = store.onRevoke((deviceId) => {
    // Close even a newly connected Tailnet socket that has not yet sent its
    // sync.auth frame. Its authenticated identity was fixed at WS upgrade.
    for (const ws of wss.clients || []) {
      if (ws.ignisTailnetDevice === deviceId) ws.close(4003, "Access revoked");
    }
    for (const ws of peers) {
      if (authorized.get(ws) === deviceId) ws.close(4003, "Device revoked");
    }
  });
  wss.on("connection", (ws) => ws.on("close", () => peers.delete(ws)));
  wss.on("close", () => {
    detach();
    stopRevocation();
  });
}

module.exports = { secureEqual, createSyncRouter, registerSyncChannel };
