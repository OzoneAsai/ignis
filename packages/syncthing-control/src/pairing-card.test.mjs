import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  encodePairingCard, decodePairingCard, tailscaleIPv4Candidates,
  configuredTcpPorts,
} = require("./pairing-card.js");

const VALID = "VHRCSES-MPW4QO5-OKXSVDU-P2ZVNVE-K4T6WUS-3HCULBP-SYEQ4AG-KEIOXAR";
const now = Date.UTC(2026, 10, 7, 1, 0);

describe("IGNIS media pairing card", () => {
  it("encodes an identity, endpoint and pilot ID without secrets", () => {
    const encoded = encodePairingCard({
      deviceId: VALID, name: " Mac-IGNIS-Test ",
      address: "tcp://100.75.232.0:22020",
      folderId: "ignis-media-pilot", now,
    });
    expect(encoded).toMatch(/^IGNIS-PAIR1\.[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
    expect(encoded).not.toContain("apikey");
    expect(decodePairingCard(encoded, { now: now + 1000 })).toMatchObject({
      deviceId: VALID, name: "Mac-IGNIS-Test", address: "tcp://100.75.232.0:22020",
      folderId: "ignis-media-pilot",
    });
  });

  it("rejects invalid, modified or expired cards", () => {
    const encoded = encodePairingCard({
      deviceId: VALID, name: "Mac",
      address: "tcp://mac.example.ts.net:22020", now,
    });
    expect(() => decodePairingCard(encoded.replace(/.$/, "0"), { now })).toThrow();
    expect(() => decodePairingCard(encoded, { now: now + 25 * 60 * 60 * 1000 }))
      .toThrow("expired");
    expect(() => decodePairingCard(encoded, { now: now - 600000 })).toThrow("timestamp");
    expect(() => encodePairingCard({
      deviceId: VALID, name: "Mac\nsecret", address: "tcp://a:22020", now,
    })).toThrow("single-line");
  });

  it("selects only plausible Tailscale IPv4 and explicit configured TCP ports", () => {
    expect(tailscaleIPv4Candidates({
      ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.7" }],
      tailscale: [{ family: "IPv4", internal: false, address: "100.75.232.0" }],
      loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    })).toEqual(["100.75.232.0"]);
    expect(configuredTcpPorts({ options: {
      listenAddresses: ["tcp://0.0.0.0:22020", "quic://0.0.0.0:22020", "default"],
    } })).toEqual([22020]);
    expect(configuredTcpPorts({ options: { listenAddresses: ["default"] } })).toEqual([]);
  });
});
