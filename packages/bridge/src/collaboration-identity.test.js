import { describe, expect, it } from "vitest";
import {
  NAME_KEY, normalizeDisplayName, preferredDisplayName, saveDisplayName
} from "./collaboration-identity.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe("WebUI participant display name on installed mobile PWA", () => {
  it("persists the selected name across standalone app/tab restarts", () => {
    const persistent = storage();
    const firstTab = storage();
    expect(saveDisplayName("  ゆい\n", persistent, firstTab)).toBe("ゆい");
    expect(preferredDisplayName(persistent, storage())).toBe("ゆい");
    expect(persistent.getItem(NAME_KEY)).toBe("ゆい");
  });

  it("migrates the previous session-scoped name when no persistent name exists", () => {
    const oldTab = storage();
    const persistent = storage();
    oldTab.setItem(NAME_KEY, "Old browser name");
    expect(preferredDisplayName(persistent, oldTab)).toBe("Old browser name");
    expect(preferredDisplayName(persistent, storage())).toBe("Old browser name");
  });

  it("restricts control characters and prevents an empty participant name", () => {
    expect(normalizeDisplayName("\u202eA\u0000B\n")).toBe("AB");
    expect(normalizeDisplayName("x".repeat(80))).toHaveLength(40);
    expect(saveDisplayName(" \n", storage(), storage())).toBe("");
  });

  it("uses remaining storage when Safari privacy settings block the other", () => {
    const unavailable = { getItem() { throw Error("denied"); },
      setItem() { throw Error("denied"); } };
    const tab = storage();
    saveDisplayName("PWA user", unavailable, tab);
    expect(preferredDisplayName(unavailable, tab)).toBe("PWA user");
  });
});
