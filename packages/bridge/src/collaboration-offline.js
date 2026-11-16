import * as Y from "yjs";

// The v1 name and object-store schema intentionally match y-indexeddb. Existing
// offline drafts are migrated by reading its append-only Yjs update store.
export function collaborationStorageKey(vault, note) {
  return `ignis-collab-v1:${JSON.stringify([vault, note])}`;
}

const COMPACT_EVERY = 512;
const CROSS_TAB = Symbol("ignis-cross-tab-yjs");
export const CROSS_TAB_ORIGIN = CROSS_TAB;

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("updates")) {
        database.createObjectStore("updates", { autoIncrement: true });
      }

      if (!database.objectStoreNames.contains("custom")) {
        database.createObjectStore("custom");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Offline note database is blocked"));
  });
}

function readSnapshot(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["updates", "custom"], "readonly");
    const updates = transaction.objectStore("updates").getAll();
    const initialized = transaction.objectStore("custom").get("initialized");
    transaction.oncomplete = () => resolve({
      updates: updates.result,
      initialized: Boolean(initialized.result),
    });
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function transactionFor(database, stores) {
  // Chrome supports strict durability; other browsers fall back to default
  // IndexedDB durability rather than silently losing offline support.
  try {
    return database.transaction(stores, "readwrite", { durability: "strict" });
  } catch {
    return database.transaction(stores, "readwrite");
  }
}

