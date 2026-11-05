import { describe, expect, it } from "vitest";
import { normalizeOrigin, sessionError, validateConnection } from "./connection-setup.ts";

const token = "ignis_dev_" + "x".repeat(43);
const draft = {
  serverUrl: "https://manamacbook-air.manakin-acoustic.ts.net:8451/",
  vaultId: "IOSLab",
  token
};
describe("one explicit connection transaction", () => {
  it("normalizes the URL without stripping the HTTPS port", () => {
    expect(normalizeOrigin(draft.serverUrl))
      .toBe("https://manamacbook-air.manakin-acoustic.ts.net:8451");
    expect(validateConnection(draft)).toEqual({
      origin: "https://manamacbook-air.manakin-acoustic.ts.net:8451",
      vaultId: "IOSLab", token,
      scope: "https://manamacbook-air.manakin-acoustic.ts.net:8451|IOSLab"
    });
  });
  it("blocks every incomplete form before making an HTTP request", () => {
    for (const [key, value] of [
      ["serverUrl", ""], ["serverUrl", "http://example.org"],
      ["serverUrl", "https://example.org/unsafe/path"],
      ["vaultId", ""], ["vaultId", "../other"],
      ["token", ""], ["token", "admin-secret"]
    ]) {
      expect(() => validateConnection({ ...draft, [key]: value }))
        .toThrow();
    }
  });
  it("allows a verified existing credential only for the exact active scope", () => {
    expect(validateConnection({ ...draft, token: "" }, token).token).toBe(token);
    expect(() => validateConnection({ ...draft, vaultId: "other", token: "" }))
      .toThrow();
  });
  it("distinguishes missing API from rejected authorization and bad identities", () => {
    expect(sessionError(404, {}, "IOSLab")).toMatch(/API not found/);
    expect(sessionError(401, {}, "IOSLab")).toMatch(/Vault ID and device token/);
    expect(sessionError(502, {}, "IOSLab")).toMatch(/gateway/);
    expect(sessionError(200, { deviceId: "device", vaultId: "wrong" }, "IOSLab"))
      .toMatch(/different Vault/);
    expect(sessionError(200, { deviceId: "device", vaultId: "IOSLab" }, "IOSLab"))
      .toBeNull();
  });
});
