import { describe, expect, it } from "vitest";
import { acknowledgeWrite, stageWrite } from "./writes.ts";

const DIGEST = "a".repeat(64);
function write(opId = "operation-123") {
  return { opId, type: "create", path: "draft.md", content: "text",
    localHash: DIGEST };
}
function receipt(staged) {
  return { opId: staged.opId, type: staged.type, path: staged.path,
    fileId: "file-a", generationId: "generation-a",
    hash: staged.localHash, seq: 7 };
}
describe("durable immutable outbound write requests", () => {
  it("retains the first payload and opId even if a later edit is staged", () => {
    const pending = [];
    const first = stageWrite(pending, write());
    const second = stageWrite(pending, {
      ...write("operation-456"), content: "later"
    });
    expect(second).toEqual(first);
    expect(pending).toEqual([write()]);
    expect(stageWrite(pending, {
      ...write("operation-789"), path: "other.md"
    })).toHaveProperty("path", "other.md");
    expect(pending).toHaveLength(2);
  });
  it("survives JSON persistence and acknowledges exactly one matching receipt", () => {
    const pending = [];
    stageWrite(pending, write());
    const restored = JSON.parse(JSON.stringify(pending));
    expect(acknowledgeWrite(restored, receipt(restored[0]))).toEqual(write());
    expect(restored).toEqual([]);
  });
  it("rejects a wrong or stale receipt without consuming the pending request", () => {
    const pending = [write()];
    for (const altered of [
      { opId: "other-op" }, { type: "modify" }, { path: "other.md" },
      { hash: "b".repeat(64) }, { seq: -1 }, { fileId: null }
    ]) {
      expect(() => acknowledgeWrite(pending, { ...receipt(pending[0]), ...altered }))
        .toThrow(/different staged write/);
      expect(pending).toHaveLength(1);
    }
  });
  it("rejects ambiguous or malformed staged payloads", () => {
    for (const invalid of [
      { opId: "short" }, { contentBase64: "YQ==" },
      { content: undefined }, { localHash: "wrong" }, { type: "delete" }
    ]) {
      expect(() => stageWrite([], { ...write(), ...invalid })).toThrow();
    }
  });
});
