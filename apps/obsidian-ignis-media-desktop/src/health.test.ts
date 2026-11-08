import { describe, expect, it } from "vitest";
import { deriveMediaHealth, formatByteCount } from "./health";

const peers = [{ connected: true, paused: false }];
const folders = [{ paused: false }];

describe("user-visible media synchronization health", () => {
  it("preserves setup and stopped states without implying data loss", () => {
    expect(deriveMediaHealth({ state: "not-configured" }).kind).toBe("setup");
    expect(deriveMediaHealth({ state: "stopped" }).kind).toBe("stopped");
    expect(deriveMediaHealth({ state: "stopped" }).explanation).toContain("残って");
  });

  it("never reports synced for a disconnected peer or empty folder", () => {
    const complete = {
      state: "running" as const, completion: 100, needBytes: 0,
      remoteNeedBytes: 0, remoteVerified: true,
    };
    expect(deriveMediaHealth({ ...complete, peers, folders: [] }).kind).toBe("setup");
    expect(deriveMediaHealth({
      ...complete, peers: [{ connected: false, paused: false }], folders,
    }).kind).toBe("offline");
    expect(deriveMediaHealth({
      ...complete, peers: [], folders,
    }).kind).toBe("setup");
  });

  it("reports pending bytes only when it is known, not an invented total", () => {
    const health = deriveMediaHealth({
      state: "running", peers, folders, completion: 52.1, needBytes: 10485760,
      remoteNeedBytes: 0, remoteVerified: true,
    });
    expect(health.kind).toBe("syncing");
    expect(health.explanation).toContain("10.0 MiB");
  });

  it("distinguishes paused, partially disconnected and fully connected", () => {
    expect(deriveMediaHealth({
      state: "running", peers: [{ ...peers[0], paused: true }],
      folders, completion: 100, needBytes: 0,
      remoteNeedBytes: 0, remoteVerified: true,
    }).kind).toBe("paused");
    expect(deriveMediaHealth({
      state: "running", peers: [...peers, { connected: false, paused: false }],
      folders, completion: 100, needBytes: 0,
      remoteNeedBytes: 0, remoteVerified: true,
    }).kind).toBe("attention");
    expect(deriveMediaHealth({
      state: "running", peers, folders, completion: 100, needBytes: 0,
      remoteNeedBytes: 0, remoteVerified: true,
    }).kind).toBe("synced");
  });

  it("does not claim full synchronization when metrics are missing or invalid", () => {
    expect(deriveMediaHealth({
      state: "running", peers, folders, completion: undefined, needBytes: null,
    }).kind).toBe("attention");
    expect(deriveMediaHealth({
      state: "running", peers, folders, completion: Infinity, needBytes: -1,
    }).kind).toBe("attention");
    expect(formatByteCount(null)).toBe("不明");
    expect(deriveMediaHealth({
      state: "running", peers, folders, completion: 100, needBytes: 0,
      remoteNeedBytes: null, remoteVerified: false,
    }).needBytes).toBeNull();
  });

  it("detects that the remote device still needs a file when local completion is 100%", () => {
    const result = deriveMediaHealth({
      state: "running", peers, folders, completion: 100, needBytes: 0,
      remoteNeedBytes: 2048, remoteVerified: true,
    });
    expect(result.kind).toBe("syncing");
    expect(result.explanation).toContain("相手側");
    expect(deriveMediaHealth({
      state: "running", peers, folders, completion: 100, needBytes: 0,
      remoteNeedBytes: null, remoteVerified: false,
    }).kind).toBe("attention");
  });

  it("never offers controls against unidentified local processes", () => {
    expect(deriveMediaHealth({ state: "unmanaged", peers, folders }).kind).toBe("blocked");
    expect(deriveMediaHealth({ state: "error", peers, folders }).kind).toBe("attention");
  });
});
