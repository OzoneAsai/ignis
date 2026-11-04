// Shared HTTPS/WSS surface: one transport on desktop and Obsidian Mobile.
// WSS notifications deliberately do not replace the durable SQLite cursor.
const crypto = require("node:crypto");
const express = require("express");

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSyncRouter({ store, token }) {
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
      supported: ["manifest", "changes", "conditional-text", "conditional-binary-4MiB", "file-identity"],
      auth: "scoped-device-token",
      experimental: true });
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

  router.use("/vaults/:vaultId", (req, res, next) => {
    const match = /^Bearer (ignis_dev_[A-Za-z0-9_-]{43})$/.exec(
      req.get("Authorization") || ""
    );
    const device = match && store.authenticateDevice(match[1], req.params.vaultId);
    if (!device) {
      return res.status(401).json({ code: "UNAUTHORIZED", error: "Device authorization required" });
    }
    req.ignisSyncDevice = device;
    next();
  });
  router.get("/vaults/:vaultId/session", (req, res) => {
    const device = req.ignisSyncDevice;
    res.json({ deviceId: device.deviceId, vaultId: device.vaultId, label: device.label });
  });
  router.get("/vaults/:vaultId/manifest", route(async (req, res) => {
    res.json(await store.scan(req.params.vaultId));
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
  router.get("/vaults/:vaultId/operations/:opId", route((req, res) => {
    const receipt = store.operationReceipt(req.params.vaultId, req.params.opId);
    if (!receipt) return res.status(404).json({
      code: "OPERATION_NOT_FOUND", error: "Operation not recorded"
    });
    res.json(receipt);
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

function registerSyncChannel(wss, store) {
  const authorized = new WeakMap();
  const peers = new Set();
  const channel = wss.channel("sync");
  channel.on("auth", (msg, ws) => {
    const device = store.authenticateDevice(msg.token, ws.ignisVaultId);
    if (!device || authorized.has(ws)) {
      ws.send(JSON.stringify({ channel: "sync", type: "auth-error", code: "UNAUTHORIZED" }));
      ws.close(4003, "Sync authorization failed");
      return;
    }
    authorized.set(ws, device.deviceId);
    peers.add(ws);
    ws.send(JSON.stringify({ channel: "sync", type: "ready",
      vaultId: ws.ignisVaultId, deviceId: device.deviceId,
      vaultSeq: store.head(ws.ignisVaultId) }));
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
