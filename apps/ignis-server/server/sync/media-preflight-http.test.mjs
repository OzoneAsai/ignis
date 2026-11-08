import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store.js");
const { createSyncRouter } = require("./http.js");
const SECRET = "a".repeat(48);
const owned = [];

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-media-admin-route-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  fs.mkdirSync(path.join(vault, "Media"));
  const store = new VaultSyncStore({
    dataRoot: root,
    getVaultPath: (id) => id === "vault" ? vault : null,
    collaboration: { getActive: () => null },
    writeCoalescer: { flushPending: async () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/sync/v1", createSyncRouter({ store, token: SECRET }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  owned.push({ store, root, server });
  return {
    base: `http://127.0.0.1:${server.address().port}/api/sync/v1`,
    store, vault,
  };
}

afterEach(async () => {
  for (const { store, root, server } of owned.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("authenticated, non-mutating media ownership preflight", () => {
  it("never discloses metadata to unauthenticated clients", async () => {
    const { base } = await fixture();
    const url = base + "/admin/vaults/vault/media-preflight?root=Media";
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, {
      headers: { Authorization: "Bearer " + "b".repeat(48) },
    })).status).toBe(401);
  });

  it("returns an explicit diagnostic without changing sync sequence", async () => {
    const { base, store } = await fixture();
    const response = await fetch(base + "/admin/vaults/vault/media-preflight?root=Media", {
      headers: { Authorization: "Bearer " + SECRET },
    });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      mode: "read-only-preflight", safeForEmptyPilot: true,
      activationAvailable: false,
    });
    expect(store.head("vault")).toBe(0);
  });

  it("rejects invalid roots and reports active device blockers", async () => {
    const { base, store } = await fixture();
    store.enrollDevice("vault", "SLS");
    const request = (root) => fetch(
      base + "/admin/vaults/vault/media-preflight?root=" + encodeURIComponent(root),
      { headers: { Authorization: "Bearer " + SECRET } },
    );
    expect((await request("../escape")).status).toBe(400);
    const response = await request("Media");
    const report = await response.json();
    expect(report.safeForEmptyPilot).toBe(false);
    expect(report.issues.some((issue) => issue.code === "DEVICES_NOT_QUIESCED"))
      .toBe(true);
  });
});
