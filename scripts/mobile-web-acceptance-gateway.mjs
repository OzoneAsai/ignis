// Single-lab browser gateway for iPhone/Android acceptance.
// The backend retains loopback-only binding, and both HTTP and WebSocket are
// gated by the same random cookie. Do not point at a production Vault.
import { createServer } from "node:http";
import { connect } from "node:net";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";

const expectedEnv = process.env.IGNIS_MOBILE_LAB_GATEWAY === "1";
if (!expectedEnv) throw new Error("Explicit test-only opt-in required");
const backendPort = 3220;
const gatewayPort = 3221;
const chosenIps = Object.values(networkInterfaces()).flat().filter((i) =>
  i?.family === "IPv4" && !i.internal && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address)
).map((i) => i.address);
if (chosenIps.length !== 1) throw new Error("Expected one Tailnet IPv4 address");
const tailnetIp = chosenIps[0];
const privatePath = process.env.IGNIS_MOBILE_GATEWAY_SESSION;
if (!privatePath || existsSync(privatePath)) throw new Error("Need new private session path");
const password = randomBytes(36).toString("base64url");
const cookieValue = randomBytes(36).toString("base64url");
const knownHosts = new Set([`127.0.0.1:${gatewayPort}`,`${tailnetIp}:${gatewayPort}`]);
function secureEqual(received, actual) {
  if (typeof received !== "string") return false;
  const x = createHash("sha256").update(received).digest();
  const y = createHash("sha256").update(actual).digest();
  return timingSafeEqual(x, y);
}
function allowed(req) {
  if (!knownHosts.has(req.headers.host)) return false;
  const entry = (req.headers.cookie || "").split(";")
    .map((s) => s.trim()).find((s) => s.startsWith("ignis_lab="));
  return secureEqual(entry?.slice("ignis_lab=".length), cookieValue);
}
const targetHost = "127.0.0.1";
const servers = [];
const requestHandler = (req, res) => {
  const path = (req.url || "").split("?")[0];
  if (!knownHosts.has(req.headers.host)) {
    res.writeHead(421).end("Unrecognized test origin"); return;
  }
  if (path === "/__ignis_mobile_login/" + password && req.method === "GET") {
    res.writeHead(302, {
      "Set-Cookie": `ignis_lab=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=21600`,
      "Location": "/",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    }).end(); return;
  }
  if (!allowed(req)) {
    res.writeHead(401, { "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8" }).end("Private IGNIS mobile acceptance lab"); return;
  }
  const out = (awaitImportHttp()).request({
    hostname: targetHost, port: backendPort, method: req.method,
    path: req.url, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
  }, (upstream) => {
    res.writeHead(upstream.statusCode ?? 502,
      Object.fromEntries(Object.entries(upstream.headers).filter(([k]) => k !== "set-cookie")));
    upstream.pipe(res);
  });
  out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(out);
};
// Re-use the built-in HTTP library without dynamic network module imports.
import * as http from "node:http";
function awaitImportHttp() { return http; }
function onUpgrade(req, socket, head) {
  if (!allowed(req)) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
  const upstream = connect(backendPort, targetHost);
  upstream.on("connect", () => {
    const headers = Object.entries({
      ...req.headers, host: `127.0.0.1:${backendPort}`,
      connection: "Upgrade", upgrade: "websocket",
    }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}
const sessions = [
  { address: "127.0.0.1", port: gatewayPort },
  { address: tailnetIp, port: gatewayPort },
];
writeFileSync(privatePath, JSON.stringify({
  loginPath: "/__ignis_mobile_login/" + password,
  gatewayPort, tailnetIp, backendPort, createdAt: new Date().toISOString(),
}, null, 2), { flag: "wx", mode: 0o600 });
for (const { address, port } of sessions) {
  await new Promise((resolve, reject) => {
    const server = createServer(requestHandler);
    server.on("upgrade", onUpgrade);
    server.listen(port, address);
    server.once("error", reject);
    server.once("listening", () => { servers.push(server); resolve(); });
  });
}
console.log("IGNIS_MOBILE_GATEWAY_READY_LOOPBACK_AND_TAILNET");
console.log("BACKEND=127.0.0.1:3220 GATEWAY_PORT=3221");
console.log("SESSION_SECRET_FILE_MODE_0600");
