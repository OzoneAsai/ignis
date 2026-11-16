import { describe, expect, it, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { loadOfflineBootstrap, saveOfflineBootstrap, saveOfflineNote,
  offlinePreviewMetadata } from "./offline-boot.js";

describe("offline bootstrap data", () => {
  afterEach(() => {});

  it("restores core files and a note without network or synchronous XHR", async () => {
    const vaultId = "offline-test-boot";
    const bootstrap = {
      vault: { id: vaultId, version: "1.14.4" },
      vaultList: [{ id: vaultId }],
      tree: {
        ".obsidian/app.json": { type: "file", size: 2 },
        "draft.md": { type: "file", size: 10 },
      },
      plugins: [],
    };
    const contents = new Map([[".obsidian/app.json", "{}"]]);
    await saveOfflineBootstrap(vaultId, bootstrap, { get: (path) => contents.get(path) });
    await saveOfflineNote(vaultId, "draft.md", "offline edit");

    const restored = await loadOfflineBootstrap(vaultId);
    expect(restored.bootstrap.vault.id).toBe(vaultId);
    expect(restored.files[".obsidian/app.json"]).toBe("{}");
    expect(restored.notes["draft.md"]).toBe("offline edit");
  });

  it("makes notes saved after the boot snapshot discoverable on an offline restart", async () => {
    const vaultId = "offline-post-boot-note";
    const bootstrap = {
      vault: { id: vaultId }, vaultList: [{ id: vaultId }],
      tree: { ".obsidian/app.json": { type:"file", size:2 } },plugins: [],
    };
    await saveOfflineBootstrap(vaultId,bootstrap,{get:()=>"{}"});
    await saveOfflineNote(vaultId,"NewFolder/NewNote.md","Device draft: あいう");
    const restored=await loadOfflineBootstrap(vaultId);
    expect(restored.bootstrap.tree["NewFolder/NewNote.md"]).toBeUndefined();
    expect(restored.notes["NewFolder/NewNote.md"]).toBe("Device draft: あいう");
    expect(restored.previewMetadata["NewFolder"])
      .toMatchObject({type:"directory",offlineRecovery:true});
    expect(restored.previewMetadata["NewFolder/NewNote.md"])
      .toMatchObject({type:"file",offlineRecovery:true,
        size:new TextEncoder().encode("Device draft: あいう").byteLength});
  });

  it("does not resurrect an older deleted note from a preview predating a fresh server bootstrap", () => {
    const snapshot={savedAt:2000,bootstrap:{tree:{
      "Existing.md":{type:"file",size:3,mtime:2000}}}};
    const result=offlinePreviewMetadata(snapshot,[
      {path:"Removed.md",content:"old",savedAt:1000},
      {path:"Existing.md",content:"new",savedAt:3000},
      {path:"New.md",content:"fresh",savedAt:3001},
      {path:"../unsafe.md",content:"x",savedAt:3002},
      {path:".obsidian/data.md",content:"x",savedAt:3002},
    ]);
    expect(Object.keys(result)).toEqual(["New.md"]);
    expect(result["New.md"].offlineRecovery).toBe(true);
  });
});
