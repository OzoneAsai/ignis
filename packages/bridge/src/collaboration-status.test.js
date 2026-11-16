import { describe, expect, it } from "vitest";
import { collaborationStatus, collaborationStatusSummary } from "./collaboration-status.js";

const ready = {
  hydrated: true,
  initialized: true,
  joined: true,
  participants: 2,
  dirty: false,
  sentSeq: 4,
  confirmedSeq: 4,
};

describe("collaboration save state projection", () => {
  it("keeps a readable short IME label while full details preserve save/peer facts", () => {
    const current={...ready,composing:true,compositionPublished:true,
      imeProjectionBlocked:true,serverSaveError:false};
    const short=collaborationStatusSummary(current,true);
    expect(short).toBe("競合保留中 · IME未確定");
    expect(short.length).toBeLessThan(24);
    expect(collaborationStatus(current,true)).toContain("peer edit waiting");
    expect(collaborationStatusSummary({...current,serverSaveError:true},true))
      .toContain("サーバー保存失敗");
    expect(collaborationStatusSummary({...current,storageError:Error("full")},true))
      .toContain("ローカル保存失敗");
  });
  it("never calls unfinished Japanese IME text a final saved edit", () => {
    const provisional = {
      ...ready, composing: true, compositionPublished: true,
    };
    const s = collaborationStatus(provisional, true);
    expect(s).toContain("IME not confirmed");
    expect(s).toContain("draft");
    expect(s).not.toContain("online · saved");
  });

  it("separates an overlapping peer edit waiting for IME from transport health", () => {
    const s = collaborationStatus({
      ...ready, composing: true, imeProjectionBlocked: true,
      compositionPublished: true, sentSeq: 7, confirmedSeq: 6,
    }, true);
    expect(s).toContain("syncing");
    expect(s).toContain("IME not confirmed");
    expect(s).toContain("peer edit waiting");
    expect(s).not.toContain("server save failed");
  });

  it("keeps failure and offline truth visible even while candidate text is unconfirmed", () => {
    expect(collaborationStatus({
      ...ready, composing: true, storageError: Error("full"),
    }, true)).toMatch(/local storage failed.*IME not confirmed/);
    expect(collaborationStatus({ ...ready, composing: true }, false))
      .toMatch(/offline.*IME not confirmed/);
    expect(collaborationStatus({
      ...ready, composing: true, imeProjectionBlocked: true,
      serverSaveError: Error("network"),
    }, true)).toMatch(/server save failed.*peer edit waiting/);
  });
  it("distinguishes an unrelated offline original from a known document generation replacement", () => {
    expect(collaborationStatus({
      generationMismatch: "new-server-id", joinConflictReason: "independent",
    }, true)).toContain("separate original · draft protected");
    expect(collaborationStatus({
      generationMismatch: "new-server-id", joinConflictReason: "replaced",
    }, true)).toContain("note replaced · old draft protected");
  });

  it("distinguishes server-confirmed saves from syncing", () => {
    expect(collaborationStatus(ready, true)).toBe("Collab: 2 online · saved");
    expect(collaborationStatus({ ...ready, sentSeq: 5 }, true))
      .toContain("syncing");
    expect(collaborationStatus({ ...ready, dirty: true }, true))
      .toContain("syncing");
  });
  it("does not call a connected but causally incomplete Yjs document saved", () => {
    const incomplete = { ...ready, causalGap: true };
    expect(collaborationStatus(incomplete,true)).toContain("recovering missing shared history");
    expect(collaborationStatus(incomplete,true)).not.toContain("online · saved");
    expect(collaborationStatus(incomplete,false)).toContain("history incomplete");
  });

  it("does not let a recovery copy hide an unconfirmed remote save", () => {
    const status = collaborationStatus({
      ...ready,
      pendingConflict: "Old content",
      sentSeq: 6,
    }, true);
    expect(status).toContain("syncing");
    expect(status).toContain("recovered draft available");
    expect(status).not.toContain(" · saved");
  });

  it("does not confuse local durability with a server save", () => {
    expect(collaborationStatus({ ...ready, pendingConflict: "old" }, false))
      .toContain("offline · saved on device");
    expect(collaborationStatus({ ...ready, localSaving: true }, false))
      .toContain("offline · saving locally");
    expect(collaborationStatus({ ...ready, identitySaving: true }, true))
      .toContain("saving to device");
  });

  it("puts storage failure and generation mismatch ahead of saving", () => {
    expect(collaborationStatus({
      ...ready, generationMismatch: "next", pendingConflict: "old", dirty: true,
    }, true)).toContain("note replaced · old draft protected");
    expect(collaborationStatus({
      ...ready, generationMismatch: "next", storageError: new Error("disk"),
    }, true)).toContain("local storage failed");
  });

  it("shows errors even with a recovered draft pending", () => {
    expect(collaborationStatus({
      ...ready, pendingConflict: "old", serverSaveError: true,
    }, true)).toContain("server save failed");
    expect(collaborationStatus({
      ...ready, pendingConflict: "old", protocolError: "rejected",
    }, true)).toContain("synchronization error");
  });

  it("handles empty, loading and reconnecting sessions", () => {
    expect(collaborationStatus(null, false)).toBe("");
    expect(collaborationStatus({ ...ready, hydrated: false }, true)).toContain("loading local draft");
    expect(collaborationStatus({ ...ready, initialized: false }, false))
      .toContain("note unavailable");
    expect(collaborationStatus({ ...ready, joined: false }, true))
      .toContain("reconnecting");
  });
});
