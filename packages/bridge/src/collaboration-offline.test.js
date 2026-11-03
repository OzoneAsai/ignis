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
