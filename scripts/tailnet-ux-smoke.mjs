// Read-only HTTPS/WSS smoke for a real Tailscale Serve identity; no token.
// Usage: IGNIS_JOIN_URL=https://host:8452/join/VaultID node scripts/tailnet-ux-smoke.mjs
import assert from "node:assert/strict";
import WebSocket from "ws";

const raw = process.env.IGNIS_JOIN_URL;
if (!raw) throw new Error("Set IGNIS_JOIN_URL to an HTTPS /join/VaultID link");
const link = new URL(raw);
assert.equal(link.protocol, "https:");
assert.equal(link.search, "");
assert.equal(link.hash, "");
assert.equal(link.username, "");
assert.equal(link.password, "");
const match = /^\/join\/([A-Za-z0-9._-]+)$/.exec(link.pathname);
assert.ok(match, "Expected a secret-free /join/VaultID link");
const vaultId = match[1];
const base = link.origin;
const get = (url) => fetch(url, { signal: AbortSignal.timeout(7000) });

const discover = await get(base + "/api/sync/v1/link");
assert.equal(discover.status, 200, "Tailnet Vault discovery");
const visible = await discover.json();
assert.equal(visible.auth, "tailnet");
assert.ok(visible.vaults.includes(vaultId));
const sessionResult = await get(base + "/api/sync/v1/vaults/" + vaultId + "/session");
assert.equal(sessionResult.status, 200, "Tokenless HTTPS Vault session");
const session = await sessionResult.json();
assert.equal(session.auth, "tailnet");
assert.equal(session.vaultId, vaultId);
assert.equal(typeof session.deviceId, "string");
assert.equal(session.token, undefined, "Never expose a bearer token");
const invite = await get(link.href);
assert.equal(invite.status, 200);
const html = await invite.text();
assert.ok(html.includes("obsidian://ignis-connector?link="));
assert.ok(!html.includes("ignis_dev_"));
for (const path of [
  "/api/fs",
  "/api/sync/v1/admin/vaults/" + vaultId + "/devices"
]) {
  const denied = await get(base + path);
  assert.equal(denied.status, 404, "Private gateway must reject " + path);
}

const wsUrl = new URL(base);
wsUrl.protocol = "wss:";
wsUrl.pathname = "/ws";
wsUrl.searchParams.set("vault", vaultId);
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error("WSS tokenless authentication timed out"));
  }, 8000);
  socket.on("open", () => socket.send(JSON.stringify({
    channel: "sync", type: "auth"
  })));
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(String(data));
      if (message.channel !== "sync") return;
      if (message.type === "ready") {
        assert.equal(message.vaultId, vaultId);
        assert.equal(message.deviceId, session.deviceId);
        socket.send(JSON.stringify({ channel: "sync", type: "resume", since: 0 }));
      }
      if (message.type === "changes") {
        assert.ok(Array.isArray(message.changes));
        clearTimeout(timer);
        socket.close();
        resolve();
      }
      if (message.type === "auth-error") {
        clearTimeout(timer);
        socket.close();
        reject(new Error("WSS identity not authorized"));
      }
    } catch (error) {
      clearTimeout(timer);
      socket.close();
      reject(error);
    }
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  socket.on("close", (code) => {
    if (code !== 1000 && code !== 1005) {
      clearTimeout(timer);
      reject(new Error("WSS disconnected before success: " + code));
    }
  });
});
console.log("PASS: invite, Tailnet Vault discovery, tokenless HTTP/WSS and scoped gateway");
