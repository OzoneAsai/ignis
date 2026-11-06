import { describe, expect, it, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { loadOfflineBootstrap, saveOfflineBootstrap, saveOfflineNote } from "./offline-boot.js";

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
});
