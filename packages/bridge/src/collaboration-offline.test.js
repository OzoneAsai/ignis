import { describe, expect, it, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { clearDocument, IndexeddbPersistence } from "y-indexeddb";
import { createOfflineDocument, collaborationStorageKey } from "./collaboration-offline.js";

describe("IndexedDB offline CRDT lifecycle", () => {
  const key = collaborationStorageKey("offline-lab", "draft.md");

  beforeEach(async () => {
    await clearDocument(key);
  });

  afterEach(async () => {
    await clearDocument(key);
  });

  it("retains offline changes through editor tab teardown and rehydration", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    expect(await first.ready).toBe(false);
    first.text.insert(0, "From server");
    await first.markInitialized();
    first.text.insert(11, " offline addition");
    await first.close();

    const reopened = createOfflineDocument("offline-lab", "draft.md");
    expect(await reopened.ready).toBe(true);
    expect(reopened.text.toString()).toBe("From server offline addition");
    await reopened.close();
  });

  it("distinguishes an initialized empty note from a never-synced note", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    expect(await first.ready).toBe(false);
    await first.markInitialized();
    await first.close();

    const next = createOfflineDocument("offline-lab", "draft.md");
    expect(await next.ready).toBe(true);
    expect(next.text.toString()).toBe("");
    await next.close();
  });

  it("isolates vault IDs and paths", () => {
    expect(collaborationStorageKey("a", "b.md")).not.toBe(
      collaborationStorageKey("b", "a.md"),
    );
    expect(collaborationStorageKey("a", "b.md")).not.toBe(
      collaborationStorageKey("a", "other.md"),
    );
  });

  it("merges independent offline writes from two tabs when reopened", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    const second = createOfflineDocument("offline-lab", "draft.md");
    await Promise.all([first.ready, second.ready]);
    first.text.insert(0, "Alice ");
    second.text.insert(0, "Bob ");
    await Promise.all([first.close(), second.close()]);

    const next = createOfflineDocument("offline-lab", "draft.md");
    expect(await next.ready).toBe(true);
    expect(next.text.toString()).toContain("Alice ");
    expect(next.text.toString()).toContain("Bob ");
    await next.close();
  });

  it("synchronizes two open browser tabs locally without any server", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    const second = createOfflineDocument("offline-lab", "draft.md");
    await Promise.all([first.ready, second.ready]);
    first.text.insert(0, "Alice offline ");

    async function until(condition) {
      for (let i = 0; i < 80; i++) {
        if (condition()) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      throw new Error("Timed out waiting for a same-browser offline update");
    }

    await until(() => second.text.toString().includes("Alice offline "));
    second.text.insert(second.text.length, "Bob offline");
    await until(() => first.text.toString() === second.text.toString());

    const expected = first.text.toString();
    expect(expected).toContain("Alice offline ");
    expect(expected).toContain("Bob offline");
    await Promise.all([first.close(), second.close()]);

    const reopened = createOfflineDocument("offline-lab", "draft.md");
    await reopened.ready;
    expect(reopened.text.toString()).toBe(expected);
    await reopened.close();
  });

  it("buffers cross-tab messages during IME composition until explicitly released", async () => {
    let composing = true;
    const editor = createOfflineDocument("offline-lab", "draft.md", () => {}, () => composing);
    const peer = createOfflineDocument("offline-lab", "draft.md");
    await Promise.all([editor.ready, peer.ready]);
    peer.text.insert(0, "REMOTE PEER ");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(editor.text.toString()).not.toContain("REMOTE PEER");

    // The completed local input is committed before the buffered peer update.
    editor.text.insert(0, "日本語");
    composing = false;
    editor.flushPeerUpdates();
    expect(editor.text.toString()).toContain("日本語");
    expect(editor.text.toString()).toContain("REMOTE PEER");
    await Promise.all([editor.close(), peer.close()]);
  });

  it("keeps a replaced note generation in a separate durable journal", async () => {
    const old = createOfflineDocument("offline-lab", "draft.md");
    await old.ready;
    old.text.insert(0, "Offline edits to deleted original");
    await old.markInitialized();
    const newId = "11111111-1111-4111-8111-111111111111";
    await old.activateGeneration(newId, old.text.toString());
    await old.close();

    const replacement = createOfflineDocument("offline-lab", "draft.md");
    expect(await replacement.ready).toBe(false);
    expect(replacement.activeGeneration).toBe(newId);
    expect(replacement.text.toString()).toBe("");
    expect(await replacement.recoverReplacedDraft())
      .toBe("Offline edits to deleted original");
    replacement.text.insert(0, "A genuinely new note");
    await replacement.markInitialized();
    await replacement.close();

    const reopened = createOfflineDocument("offline-lab", "draft.md");
    expect(await reopened.ready).toBe(true);
    expect(reopened.text.toString()).toBe("A genuinely new note");
    expect(await reopened.recoverReplacedDraft())
      .toBe("Offline edits to deleted original");
    await reopened.clearReplacedDraft();
    await reopened.close();

    expect(await clearDocument(key)).toBeUndefined();
    // The selected new-generation journal must also be released before cleanup.
    await clearDocument(`${key}:generation:${newId}`);
  });

  it("never exchanges CRDT updates between tabs with different document generations", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    const second = createOfflineDocument("offline-lab", "draft.md");
    await Promise.all([first.ready, second.ready]);
    const oldId = "11111111-1111-4111-8111-111111111111";
    const newId = "22222222-2222-4222-8222-222222222222";
    first.stageServerIdentity(oldId);
    second.stageServerIdentity(newId);
    first.text.insert(0, "OLD DOCUMENT");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second.text.toString()).toBe("");
    second.text.insert(0, "NEW DOCUMENT");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(first.text.toString()).toBe("OLD DOCUMENT");
    await Promise.all([first.close(), second.close()]);
  });

  it("compacts more than 512 committed updates without dropping a character", async () => {
    const first = createOfflineDocument("offline-lab", "draft.md");
    await first.ready;
    const text = first.text;

    for (let i = 0; i < 530; i++) {
      text.insert(text.length, "x");
    }

    await first.close();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction("updates", "readonly")
        .objectStore("updates").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(count).toBeLessThanOrEqual(25);

    const next = createOfflineDocument("offline-lab", "draft.md");
    await next.ready;
    expect(next.text.toString()).toBe("x".repeat(530));
    await next.close();
  });

  it("reads old y-indexeddb journals without discarding preexisting notes", async () => {
    const document = new Y.Doc();
    const legacy = new IndexeddbPersistence(key, document);
    await legacy.whenSynced;
    document.getText("content").insert(0, "Legacy offline draft");
    await legacy.set("initialized", 1);
    await legacy.destroy();
    document.destroy();

    const recovered = createOfflineDocument("offline-lab", "draft.md");
    expect(await recovered.ready).toBe(true);
    expect(recovered.text.toString()).toBe("Legacy offline draft");
    await recovered.close();
  });
});
