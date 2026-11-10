import { describe, expect, it } from "vitest";
import { migrationReason, migrationUiCopy } from "./migration-ui-copy.ts";

describe("migration copy parity for iPhone and desktop", () => {
  it("communicates safe preservation and explicit choice in both languages", () => {
    for (const locale of ["ja", "en"]) {
      const t = migrationUiCopy(locale);
      expect(t.stages).toHaveLength(3);
      expect(t.saveAll).toBeTruthy();
      expect(t.finish).toBeTruthy();
      expect(t.confirm).toBeTruthy();
      expect(t.intro.length).toBeGreaterThan(30);
      expect(t.count(2, 1)).toContain("2");
    }
  });
  it("keeps immutable conflict reasons as data and localizes their explanations", () => {
    expect(migrationReason("Existing on both devices", "ja")).toContain("別文書");
    expect(migrationReason("Replaced document generation", "ja")).toContain("世代");
    expect(migrationReason("Existing on both devices", "en")).toBe("Existing on both devices");
  });
});
