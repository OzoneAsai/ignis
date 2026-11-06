import { describe, expect, it } from "vitest";
import { acknowledgePending, localPaths, queueDelete, queueRename } from "./pending.ts";

const identity = {
  fileId: "file-aaaa", generationId: "generation-aaaa",
  hash: "digest-aaaa", revision: 3
};
function state() {
  return { baselines: { "A.md": { ...identity } }, pending: [] };
}
function receipt(operation, seq) {
  return {
    seq, fileId: operation.fileId, generationId: operation.generationId,
    hash: identity.hash, type: operation.type,
    path: operation.path, toPath: operation.toPath || null,
    opId: operation.opId
  };
}

describe("offline mutation queue as path transitions of one file identity", () => {
  it("keeps A -> B -> C as two idempotent moves after reboot", () => {
    const original = state();
    expect(queueRename(original, "A.md", "B.md", "rename-a-b")).toBe(true);
    expect(queueRename(original, "B.md", "C.md", "rename-b-c")).toBe(true);
    expect(localPaths(original).has("A.md")).toBe(false);
    expect(localPaths(original).has("B.md")).toBe(false);
    expect(localPaths(original).get("C.md")).toEqual(identity);

    const afterRestart = JSON.parse(JSON.stringify(original));
    const first = afterRestart.pending[0];
    acknowledgePending(afterRestart, receipt(first, 11));
    expect(afterRestart.baselines["B.md"]).toEqual(identity);
    expect(localPaths(afterRestart).get("C.md")).toEqual(identity);
    const second = afterRestart.pending[0];
    acknowledgePending(afterRestart, receipt(second, 12));
    expect(afterRestart.pending).toEqual([]);
    expect(afterRestart.baselines).toEqual({ "C.md": identity });
  });

  it("tracks rename -> delete of the moved file without an intermediate baseline", () => {
    const value = state();
    expect(queueRename(value, "A.md", "folder/B.md", "rename-a-b")).toBe(true);
    expect(queueDelete(value, "folder/B.md", "delete-b")).toBe(true);
    expect(localPaths(value).size).toBe(0);
    expect(value.pending.map((op) => op.type)).toEqual(["rename", "delete"]);
    acknowledgePending(value, receipt(value.pending[0], 13));
    acknowledgePending(value, receipt(value.pending[0], 14));
    expect(value.baselines).toEqual({});
    expect(value.pending).toEqual([]);
  });

  it("supports A -> B -> A, preserving the original file ID", () => {
    const value = state();
    expect(queueRename(value, "A.md", "B.md", "rename-a-b")).toBe(true);
    expect(queueRename(value, "B.md", "A.md", "rename-b-a")).toBe(true);
    expect(localPaths(value).get("A.md")).toEqual(identity);
    acknowledgePending(value, receipt(value.pending[0], 13));
    acknowledgePending(value, receipt(value.pending[0], 14));
    expect(value.baselines).toEqual({ "A.md": identity });
  });

  it("keeps independent identities separate when another tracked path exists", () => {
    const value = state();
    value.baselines["C.md"] = {
      fileId: "file-bbbb", generationId: "generation-bbbb", hash: "other", revision: 1
    };
    expect(queueRename(value, "A.md", "C.md", "rename-a-c")).toBe(false);
    expect(queueDelete(value, "unknown.md", "delete-unknown")).toBe(false);
    expect(value.pending).toEqual([]);
    expect(value.baselines["A.md"]).toEqual(identity);
  });

  it("rejects mismatched or forged receipts without changing local state", () => {
    const value = state();
    queueRename(value, "A.md", "B.md", "rename-a-b");
    const before = JSON.stringify(value);
    expect(() => acknowledgePending(value, {
      ...receipt(value.pending[0], 11), opId: "different-op"
    })).toThrow(/different queued operation/);
    expect(JSON.stringify(value)).toBe(before);
    expect(() => acknowledgePending(value, {
      ...receipt(value.pending[0], 11), toPath: "secret.md"
    })).toThrow(/different queued operation/);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("blocks a confirmed destination collision before removing the source", () => {
    const value = state();
    queueRename(value, "A.md", "B.md", "rename-a-b");
    value.baselines["B.md"] = {
      fileId: "file-other", generationId: "generation-other", hash: "other", revision: 1
    };
    const before = JSON.stringify(value);
    expect(() => acknowledgePending(value, receipt(value.pending[0], 11)))
      .toThrow(/destination already/);
    expect(JSON.stringify(value)).toBe(before);
  });
});
