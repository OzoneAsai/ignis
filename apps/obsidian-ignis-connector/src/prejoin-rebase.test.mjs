import { describe, expect, it } from "vitest";
import { rebasePrejoinText } from "./prejoin-rebase.ts";

describe("proven-ancestor native pre-join editing across Web and Connector", () => {
  it("preserves native prefix and Web/mobile suffix before the initial handshake", () => {
    const base = "Original line.\n";
    expect(rebasePrejoinText(base, "Native\n" + base,
      base + "Desktop\nMobile\n")).toEqual({
      kind: "merged", text: "Native\n" + base + "Desktop\nMobile\n"
    });
  });
  it("handles disjoint replacements and Unicode without splitting UTF-16 positions", () => {
    const base = "質問：はい？\n回答：まだです。\n";
    const local = "質問：いいえ？\n回答：まだです。\n";
    const remote = "質問：はい？\n回答：完了です。\n";
    expect(rebasePrejoinText(base, local, remote)).toEqual({
      kind: "merged", text: "質問：いいえ？\n回答：完了です。\n"
    });
  });
  it("refuses overlapping edits, same-position insertion, or destructive competition", () => {
    expect(rebasePrejoinText("ABC", "AXC", "AYC")).toEqual({kind:"review"});
    expect(rebasePrejoinText("ABC", "A1BC", "A2BC")).toEqual({kind:"review"});
    expect(rebasePrejoinText("ABC", "AC", "AB1C")).toEqual({kind:"review"});
  });
  it("avoids duplication when independently typed visible content already matches", () => {
    expect(rebasePrejoinText("Original", "Edited", "Edited"))
      .toEqual({kind:"merged",text:"Edited"});
    expect(rebasePrejoinText("Original", "Local", "Original"))
      .toEqual({kind:"merged",text:"Local"});
  });
});
