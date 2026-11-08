import { describe, expect, it } from "vitest";
import { connectionRecoveryLabel } from "./connection-recovery.ts";

describe("reconnection guidance", () => {
  it("describes a verified connection without revealing secrets", () => {
    expect(connectionRecoveryLabel({ ready: true, vaultId: "SLS-TextClone" },
      { serverUrl: "http://127.0.0.1:3196", authMode: "device" }))
      .toBe("Connected to SLS-TextClone · Device token");
  });
  it("gives a configured but unauthenticated native client a specific recovery path", () => {
    const label = connectionRecoveryLabel({
      ready: false, vaultId: "SLS-TextClone",
    }, { serverUrl: "http://127.0.0.1:3196", authMode: "device" });
    expect(label).toContain("needs its verified token again");
    expect(label).toContain("Connect and verify");
    expect(label).toContain("local notes are retained");
    expect(label).not.toContain("ignis_dev_");
  });
  it("distinguishes trusted Tailnet identity from secret-based login", () => {
    const label = connectionRecoveryLabel({
      ready: false, vaultId: "Lab",
    }, { serverUrl: "https://mac.example", authMode: "tailnet" });
    expect(label).toContain("trusted Tailscale identity");
    expect(label).not.toContain("paste the device token");
  });
  it("does not show a recovery prompt for a brand-new unconfigured Vault", () => {
    expect(connectionRecoveryLabel({ ready: false, vaultId: "" },
      { serverUrl: "", authMode: "device" }))
      .toContain("Paste your Ignis invite link");
  });
});
