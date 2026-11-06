import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_LIMIT, normalizeDisplayName, effectiveDisplayName } from "./display-name.ts";

describe("display-name identity presentation", () => {
  it("normalizes control chars/bidi controls and caps names to the server limit", () => {
    expect(normalizeDisplayName("  Alice\u202e\nBob  ")).toBe("AliceBob");
    expect(normalizeDisplayName("x".repeat(100))).toHaveLength(DISPLAY_NAME_LIMIT);
  });
  it("preserves non-Latin names and retains per-device default for blank name", () => {
    expect(effectiveDisplayName("  ゆい 👋 ", "abc123xyz")).toBe("ゆい 👋");
    expect(effectiveDisplayName("  ", "abc123xyz")).toBe("Obsidian abc123");
  });
});
