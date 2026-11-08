import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SyncthingClient } = require("./client");
const DEVICE_ID = "ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG";

function fixture({ actualId = DEVICE_ID, configDir = "/tmp/ignis-syncthing-config",
  dataDir = "/tmp/ignis-syncthing-data" } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, args) => {
    calls.push({ url, args });
    let value = null;
    if (url.endsWith("/rest/system/status")) {
      value = { myID: actualId, uptime: 1234 };
    } else if (url.endsWith("/rest/system/paths")) {
      value = { "baseDir-config": configDir, "baseDir-data": dataDir };
    } else if (url.endsWith("/rest/config")) {
      value = { folders: [], devices: [] };
    }
    return {
      ok: true, status: 200, text: async () => value ? JSON.stringify(value) : "",
    };
  });
  return { fetchImpl, calls };
}

function client(fetchImpl, args = {}) {
  return new SyncthingClient({
    origin: "http://127.0.0.1:8386",
    apiKey: "a-private-long-test-api-key",
    deviceId: DEVICE_ID,
    configDir: "/tmp/ignis-syncthing-config",
    dataDir: "/tmp/ignis-syncthing-data",
    fetchImpl,
    ...args,
  });
}

describe("SyncthingClient", () => {
  it("requires a literal loopback origin and an existing credential", () => {
    const { fetchImpl } = fixture();
    for (const origin of [
      "http://example.com:8384", "https://127.0.0.1:8384",
      "http://localhost:8384", "http://127.0.0.1:8384@attacker.test",
      "http://127.0.0.1:8384/other",
    ]) {
      expect(() => client(fetchImpl, { origin })).toThrow();
    }
    expect(() => client(fetchImpl, { apiKey: "" })).toThrow();
  });

  it("attests device and storage paths before using control endpoints", async () => {
    const { fetchImpl, calls } = fixture();
    const conn = client(fetchImpl);
    await expect(conn.pause()).rejects.toThrow("not attested");
    await expect(conn.attest()).resolves.toMatchObject({
      deviceId: DEVICE_ID, state: "running",
    });
    expect(await conn.status()).toMatchObject({ myID: DEVICE_ID });
    expect(await conn.config()).toMatchObject({ folders: [], devices: [] });
    await conn.pause();
    await conn.resume();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/rest/system/status", "/rest/system/paths", "/rest/system/status",
      "/rest/config", "/rest/system/pause", "/rest/system/resume",
    ]);
    expect(calls.every((c) => c.args.headers["X-API-Key"] === "a-private-long-test-api-key"))
      .toBe(true);
    expect(calls.at(-1).args.method).toBe("POST");
  });

  it("rejects a different Syncthing instance at the same port", async () => {
    const { fetchImpl } = fixture({ actualId: DEVICE_ID.replace("ABCDEFG", "BADBADB") });
    const conn = client(fetchImpl);
    await expect(conn.attest()).rejects.toThrow("identity");
    await expect(conn.resume()).rejects.toThrow("not attested");
  });

  it("rejects a matching ID with a different private data directory", async () => {
    const { fetchImpl } = fixture({ dataDir: "/tmp/unexpected" });
    await expect(client(fetchImpl).attest()).rejects.toThrow("private state directory");
  });

  it("revokes attestation when the running device ID changes", async () => {
    const { fetchImpl } = fixture();
    const conn = client(fetchImpl);
    await conn.attest();
    fetchImpl.mockImplementation(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ myID: DEVICE_ID.replace("ABCDEFG", "BADBADB") }),
    }));
    await expect(conn.status()).rejects.toThrow("instance changed");
    await expect(conn.pause()).rejects.toThrow("not attested");
  });

  it("does not expose secrets or request bodies in API errors", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    const conn = client(fetchImpl);
    await expect(conn.attest()).rejects.toThrow("HTTP 401");
    await expect(conn.attest()).rejects.not.toThrow(/private-long-test-api-key/);
  });
});
