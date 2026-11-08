import { describe, expect, it, vi } from "vitest";
import { importNativeFiles, nativeConnectionState } from "./mobile-controls.ts";

const synced = "Synced · server acknowledged";
describe("native Obsidian iOS mobile parity status", () => {
  it("uses the same English labels as Ignis Web", () => {
    expect(nativeConnectionState(synced, true, true, "en").label).toBe("Synced");
    expect(nativeConnectionState("Syncing", true, true, "en").label).toBe("Syncing…");
  });
  it("does not mistake a live native socket for persisted edits", () => {
    expect(nativeConnectionState("Not connected", false, false).label).toBe("未接続");
    expect(nativeConnectionState(synced, true, false).label).toBe("オフライン");
    expect(nativeConnectionState("Syncing", true, true).kind).toBe("syncing");
    expect(nativeConnectionState("Pending · locally retained", true, true).kind)
      .toBe("syncing");
    expect(nativeConnectionState(synced, true, true).label).toBe("同期済み");
    expect(nativeConnectionState("Files synced · live collaboration offline", true, true).kind)
      .toBe("syncing");
  });
  it("shows authorization and sync failures, even if the socket appears ready", () => {
    expect(nativeConnectionState("Device revoked or no longer authorized", false, false).kind)
      .toBe("error");
    expect(nativeConnectionState("Concurrent edit needs review", true, true).kind)
      .toBe("error");
  });
});

describe("native Obsidian File API import matching the WebUI", () => {
  const file = (name, content) => {
    const bytes = Uint8Array.from(content);
    return {
      name, size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer),
    };
  };
  it("imports a photo into the canonical root without overwriting a peer's file", async () => {
    const existing = new Set(["photo.heic"]);
    const createBinary = vi.fn(async (path) => existing.add(path));
    const vault = {
      getRoot: () => ({ path: "/" }),
      getAbstractFileByPath: path => existing.has(path) ? {} : null,
      createBinary,
    };
    const jpeg = file("photo.heic", [1, 2, 3]);
    const result = await importNativeFiles(vault, [jpeg, jpeg], () => true);
    expect(result).toEqual({ imported: 2, failed: 0, tooLarge: 0 });
    expect(createBinary.mock.calls.map(call => call[0]))
      .toEqual(["photo (1).heic", "photo (2).heic"]);
  });
  it("rejects unsafe and oversized local attachments before sync", async () => {
    const createBinary = vi.fn();
    const vault = {
      getRoot: () => ({ path: "/" }),
      getAbstractFileByPath: () => null, createBinary,
    };
    const oversized = { name: "huge.mov", size: 4 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn() };
    const result = await importNativeFiles(vault, [
      file(".obsidian", [1]), oversized
    ], path => !path.startsWith(".obsidian"));
    expect(result).toEqual({ imported: 0, failed: 1, tooLarge: 1 });
    expect(createBinary).not.toHaveBeenCalled();
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });
});
