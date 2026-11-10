// Bootstrap data for a previously opened vault. Obsidian performs some sync
// filesystem reads during startup, so these records must hydrate the existing
// in-memory filesystem *before* the application script starts executing.
const DB_NAME = "ignis-collab-offline-bootstrap-v1";
const MAX_BOOT_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILES_BYTES = 14 * 1024 * 1024;
const MAX_NOTES = 80;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("vaults");
      db.createObjectStore("notes");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Offline bootstrap database blocked"));
  });
}

function getOne(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function putOne(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function noteKey(vaultId, notePath) {
  return JSON.stringify([vaultId, notePath]);
}

function validPreviewPath(path) {
  return typeof path === "string" && path.toLowerCase().endsWith(".md") &&
    !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every(part => part && part !== "." && part !== ".." &&
      ![".obsidian", ".git", ".trash", ".ignis-connector"].includes(part.toLowerCase()));
}

// Offline startup metadata is a snapshot from the last ONLINE bootstrap, but
// a newly created note may have entered durable local storage AFTER it.
// Its saved content is recoverable; without its metadata Obsidian omits the
// note from the Vault entirely on a mobile offline restart. Layer later
// locally persisted previews on top of that earlier snapshot, marking their
// origin so an online manifest can replace/delete them without pretending
// they were already confirmed by the server.
export function offlinePreviewMetadata(snapshot, entries) {
  const tree = snapshot?.bootstrap?.tree || {};
  const baseTime = snapshot?.savedAt || 0;
  const recovered = {};
  for (const entry of entries || []) {
    if (!validPreviewPath(entry?.path) || typeof entry?.content !== "string" ||
        !Number.isSafeInteger(entry.savedAt) || entry.savedAt < baseTime ||
        Object.hasOwn(tree, entry.path)) continue;
    const size = new TextEncoder().encode(entry.content).byteLength;
    if (size > MAX_FILE_BYTES) continue;
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (!Object.hasOwn(tree, parent) && !Object.hasOwn(recovered, parent)) {
        recovered[parent] = { type: "directory", offlineRecovery: true };
      }
    }
    recovered[entry.path] = {
      type: "file", size, mtime: entry.savedAt, ctime: entry.savedAt,
      offlineRecovery: true,
    };
  }
  return recovered;
}

function isBootstrapFile(path) {
  if (/^\.obsidian\/[^/]+\.json$/.test(path)) {
    return true;
  }

  return /^\.obsidian\/plugins\/[^/]+\/(main\.js|manifest\.json|styles\.css|data\.json)$/.test(path);
}

export async function saveOfflineBootstrap(vaultId, bootstrap, contentCache) {
  const data = {
    bootstrap,
    files: {},
    savedAt: Date.now(),
  };
  let bytes = 0;

  for (const path of Object.keys(bootstrap.tree || {})) {
    if (!isBootstrapFile(path)) {
      continue;
    }

    const content = contentCache.get(path);

    if (typeof content !== "string") {
      continue;
    }

    const length = new TextEncoder().encode(content).byteLength;

    if (length > MAX_FILE_BYTES || bytes + length > MAX_FILES_BYTES) {
      continue;
    }

    bytes += length;
    data.files[path] = content;
  }

  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_BOOT_BYTES) {
    throw new Error("Vault metadata is too large for the offline bootstrap cache");
  }

  const db = await openDatabase();

  try {
    await putOne(db, "vaults", vaultId, data);
  } finally {
    db.close();
  }
}

export async function loadOfflineBootstrap(vaultId) {
  const db = await openDatabase();

  try {
    const snapshot = await getOne(db, "vaults", vaultId);

    if (!snapshot) {
      return null;
    }

    const notes = {};
    const transaction = db.transaction("notes", "readonly");
    const store = transaction.objectStore("notes");
    const entries = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    for (const entry of entries) {
      if (entry.vaultId === vaultId && typeof entry.content === "string") {
        notes[entry.path] = entry.content;
      }
    }

    return {
      ...snapshot, notes,
      previewMetadata: offlinePreviewMetadata(snapshot,
        entries.filter(entry => entry.vaultId === vaultId)),
    };
  } finally {
    db.close();
  }
}

export async function saveOfflineNote(vaultId, notePath, content) {
  if (!vaultId || !validPreviewPath(notePath) ||
      new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) {
    return false;
  }

  const db = await openDatabase();

  try {
    await putOne(db, "notes", noteKey(vaultId, notePath), {
      vaultId,
      path: notePath,
      content,
      savedAt: Date.now(),
    });

    // Bound the number of local note previews; the complete CRDT history
    // remains in y-indexeddb, independent of this startup cache.
    const transaction = db.transaction("notes", "readonly");
    const store = transaction.objectStore("notes");
    const entries = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const ours = entries.filter((entry) => entry.vaultId === vaultId)
      .sort((left, right) => right.savedAt - left.savedAt);

    if (ours.length > MAX_NOTES) {
      await new Promise((resolve, reject) => {
        const cleanup = db.transaction("notes", "readwrite");

        for (const entry of ours.slice(MAX_NOTES)) {
          cleanup.objectStore("notes").delete(noteKey(entry.vaultId, entry.path));
        }

        cleanup.oncomplete = resolve;
        cleanup.onerror = () => reject(cleanup.error);
        cleanup.onabort = () => reject(cleanup.error);
      });
    }
    return true;
  } finally {
    db.close();
  }
}
