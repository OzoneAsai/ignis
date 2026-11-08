// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mobileUiLanguage, mobileUiCopy } from "./mobile-ui-copy.ts";

describe("shared iOS/Connector language projection", () => {
  it("uses Obsidian language preference before device language", () => {
    const storage = { getItem: key => key === "language" ? "ja" : null };
    expect(mobileUiLanguage(storage, "en-US")).toBe("ja");
    expect(mobileUiCopy(mobileUiLanguage(storage, "en-US")).upload).toBe("ファイル追加");
    expect(mobileUiCopy(mobileUiLanguage(storage, "en-US")).people).toBe("参加者・表示名");
  });

  it("uses English when Obsidian is configured to English", () => {
    expect(mobileUiLanguage({ getItem: () => "en" }, "ja-JP")).toBe("en");
    expect(mobileUiCopy("en").upload).toBe("Add files");
    expect(mobileUiCopy("en").people).toBe("Participants & display name");
    expect(mobileUiCopy("en").synced).toBe("Synced");
  });

  it("survives denied storage and falls back to device language", () => {
    const denied = { getItem() { throw new Error("SecurityError"); } };
    expect(mobileUiLanguage(denied, "ja-JP")).toBe("ja");
    expect(mobileUiLanguage(denied, "en-GB")).toBe("en");
  });
});
