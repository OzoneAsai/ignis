import { describe, expect, it } from "vitest";
import { mobileConnectionState } from "./mobile-connection-state.js";

const joined = {
  hydrated: true, initialized: true, joined: true,
  dirty: false, sentSeq: 4, confirmedSeq: 4,
};

describe("mobile WebUI connection and durability indicator", () => {
  it("shows WebSocket transport even when no note is open", () => {
    expect(mobileConnectionState(null, "connecting").label).toBe("接続中…");
    expect(mobileConnectionState(null, "closed").label).toBe("オフライン");
    expect(mobileConnectionState(null, "open").label).toBe("サーバー接続");
  });
  it("respects Obsidian's configured English locale", () => {
    expect(mobileConnectionState(null, "open", "clean", 0, "en").label)
      .toBe("Server connected");
    expect(mobileConnectionState(joined, "open", "clean", 0, "en").label)
      .toBe("Synced");
  });
  it("never equates socket open with a completed collaboration join", () => {
    expect(mobileConnectionState({ ...joined, joined: false }, "open").kind)
      .toBe("connecting");
    expect(mobileConnectionState({ ...joined, initialized: false }, "open").kind)
      .toBe("connecting");
    expect(mobileConnectionState({ ...joined, joined: false, dirty: true }, "open").kind)
      .toBe("connecting");
  });
  it("shows the save confirmation separately from a live socket", () => {
    expect(mobileConnectionState(joined, "open").label).toBe("同期済み");
    expect(mobileConnectionState({ ...joined, sentSeq: 5 }, "open").kind).toBe("syncing");
    expect(mobileConnectionState(joined, "open", "pending").kind).toBe("syncing");
    expect(mobileConnectionState({ ...joined, dirty: true }, "open").kind).toBe("syncing");
  });
  it("prioritizes offline status and flags unsaved errors on a live connection", () => {
    expect(mobileConnectionState({ ...joined, dirty: true }, "closed").kind)
      .toBe("offline");
    expect(mobileConnectionState({ ...joined, storageError: Error("disk") }, "open").kind)
      .toBe("error");
    expect(mobileConnectionState(joined, "open", "clean", 2).kind).toBe("error");
    expect(mobileConnectionState({ ...joined, pendingConflict: "old" }, "open").kind)
      .toBe("error");
  });
});
