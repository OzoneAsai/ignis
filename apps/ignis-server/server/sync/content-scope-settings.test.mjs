import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createRequire } from "node:module";
import { runSyncSetup } from "../../../../scripts/ignis-sync-setup.mjs";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store");
const { createSyncRouter } = require("./http");
const ADMIN_SECRET = "operator-private-content-scope-secret-123456789";
const resources = [];

async function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-content-settings-"));
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const options = {
    dataRoot: dir,
    getVaultPath: (id) => id === "TestVault" ? vault : null,
    collaboration: { getActive: () => null, peekDocumentId: () => null },
    writeCoalescer: { flushPending: async () => {} },
  };
  const store = new VaultSyncStore(options);
  const app = express();
  app.use(express.json());
  app.use("/api/sync/v1", createSyncRouter({ store, token: ADMIN_SECRET }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  resources.push({ store, dir, server });
  const base = "http://127.0.0.1:" + server.address().port +
    "/api/sync/v1/admin/vaults/TestVault/content-scope";
  const headers = {
    Authorization: "Bearer " + ADMIN_SECRET,
    "Content-Type": "application/json",
  };
  return { store, dir, vault, options, base, headers };
}
afterEach(async () => {
  for (const { store, dir, server } of resources.splice(0)) {
    await new Promise((done) => server.close(done));
    store.close();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
function apply(base, headers, contentScope, expectedScope) {
  return fetch(base, {
    method: "PUT", headers,
    body: JSON.stringify({ contentScope, expectedScope }),
  });
}

describe("admin-only Vault file sharing settings", () => {
  it("takes a Mac operator from preview through confirmed save over the real authenticated API", async () => {
    const { base, store } = await createFixture();
    const writes = [];
    const requestOptions = {
      env: { IGNIS_SYNC_TOKEN: ADMIN_SECRET,
        PORT: String(new URL(base).port) },
      output: { write: (line) => writes.push(line) },
      error: { write: () => {} },
      input: { isTTY: true },
      ask: async () => "yes",
    };
    expect(await runSyncSetup(["preview", "--vault", "TestVault",
      "--mode", "markdown-only"], requestOptions)).toBe(0);
    expect(store.db.prepare(
      "SELECT COUNT(*) AS n FROM vault_sync_preferences"
    ).get().n).toBe(0);
    expect(await runSyncSetup(["set", "--vault", "TestVault",
      "--mode", "markdown-only"], requestOptions)).toBe(0);
    expect(store.contentScopeFor("TestVault")).toBe("markdown-only");
    expect(writes.join("")).not.toContain(ADMIN_SECRET);
    expect(writes.join("")).toContain("after the server restarts");
  });
  it("previews without mutation and rejects tokenless access", async () => {
    const { store, dir, base, headers } = await createFixture();
    const sqlite = path.join(dir, "sync", "vault.sqlite");
    expect((await fetch(base)).status).toBe(401);
    expect((await apply(base, {}, "markdown-only", "all")).status).toBe(401);
    const read = await fetch(base, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      contentScope: "all", source: "not-enrolled",
      locked: false, canApply: true, trackedFiles: 0,
      journalEvents: 0, registeredDevices: 0,
    });
    expect(store.head("TestVault")).toBe(0);
    expect(store.db.prepare(
      "SELECT COUNT(*) AS count FROM vault_content_scopes").get().count).toBe(0);
    expect(fs.statSync(sqlite).size).toBeGreaterThan(0);
  });

  it("applies an explicit choice and preserves it across a restart and old environment defaults", async () => {
    const { store, options, base, headers, vault } = await createFixture();
    const applied = await apply(base, headers, "markdown-only", "all");
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      contentScope: "markdown-only", source: "owner",
      canApply: true, applied: true,
    });
    fs.writeFileSync(path.join(vault, "local.jpg"), "keep local");
    fs.writeFileSync(path.join(vault, "note.md"), "share it");
    expect((await store.scan("TestVault")).files.map((file) => file.path))
      .toEqual(["note.md"]);
    const restarted = new VaultSyncStore({ ...options, contentScope: "all" });
    try {
      expect(restarted.contentScopeFor("TestVault")).toBe("markdown-only");
      expect((await restarted.scan("TestVault")).files.map((file) => file.path))
        .toEqual(["note.md"]);
    } finally { restarted.close(); }
    const again = await apply(base, headers, "markdown-only", "markdown-only");
    expect(await again.json()).toMatchObject({
      applied: false, contentScope: "markdown-only",
    });
  });

  it("blocks stale settings and media scope changes when a device has enrolled", async () => {
    const { store, base, headers } = await createFixture();
    const stale = await apply(base, headers, "markdown-only", "markdown-only");
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("SCOPE_CHANGED");
    store.enrollDevice("TestVault", "SLS");
    const locked = await fetch(base, { headers });
    expect(await locked.json()).toMatchObject({
      locked: true, registeredDevices: 1,
    });
    const denied = await apply(base, headers, "markdown-only", "all");
    expect(denied.status).toBe(409);
    expect((await denied.json()).code).toBe("SCOPE_MIGRATION_REQUIRED");
    expect(store.contentScopeFor("TestVault")).toBe("all");
  });

  it("validates inputs and never configures an unknown Vault", async () => {
    const { base, headers } = await createFixture();
    expect((await apply(base, headers, "maybe", "all")).status).toBe(400);
    expect((await apply(base, headers, "all", "wrong")).status).toBe(400);
    expect((await fetch(base.replace("TestVault", "NoSuchVault"),
      { headers })).status).toBe(404);
  });

  it("serializes simultaneous modifications using the expected mode as a guard", async () => {
    const { store } = await createFixture();
    const results = await Promise.allSettled([
      store.setContentScope("TestVault", "markdown-only", "all"),
      store.setContentScope("TestVault", "all", "all"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.contentScopeFor("TestVault")).toBe("markdown-only");
  });

  it("lets an untracked Vault choose its scope even if the startup default was changed", async () => {
    const { store, options } = await createFixture();
    expect(store.contentScopeFor("TestVault")).toBe("all");
    const alternate = new VaultSyncStore({ ...options, contentScope: "markdown-only" });
    try {
      expect(alternate.previewContentScope("TestVault", "all")).toMatchObject({
        canApply: true, locked: false, configurationMismatch: false,
      });
      const result = await alternate.setContentScope("TestVault", "all", "all");
      expect(result).toMatchObject({ applied: true, contentScope: "all" });
      expect(alternate.contentScopeFor("TestVault")).toBe("all");
    } finally { alternate.close(); }
  });
});
