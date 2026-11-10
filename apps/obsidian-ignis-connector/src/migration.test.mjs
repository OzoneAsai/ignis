import { describe, expect, it } from "vitest";
import { migrationVersionPath, isMigrationRecordCurrent, migrationNeedsPreservation,
  migrationCardLabel } from "./migration.ts";

const HASH = "a".repeat(64);
const REMOTE_HASH = "b".repeat(64);
describe("lossless migration naming and source identity", () => {
  it("keeps folder/extension and uses independent device and server origins", () => {
    const local = migrationVersionPath("Work/Design.md", "device", "device-abc", HASH);
    const remote = migrationVersionPath("Work/Design.md", "server", "generation-xyz", REMOTE_HASH);
    expect(local).toMatch(/^Work\/Design \(Ignis device device-abc a{12}\)\.md$/);
    expect(remote).toMatch(/^Work\/Design \(Ignis server generation-x b{12}\)\.md$/);
    expect(local).not.toBe(remote);
    expect(migrationVersionPath("Work/Design.md", "device", "device-def", HASH)).not.toBe(local);
    expect(migrationVersionPath("Work/Design.md", "device", "device-abc", REMOTE_HASH)).not.toBe(local);
    expect(migrationVersionPath("Work/Design.md", "device", "device-abc", HASH, 1)).not.toBe(local);
  });
  it("keeps Unicode intact without exceeding common path component limits", () => {
    const filename = "日本語🦋".repeat(100) + ".md";
    const result = migrationVersionPath("Folder/" + filename, "device", "phone", HASH);
    expect(result).toContain("日本語🦋");
    expect(new TextEncoder().encode(result.split("/").at(-1)).length).toBeLessThanOrEqual(230);
    expect(result).toMatch(/\.md$/);
  });
  it("rejects unsafe identity, digest, invalid ordinal and escape paths", () => {
    expect(() => migrationVersionPath("../A.md", "device", "phone", HASH)).toThrow();
    expect(() => migrationVersionPath("A.md", "device", "phone/evil", HASH)).toThrow();
    expect(() => migrationVersionPath("A.md", "device", "phone", "x")).toThrow();
    expect(() => migrationVersionPath("A.md", "server", "phone", HASH, -1)).toThrow();
  });
  it("requires matching scope, local bytes, server bytes and remote generation", () => {
    const remote = { hash: REMOTE_HASH, fileId: "fileA", generationId: "generationA" };
    const state = { scope: "server|vault", path: "A.md", sourceHash: HASH,
      sourceCopy: "A (copy).md", remoteHash: REMOTE_HASH,
      remoteCopy: "A (remote).md", remoteFileId: "fileA",
      remoteGenerationId: "generationA" };
    expect(isMigrationRecordCurrent(state, state.scope, HASH, remote)).toBe(true);
    expect(isMigrationRecordCurrent(state, "different|vault", HASH, remote)).toBe(false);
    expect(isMigrationRecordCurrent(state, state.scope, REMOTE_HASH, remote)).toBe(false);
    expect(isMigrationRecordCurrent(state, state.scope, HASH, { ...remote, generationId: "generationB" })).toBe(false);
  });
  it("recognizes distinct path and generation conflicts, not arbitrary transfer errors", () => {
    expect(migrationNeedsPreservation("Existing on both devices")).toBe(true);
    expect(migrationNeedsPreservation("Live editor blocked; local draft retained")).toBe(true);
    expect(migrationNeedsPreservation("Replaced document generation")).toBe(true);
    expect(migrationNeedsPreservation("Unsent create; retained until acknowledged")).toBe(false);
  });
  it("keeps distinguishing filename endings visible on narrow migration cards", () => {
    const mac = migrationCardLabel("Folder/Twelfth-Collision-20261109-MacFirst.md");
    const sls = migrationCardLabel("Folder/Twelfth-Collision-20261109-SLSFirst.md");
    expect(mac).not.toBe(sls);
    expect(mac).toContain("MacFirst.md");
    expect(sls).toContain("SLSFirst.md");
    expect(migrationCardLabel("Folder/short.md")).toBe("short.md");
  });
});
