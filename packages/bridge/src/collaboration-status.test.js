import { describe, expect, it } from "vitest";
import { collaborationStatus } from "./collaboration-status.js";

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
  it("distinguishes server-confirmed saves from syncing", () => {
    expect(collaborationStatus(ready, true)).toBe("Collab: 2 online · saved");
    expect(collaborationStatus({ ...ready, sentSeq: 5 }, true))
      .toContain("syncing");
    expect(collaborationStatus({ ...ready, dirty: true }, true))
      .toContain("syncing");
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