function appendUpdate(database, update) {
  return new Promise((resolve, reject) => {
    const transaction = transactionFor(database, ["updates"]);
    transaction.objectStore("updates").add(update);
    // Only this event means the Yjs update transaction actually committed.
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function getMetadata(database, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["custom"], "readonly");
    const request = transaction.objectStore("custom").get(key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function setMetadata(database, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = transactionFor(database, ["custom"]);
    transaction.objectStore("custom").put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function compact(database) {
  return new Promise((resolve, reject) => {
    // Read, merge and replace within the SAME transaction, including updates
    // produced by another tab. Never compact from this tab's partial Y.Doc.
    const transaction = transactionFor(database, ["updates"]);
    const store = transaction.objectStore("updates");
    const request = store.getAll();

    request.onsuccess = () => {
      if (request.result.length >= COMPACT_EVERY) {
        const snapshot = Y.mergeUpdates(request.result);
        store.clear();
        store.add(snapshot);
      }
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createOfflineDocument(
  vaultId, notePath, onDurabilityChange = () => {}, shouldDeferPeerUpdate = () => false,
) {
  const legacyKey = collaborationStorageKey(vaultId, notePath);
  const doc = new Y.Doc();
  const text = doc.getText("content");
  let localRevision = 0;
  let savedRevision = 0;
  let failure = null;
  let closed = false;
  let pending = Promise.resolve();
  let database = null;
  let activeGeneration = null;
  let localGeneration = null;
  let writesSinceCompaction = 0;
  let peerChannel = null;
  const bufferedPeerUpdates = [];
  const peerId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const announce = () => {
    if (!closed) {
      onDurabilityChange({
        isSaving: savedRevision < localRevision,
        error: failure,
        savedRevision,
        localRevision,
      });
    }
  };

  const ready = openDatabase(legacyKey)
    .then(async (legacy) => {
      activeGeneration = await getMetadata(legacy, "active-generation") || null;
      const db = activeGeneration
        ? await openDatabase(`${legacyKey}:generation:${activeGeneration}`)
        : legacy;

      if (db !== legacy) {
        legacy.close();
      }

      database = db;
      const snapshot = await readSnapshot(db);
      localGeneration = activeGeneration || await getMetadata(db, "server-document-id") || null;

      doc.transact(() => {
        for (const update of snapshot.updates) {
          Y.applyUpdate(doc, update, "offline-hydration");
        }
      }, "offline-hydration");

      // Bind only AFTER hydration, so replay cannot be counted as a new edit.
      doc.on("update", (update, origin) => {
        if (closed) {
          return;
        }

        // A nearby tab receives the same operation immediately, even while
        // the Ignis server is offline. Do not rebroadcast received operations.
        if (origin !== CROSS_TAB) {
          try {
            peerChannel?.postMessage({
              type: "update", sender: peerId, update,
              generation: localGeneration,
              fromServer: origin === "remote",
            });
          } catch (error) {
            console.warn("[collab] Same-browser-tab sync unavailable:", error);
          }
        }

        const revision = ++localRevision;
        announce();
        pending = pending.catch(() => {}).then(async () => {
          // A failed earlier write cannot be made good by a later dependent
          // delta; recover by saving this document's COMPLETE current state.
          const recovering = Boolean(failure);
          const payload = recovering ? Y.encodeStateAsUpdate(doc) : update;
          await appendUpdate(db, payload);
          savedRevision = Math.max(savedRevision, revision);
          failure = null;
          writesSinceCompaction++;
          announce();

          if (writesSinceCompaction >= COMPACT_EVERY) {
            writesSinceCompaction = 0;
            await compact(db);
          }
        }).catch((error) => {
          failure = error;
          announce();
          throw error;
        });
      });

      if (typeof BroadcastChannel !== "undefined") {
        try {
          peerChannel = new BroadcastChannel(
            activeGeneration ? `${legacyKey}:generation:${activeGeneration}` : legacyKey,
          );
          peerChannel.onmessage = ({ data }) => {
            if (closed || data?.sender === peerId ||
                (data?.generation || null) !== localGeneration) {
              return;
            }

            if (data?.type === "sync-request") {
              peerChannel.postMessage({
                type: "update", sender: peerId,
                generation: localGeneration,
                update: Y.encodeStateAsUpdate(doc),
              });
            } else if (data?.type === "update" && data.update instanceof Uint8Array) {
              try {
                if (shouldDeferPeerUpdate()) {
                  bufferedPeerUpdates.push({ update: data.update, fromServer: data.fromServer });
                } else {
                  Y.applyUpdate(doc, data.update, data.fromServer ? "remote" : CROSS_TAB);
                }
              } catch (error) {
                console.warn("[collab] Invalid update from another local tab:", error);
              }
            }
          };
          // Also handles a peer that opened while our IndexedDB was loading.
          peerChannel.postMessage({
            type: "sync-request", sender: peerId, generation: localGeneration,
          });
        } catch (error) {
          console.warn("[collab] Same-browser-tab sync unavailable:", error);
        }
      }

      return snapshot.initialized || snapshot.updates.length > 0;
    }).catch((error) => {
      failure = error;
      announce();
      throw error;
    });

  const persistence = {
    async get(key) {
      await ready;
      return getMetadata(database, key);
    },
    async set(key, value) {
      await ready;
      return setMetadata(database, key, value);
    },
  };

  return {
    doc,
    text,
    persistence,
    ready,
    get status() {
      return { isSaving: savedRevision < localRevision, error: failure };
    },
    get activeGeneration() {
      return activeGeneration;
    },
    stageServerIdentity(documentId) {
      // Label the incoming server snapshot with its generation BEFORE Yjs
      // observers rebroadcast it to other local tabs. This guards the narrow
      // window between joining a room and committing the IDB metadata record.
      localGeneration = documentId;
      peerChannel?.postMessage({
        type: "sync-request", sender: peerId, generation: localGeneration,
      });
    },
    async setServerIdentity(documentId) {
      await persistence.set("server-document-id", documentId);
      this.stageServerIdentity(documentId);
    },
    async recoverReplacedDraft() {
      const pointer = await openDatabase(legacyKey);

      try {
        return await getMetadata(pointer, "replaced-note-recovery") || null;
      } finally {
        pointer.close();
      }
    },
    async clearReplacedDraft() {
      const pointer = await openDatabase(legacyKey);

      try {
        await setMetadata(pointer, "replaced-note-recovery", null);
      } finally {
        pointer.close();
      }
    },
    async activateGeneration(newGeneration, recoveredText, isCurrent = () => true) {
      await ready;
      await pending;

      // An async server handshake can outlive the pane that initiated it.
      // Never repoint a later session's durable journal from a stale callback.
      if (!isCurrent()) return false;

      if (!/^[a-f0-9-]{36}$/.test(newGeneration)) {
        throw new Error("Invalid server document generation");
      }

      // Both metadata changes commit together. The old Yjs journal is never
      // deleted. When the visible text is identical, no duplicate recovery
      // warning is needed; otherwise the human-readable draft persists.
      const pointer = await openDatabase(legacyKey);

      try {
        await new Promise((resolve, reject) => {
          const transaction = transactionFor(pointer, ["custom"]);
          transaction.objectStore("custom").put(recoveredText, "replaced-note-recovery");
          transaction.objectStore("custom").put(newGeneration, "active-generation");
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        pointer.close();
      }
      return true;
    },
    flushPeerUpdates() {
      for (const { update, fromServer } of bufferedPeerUpdates.splice(0)) {
        Y.applyUpdate(doc, update, fromServer ? "remote" : CROSS_TAB);
      }
    },
    async markInitialized() {
      // The empty/nonempty initialization marker must never outrun the
      // accompanying Yjs update. Otherwise an offline reload could see an
      // initialized but incomplete note after an interrupted transaction.
      await pending;
      await persistence.set("initialized", 1);
    },
    async close() {
      closed = true;
      peerChannel?.close();
      try {
        await ready;
        await pending;
      } finally {
        database?.close();
        doc.destroy();
      }
    },
  };
}
