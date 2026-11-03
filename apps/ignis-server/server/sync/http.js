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
      supported: ["manifest", "changes", "conditional-text", "file-identity"],
      experimental: true });
  });
  router.use((req, res, next) => {
    if (!secureEqual(req.get("Authorization"), "Bearer " + token)) {
      return res.status(401).json({ code: "UNAUTHORIZED", error: "Sync authentication required" });
    }
    next();
  });
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

function registerSyncChannel(wss, store, token) {
  const authorized = new WeakSet();
  const peers = new Set();
  const channel = wss.channel("sync");
  channel.on("auth", (msg, ws) => {
    if (!secureEqual(msg.token, token)) {
      ws.send(JSON.stringify({ channel: "sync", type: "auth-error", code: "UNAUTHORIZED" }));
      ws.close(4003, "Sync authorization failed");
      return;
    }
    authorized.add(ws);
    peers.add(ws);
    ws.send(JSON.stringify({ channel: "sync", type: "ready",
      vaultId: ws.ignisVaultId, vaultSeq: store.head(ws.ignisVaultId) }));
  });
  channel.on("resume", (msg, ws) => {
    if (!authorized.has(ws)) {
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
        ws.send(JSON.stringify({ channel: "sync", type: "changed",
          vaultSeq: event.seq }));
      }
    }
  });
  wss.on("connection", (ws) => ws.on("close", () => peers.delete(ws)));
  wss.on("close", detach);
}

module.exports = { secureEqual, createSyncRouter, registerSyncChannel };
