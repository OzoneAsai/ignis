import { describe, expect, it } from "vitest";
import { allowsPeer, parseGatewayArguments, scopedRequest }
  from "./ignis-vault-sync-gateway.mjs";

const VAULT = "SLS-TextClone";
describe("single-Vault Tailnet gateway", () => {
  it("exposes only authenticated Vault Sync paths, never legacy files or admin", () => {
    for (const url of [
      "/api/sync/v1/capabilities",
      "/api/sync/v1/vaults/SLS-TextClone/session",
      "/api/sync/v1/vaults/SLS-TextClone/manifest",
      "/api/sync/v1/vaults/SLS-TextClone/changes?since=0",
      "/api/sync/v1/vaults/SLS-TextClone/files/12345678-1234-1234-1234-123456789abc",
      "/api/sync/v1/vaults/SLS-TextClone/operations/unique_op_123",
    ]) expect(scopedRequest(url, "GET", VAULT)).toBe(true);
    expect(scopedRequest("/api/sync/v1/vaults/SLS-TextClone/operations",
      "POST", VAULT)).toBe(true);
    for (const url of [
      "/api/fs/read", "/api/settings", "/api/plugins", "/api/vault/list",
      "/api/sync/v1/admin/vaults/SLS-TextClone/devices",
      "/api/sync/v1/vaults/Other/manifest",
      "/api/sync/v1/vaults/SLS-TextClone/../../admin/devices",
      "/api/sync/v1/vaults/SLS-TextClone/%2e%2e/admin",
    ]) expect(scopedRequest(url, "GET", VAULT)).toBe(false);
  });
  it("only allows the specified Vault WebSocket", () => {
    expect(scopedRequest("/ws?vault=SLS-TextClone", "GET", VAULT, true))
      .toBe(true);
    expect(scopedRequest("/ws?vault=Other", "GET", VAULT, true))
      .toBe(false);
    expect(scopedRequest("/ws?vault=SLS-TextClone&admin=1",
      "GET", VAULT, true)).toBe(false);
  });
  it("restricts the network source and validates all binding arguments", () => {
    expect(allowsPeer("::ffff:100.113.211.42", "100.113.211.42")).toBe(true);
    expect(allowsPeer("100.1.1.1", "100.113.211.42")).toBe(false);
    expect(parseGatewayArguments(["--listen-host", "127.0.0.1",
      "--listen-port", "3196", "--target-host", "100.75.232.0",
      "--target-port", "3197", "--peer", "127.0.0.1",
      "--vault", VAULT])).toMatchObject({ vault: VAULT,
      listenPort: 3196 });
    expect(() => parseGatewayArguments(["--listen-host", "0.0.0.0"]))
      .toThrow();
  });
});
