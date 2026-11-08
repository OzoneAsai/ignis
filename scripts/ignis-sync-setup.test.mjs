import { describe, expect, it, vi } from "vitest";
import { parseArgs, runSyncSetup } from "./ignis-sync-setup.mjs";

const SECRET = "administrator-secret-not-to-appear-on-screen-xyz";
function fixture(responses = []) {
  const calls = [];
  const output = [];
  const errors = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift() || { contentScope: "all",
      vaultId: "TestVault", source: "not-enrolled", trackedFiles: 0,
      journalEvents: 0, registeredDevices: 0, canApply: true,
      requestedScope: "markdown-only", applied: true };
    return {
      status: response.status || 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(response),
    };
  });
  const config = {
    env: { IGNIS_SYNC_TOKEN: SECRET, PORT: "3192" },
    output: { write: (message) => output.push(message) },
    error: { write: (message) => errors.push(message) },
    input: { isTTY: true },
    ask: vi.fn(async () => "no"),
    fetchImpl,
  };
  return { calls, output, errors, config, fetchImpl };
}

describe("Mac-local Vault sharing console", () => {
  it("authorizes selected PDF/Office exceptions through the admin-only loopback API", async () => {
    const state = {
      vaultId: "TestVault", extensions: [], requestedExtensions:
        ["docx", "pdf", "pptx", "xlsx"], canApply: true,
      applied: false,
    };
    const granted = fixture([state, {
      ...state, applied: true, extensions: state.requestedExtensions,
    }]);
    const result = await runSyncSetup([
      "bypass-set", "--vault", "TestVault",
      "--types", "pdf,docx,xlsx,pptx", "--yes",
    ], granted.config);
    expect(result).toBe(0);
    expect(granted.calls).toHaveLength(2);
    expect(granted.calls[0].url).toBe(
      "http://127.0.0.1:3192/api/sync/v1/admin/vaults/TestVault/media-bypass?" +
      "extensions=docx%2Cpdf%2Cpptx%2Cxlsx"
    );
    expect(JSON.parse(granted.calls[1].init.body)).toEqual({
      extensions: ["docx", "pdf", "pptx", "xlsx"],
      expectedExtensions: [],
    });
    expect(granted.output.join("")).not.toContain(SECRET);
    expect(granted.output.join("")).toContain("Syncthing state is unchanged");
  });
  it("refuses invalid bypass types and blocks unsafe policy shrinking", async () => {
    expect(() => parseArgs([
      "bypass-set", "--vault", "TestVault", "--types", "exe"
    ], { IGNIS_SYNC_TOKEN: SECRET })).toThrow("Unsupported");
    const stopped = fixture([{
      vaultId: "TestVault", extensions: ["pdf", "pptx"],
      requestedExtensions: ["pdf"], canApply: false,
    }]);
    expect(await runSyncSetup([
      "bypass-set", "--vault", "TestVault", "--types", "pdf", "--yes",
    ], stopped.config)).toBe(2);
    expect(stopped.calls).toHaveLength(1);
  });
  it("rejects invalid scopes, absent credentials and non-loopback options", () => {
    expect(() => parseArgs(["set", "--vault", "x", "--mode", "all"], {}))
      .toThrow("IGNIS_SYNC_TOKEN");
    expect(() => parseArgs(["set", "--vault", "x", "--mode", "image-only"],
      { IGNIS_SYNC_TOKEN: SECRET })).toThrow("--mode");
    expect(() => parseArgs(["show", "--vault", "x", "--port", "90"],
      { IGNIS_SYNC_TOKEN: SECRET })).toThrow("--port");
    expect(() => parseArgs(["show", "--vault", "x", "--host", "example.com"],
      { IGNIS_SYNC_TOKEN: SECRET })).toThrow("Unknown option");
  });
  it("displays a dry-run with counts, without writing or showing credentials", async () => {
    const f = fixture();
    expect(await runSyncSetup(["preview", "--vault", "TestVault",
      "--mode", "markdown-only"], f.config)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(
      "http://127.0.0.1:3192/api/sync/v1/admin/vaults/TestVault/content-scope?mode=markdown-only",
    );
    expect(f.calls[0].init.method).toBe("GET");
    expect(f.output.join("")).toContain("Safe to apply");
    expect(f.output.join("")).not.toContain(SECRET);
  });
  it("requires confirmation before writing and saves with an expected old mode", async () => {
    const cancelled = fixture();
    expect(await runSyncSetup(["set", "--vault", "TestVault",
      "--mode", "markdown-only"], cancelled.config)).toBe(0);
    expect(cancelled.calls).toHaveLength(1);
    expect(cancelled.output.join("")).toContain("No changes were made");

    const accepted = fixture();
    accepted.config.ask.mockResolvedValueOnce("yes");
    expect(await runSyncSetup(["set", "--vault", "TestVault",
      "--mode", "markdown-only"], accepted.config)).toBe(0);
    expect(accepted.calls).toHaveLength(2);
    expect(accepted.calls[1].init.method).toBe("PUT");
    expect(JSON.parse(accepted.calls[1].init.body)).toEqual({
      contentScope: "markdown-only", expectedScope: "all",
    });
    expect(accepted.output.join("")).toContain("after the server restarts");
  });
  it("does not allow changing an active Vault, even with noninteractive override", async () => {
    const blocked = fixture([{ contentScope: "all", source: "startup",
      vaultId: "TestVault", trackedFiles: 3, journalEvents: 4,
      registeredDevices: 1, canApply: false, requestedScope: "markdown-only",
    }]);
    expect(await runSyncSetup(["set", "--vault", "TestVault",
      "--mode", "markdown-only", "--yes"], blocked.config)).toBe(2);
    expect(blocked.calls).toHaveLength(1);
    expect(blocked.errors.join("")).toContain("existing history");
  });
});
