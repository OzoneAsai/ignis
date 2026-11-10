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
  it("does not display a green synced badge with a missing Yjs ancestor", () => {
    expect(mobileConnectionState({...joined,causalGap:true},"open"))
      .toEqual({kind:"syncing",label:"共同編集履歴を修復中"});
  });

  it("shows an IME candidate as unfinished even if the provisional network save was acknowledged", () => {
    const provisional = { ...joined, composing: true, compositionPublished: true };
    const indicator = mobileConnectionState(provisional, "open");
    expect(indicator.kind).toBe("syncing");
    expect(indicator.label).toContain("変換中");
    expect(indicator.label).not.toBe("同期済み");
    expect(mobileConnectionState(provisional, "open", "clean", 0, "en").label)
      .toContain("Converting");
  });

  it("still prioritizes save failures and offline over IME status", () => {
    const provisional = { ...joined, composing: true };
    expect(mobileConnectionState({
      ...provisional, serverSaveError: true,
    }, "open").kind).toBe("error");
    expect(mobileConnectionState(provisional, "closed").kind).toBe("offline");
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
  it("never hides an independently protected offline original behind a plain offline icon", () => {
    const state=mobileConnectionState({
      ...joined,generationMismatch:"new-id",joinConflictReason:"independent",
      pendingConflict:"important offline original"
    },"closed");
    expect(state).toEqual({kind:"error",label:"オフライン・要確認"});
    expect(mobileConnectionState({...joined,storageError:Error("disk")},
      "closed","clean",0,"en").label).toContain("needs review");
    expect(mobileConnectionState({...joined,dirty:true},"closed").kind)
      .toBe("offline");
  });
});
