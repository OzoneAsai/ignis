import { describe, expect, it } from "vitest";
import {
  normalizeOrigin, parseJoinLink, sessionError, scopedSecretId,
  validateConnection
} from "./connection-setup.ts";

const token = "ignis_dev_" + "x".repeat(43);
const draft = {
  serverUrl: "https://mac.example.ts.net:8451/",
  vaultId: "IOSLab",
  token
};
describe("one explicit connection transaction", () => {
  it("derives valid stable SecretStorage IDs from an entire origin-and-Vault scope", async () => {
    const scope = "http://127.0.0.1:3230|iOSLiveQA";
    const first = await scopedSecretId(scope);
    expect(first).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(first).toBe(await scopedSecretId(scope));
    expect(first).not.toBe(await scopedSecretId("http://127.0.0.1:3230|other"));
    expect(first).not.toBe(await scopedSecretId("http://127.0.0.1:3231|iOSLiveQA"));
  });
  it("accepts one secret-free HTTPS invite and never sends credentials from its URL", () => {
    const link = "https://mac.example:8452/join/IOSLab";
    expect(parseJoinLink(link)).toEqual({
      origin: "https://mac.example:8452", vaultId: "IOSLab"
    });
    expect(validateConnection({
      serverUrl: link, vaultId: "", token: ""
    }, "", true)).toEqual({
      origin: "https://mac.example:8452", vaultId: "IOSLab", token: "",
      scope: "https://mac.example:8452|IOSLab"
    });
    for(const bad of [
      "https://mac.example:8452/join/../PrivateVault",
      "https://mac.example:8452/join/IOSLab?token=anything",
      "https://user:password@mac.example/join/IOSLab",
      "https://mac.example/join/%2fprivate",
      "http://mac.example/join/IOSLab",
      "https://mac.example/api/sync/v1"
    ]) {
      expect(() => parseJoinLink(bad)).toThrow();
    }
  });
  it("normalizes the URL without stripping the HTTPS port", () => {
    expect(normalizeOrigin(draft.serverUrl))
      .toBe("https://mac.example.ts.net:8451");
    expect(validateConnection(draft)).toEqual({
      origin: "https://mac.example.ts.net:8451",
      vaultId: "IOSLab", token,
      scope: "https://mac.example.ts.net:8451|IOSLab"
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
