import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store");
const { createSyncRouter } = require("./http");
const { parseTailnetAccess, tailnetPrincipal } = require("./tailnet-auth");
const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-tailnet-"));
  for (const dir of ["IOSLab", "PrivateVault"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const store = new VaultSyncStore({
    dataRoot: root,
    getVaultPath: (name) => ["IOSLab", "PrivateVault"].includes(name) ?
      path.join(root, name) : null,
    collaboration: {
      peekDocumentId: () => null, getActive: () => null,
      isCollaborative: () => false, checkLivePath: () => {}
    },
    writeCoalescer: { flushPending: async () => {} }
  });
  fixtures.push({ root, store });
  return { store, root };
}
afterEach(() => {
  for (const { store, root } of fixtures.splice(0)) {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("one Tailnet identity boundary for HTTP and WebSocket", () => {
  const accessJSON = JSON.stringify({
    "user@example.com": ["IOSLab"],
    "other@example.com": ["PrivateVault"]
  });

  it("denies wildcard and malformed policies instead of silently widening access", () => {
    for (const raw of [
      "[]", "null", '{"*":["IOSLab"]}', '{"User@example.com":["IOSLab"]}',
      '{"user@example.com":[]}', '{"user@example.com":["../secrets"]}'
    ]) {
      expect(() => parseTailnetAccess(raw)).toThrow();
    }
    expect(parseTailnetAccess("").size).toBe(0);
    const access = parseTailnetAccess(accessJSON);
    expect(tailnetPrincipal({ "tailscale-user-login": "User@example.com" },
      "127.0.0.1", access, "IOSLab")).toBe("user@example.com");
    for (const [headers, ip, vault] of [
      [{ "tailscale-user-login": "user@example.com" }, "10.0.0.1", "IOSLab"],
      [{ "tailscale-user-login": "user@example.com" }, "127.0.0.1", "PrivateVault"],
      [{ "tailscale-user-login": "stranger@example.com" }, "127.0.0.1", "IOSLab"],
      [{ "tailscale-user-login": ["user@example.com"] }, "127.0.0.1", "IOSLab"],
      [{}, "127.0.0.1", "IOSLab"]
    ]) {
      expect(tailnetPrincipal(headers, ip, access, vault)).toBeNull();
    }
  });

  it("keeps a durable, revocable server-side identity without disclosing a token", () => {
    const { store } = fixture();
    const first = store.ensureTailnetDevice("user@example.com", "IOSLab", "s".repeat(48));
    expect(first).toEqual({
      deviceId: expect.any(String), vaultId: "IOSLab",
      label: "Tailnet user@example.com"
    });
    expect(first).not.toHaveProperty("token");
    const again = store.ensureTailnetDevice("user@example.com", "IOSLab", "s".repeat(48));
    expect(again).toEqual(first);
    expect(store.listDevices("IOSLab")).toHaveLength(1);
    expect(store.authenticateDevice("ignis_dev_" + "a".repeat(43), "IOSLab")).toBeNull();
    expect(store.revokeDevice(first.deviceId)).toBe(true);
    expect(store.ensureTailnetDevice("user@example.com", "IOSLab", "s".repeat(48)))
      .toBeNull();
  });

  it("discovers only permitted Vaults and requires identity for requests", async () => {
    const { store } = fixture();
    const app = express();
    app.use("/api/sync/v1", createSyncRouter({
      store, token: "s".repeat(48), tailnetAccess: parseTailnetAccess(accessJSON)
    }));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise((resolve) => server.listening ?
        resolve() : server.once("listening", resolve));
      const base = "http://127.0.0.1:" + server.address().port + "/api/sync/v1";
      const headers = { "Tailscale-User-Login": "user@example.com" };
      const find = await fetch(base + "/link", { headers });
      expect(find.status).toBe(200);
      expect((await find.json()).vaults).toEqual(["IOSLab"]);
      const missing = await fetch(base + "/link");
      expect(missing.status).toBe(401);
      const wrong = await fetch(base + "/vaults/PrivateVault/session", { headers });
      expect(wrong.status).toBe(401);
      const login = await fetch(base + "/vaults/IOSLab/session", { headers });
      expect(login.status).toBe(200);
      const session = await login.json();
      expect(session).toMatchObject({ auth: "tailnet", vaultId: "IOSLab" });
      expect(session).not.toHaveProperty("token");
      const manifest = await fetch(base + "/vaults/IOSLab/manifest", { headers });
      expect(manifest.status).toBe(200);
      expect((await manifest.json()).files).toEqual([]);
      expect((await fetch(base + "/vaults/IOSLab/manifest")).status).toBe(401);
      expect((await fetch(base + "/admin/vaults/IOSLab/devices", { headers })).status).toBe(401);
      expect(store.revokeDevice(session.deviceId)).toBe(true);
      expect((await fetch(base + "/vaults/IOSLab/session", { headers })).status).toBe(401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
