import { describe, expect, it } from "vitest";
import {
  classifyAbsence, classifySnapshotAbsence, readChangesThrough,
  retainDeletionProofs
} from "./reconcile.ts";

const baseline = {
  fileId: "file-1", generationId: "generation-1",
  hash: "digest-1", revision: 2
};
const deletion = {
  seq: 4, type: "delete", path: "note.md",
  fileId: "file-1", generationId: "generation-1"
};
describe("journal-backed remote deletion classification", () => {
  it("requires a matching durable tombstone, not a missing path", () => {
    expect(classifyAbsence("note.md", baseline, new Set(), []))
      .toBe("unverified");
    expect(classifyAbsence("note.md", baseline, new Set(), [
      { ...deletion, fileId: "other" }
    ])).toBe("unverified");
    expect(classifyAbsence("note.md", baseline, new Set(), [
      { ...deletion, generationId: "other" }
    ])).toBe("unverified");
    expect(classifyAbsence("note.md", baseline, new Set(), [
      { ...deletion, type: "rename", toPath: "new.md" }
    ])).toBe("unverified");
    expect(classifyAbsence("note.md", baseline, new Set(), [deletion]))
      .toBe("tombstone");
    expect(classifyAbsence("note.md", baseline,
      new Set(["note.md"]), [deletion])).toBe("present");
  });
  it("never judges post-manifest local receipts against an older remote snapshot", () => {
    expect(classifySnapshotAbsence("new.md", baseline, undefined,
      new Set(), [])).toBe("post-snapshot");
    expect(classifySnapshotAbsence("new.md", baseline,
      { ...baseline, fileId: "old" }, new Set(), [deletion]))
      .toBe("post-snapshot");
    expect(classifySnapshotAbsence("note.md", baseline,
      { ...baseline, hash: "old" }, new Set(), [deletion]))
      .toBe("post-snapshot");
    expect(classifySnapshotAbsence("note.md", baseline, { ...baseline },
      new Set(), [deletion])).toBe("tombstone");
    expect(classifySnapshotAbsence("note.md", baseline, { ...baseline },
      new Set(["note.md"]), [])).toBe("present");
  });
  it("persists only matching identity tombstones and drops proofs after generation changes", () => {
    const tracked = { "note.md": { ...baseline } };
    const result = retainDeletionProofs({}, tracked, [
      { ...deletion, seq: 1, fileId: "unrelated" },
      { ...deletion, seq: 4 }
    ]);
    expect(result["note.md"]).toEqual({
      seq: 4, fileId: baseline.fileId, generationId: baseline.generationId
    });
    expect(classifySnapshotAbsence("note.md", baseline, { ...baseline },
      new Set(), [], result["note.md"])).toBe("tombstone");
    expect(retainDeletionProofs(result, { "note.md": {
      ...baseline, generationId: "other-generation"
    } }, [])).toEqual({});
  });
  it("replays all pages and stops at a snapshot's exact cursor", async () => {
    const events = Array.from({ length: 1200 }, (_, i) => ({
      ...deletion, seq: i + 1
    }));
    const seen = [];
    const result = await readChangesThrough(0, 1001, async (since, limit) => {
      seen.push(since);
      return { vaultSeq: 1200,
        changes: events.filter((x) => x.seq > since).slice(0, limit) };
    });
    expect(seen).toEqual([0, 500, 1000]);
    expect(result).toHaveLength(1001);
    expect(result.at(-1).seq).toBe(1001);
  });
  it("refuses missing or non-contiguous history instead of skipping a deletion", async () => {
    await expect(readChangesThrough(0, 3, async () => ({
      vaultSeq: 3, changes: [{ ...deletion, seq: 2 }]
    }))).rejects.toThrow(/Gap/);
    await expect(readChangesThrough(0, 3, async () => ({
      vaultSeq: 3, changes: []
    }))).rejects.toThrow(/cannot advance/);
    await expect(readChangesThrough(0, 3, async () => ({
      vaultSeq: 2, changes: [{ ...deletion, seq: 1 }]
    }))).rejects.toThrow(/incomplete/);
  });
});
