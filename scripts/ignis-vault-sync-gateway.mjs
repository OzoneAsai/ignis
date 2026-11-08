#!/usr/bin/env node
// A one-Vault transport boundary for a private cross-machine IGNIS pilot.
// Bind to Tailnet on the Mac and loopback on Windows. This gateway never
// proxies the server's unauthenticated generic files, settings or admin API.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function scopedRequest(rawUrl, method, vaultId, upgrade = false) {
  if (typeof rawUrl !== "string" || typeof vaultId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(vaultId) ||
      rawUrl.includes("#") || rawUrl.includes(String.fromCharCode(92)) ||
      /%2f|%5c|%2e/i.test(rawUrl)) return false;
  let uri;
  try { uri = new URL(rawUrl, "http://localhost"); }
  catch { return false; }
  if (upgrade) {
    return method === "GET" && uri.pathname === "/ws" &&
      uri.searchParams.get("vault") === vaultId &&
      [...uri.searchParams.keys()].length === 1;
  }
  if (method === "GET" && uri.pathname === "/api/sync/v1/capabilities" &&
      !uri.search) return true;
  const prefix = "/api/sync/v1/vaults/" + vaultId + "/";
  if (!uri.pathname.startsWith(prefix)) return false;
  const suffix = uri.pathname.slice(prefix.length);
  if (method === "GET") {
    return ["session", "manifest", "changes"].includes(suffix) ||
      /^files\/[a-f0-9-]{36}$/.test(suffix) ||
      /^operations\/[a-zA-Z0-9_-]{8,128}$/.test(suffix);
  }
  return method === "POST" && suffix === "operations";
}

export function allowsPeer(remoteAddress, allowedPeer) {
  const normalized = String(remoteAddress || "").replace(/^::ffff:/, "");
  return normalized === allowedPeer;
}

export function parseGatewayArguments(argv) {
  const pairs = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") ||
        pairs.has(key)) throw new Error("Malformed gateway options");
    pairs.set(key, value);
  }
  const fields = {
    listenHost: pairs.get("--listen-host"),
    listenPort: Number(pairs.get("--listen-port")),
    targetHost: pairs.get("--target-host"),
    targetPort: Number(pairs.get("--target-port")),
    peer: pairs.get("--peer"),
    vault: pairs.get("--vault"),
  };
  if (pairs.size !== 6 || net.isIP(fields.listenHost) !== 4 ||
      net.isIP(fields.targetHost) !== 4 || net.isIP(fields.peer) !== 4 ||
      ![fields.listenPort, fields.targetPort].every((p) =>
        Number.isInteger(p) && p >= 1024 && p <= 65535) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fields.vault || "")) {
    throw new Error("Required: listen-host/port, target-host/port, peer, vault");
  }
  return fields;
}

function proxyHeaders(input, targetHost, targetPort) {
  const headers = { ...input };
  for (const name of ["host", "connection", "proxy-connection",
    "keep-alive", "te", "trailer", "upgrade"]) delete headers[name];
  headers.host = targetHost + ":" + targetPort;
  return headers;
}

export function createGateway(settings) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (!allowsPeer(req.socket.remoteAddress, settings.peer) ||
        !scopedRequest(req.url, req.method, settings.vault)) {
      res.writeHead(403);
      res.end("Only the selected IGNIS Vault Sync route is permitted");
      return;
    }
    const proxy = http.request({
      host: settings.targetHost, port: settings.targetPort,
      method: req.method, path: req.url,
      headers: proxyHeaders(req.headers,
        settings.targetHost, settings.targetPort),
      timeout: 20000,
    }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("timeout", () => proxy.destroy(new Error("Upstream timed out")));
    proxy.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("IGNIS Sync temporarily unavailable");
    });
    req.pipe(proxy);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!allowsPeer(socket.remoteAddress, settings.peer) ||
        !scopedRequest(req.url, req.method, settings.vault, true)) {
      socket.destroy();
      return;
    }
    const target = net.connect({
      host: settings.targetHost, port: settings.targetPort,
    }, () => {
      const lines = ["GET " + req.url + " HTTP/1.1"];
      for (const [name, value] of Object.entries(proxyHeaders(req.headers,
        settings.targetHost, settings.targetPort))) {
        if (value === undefined) continue;
        lines.push(name + ": " + (Array.isArray(value) ? value.join(", ") : value));
      }
      // Restore Connection/Upgrade exactly for the trusted WS upstream.
      lines.push("Connection: Upgrade", "Upgrade: websocket", "", "");
      target.write(lines.join("\r\n"));
      if (head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
    target.on("close", () => socket.destroy());
    socket.on("close", () => target.destroy());
  });
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseGatewayArguments(process.argv.slice(2));
    const gate = createGateway(options);
    gate.server.listen(options.listenPort, options.listenHost, () => {
      console.log("IGNIS_SCOPED_GATEWAY_READY=" +
        options.listenHost + ":" + options.listenPort +
        " (one Vault, one client)");
    });
    let stopping = false;
    async function stop() {
      if (stopping) return;
      stopping = true;
      await gate.close();
      process.exitCode = 0;
    }
    process.on("SIGTERM", () => { void stop(); });
    process.on("SIGINT", () => { void stop(); });
  } catch (e) {
    console.error("Gateway configuration rejected: " + e.message);
    process.exitCode = 1;
  }
}
