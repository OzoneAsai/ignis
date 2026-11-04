// Vault-scoped, authoritative Yjs collaboration rooms for Markdown notes.
// The CRDT state lives in DATA_ROOT; Markdown remains the human-readable source.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Y = require("yjs");
const { resolveVaultPath } = require("@ignis/server-core");

const CHANNEL = "collab";
const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const SAVE_DELAY_MS = 120;
const MAX_CURSOR_BYTES = 512;
const DOCUMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CURSOR_COLORS = [
  "#ee6b72", "#59baf2", "#e3ad54", "#ac8cf2",
  "#5ecc9b", "#f288c9", "#6dcacc", "#ef9862",
  "#b8cc61", "#9c9cf4", "#e56a9a", "#65b5e3",
];

let manager = null;

function cleanDisplayName(value, fallback = "Guest") {
  if (typeof value !== "string") {
    return fallback;
  }

  // Display names are untrusted labels, not authenticated identities.
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim().slice(0, 40);
  return name || fallback;
}

function normalizeNotePath(notePath) {
  if (typeof notePath !== "string" || !notePath || notePath.length > 2048) {
    return null;
  }

  const normalized = notePath.replace(/\\/g, "/");

  // Room IDs are document identities, not merely filesystem locators. A path
  // with another spelling of the same file would create two Yjs documents
  // that could overwrite one another's Markdown projection.
  if (!normalized.toLowerCase().endsWith(".md") || normalized.includes("\0") ||
      normalized.startsWith("/") || normalized.includes("//") ||
      normalized.split("/").some((segment) => !segment || segment === "." ||
        segment === "..")) {
    return null;
  }

  return normalized;
}

async function assertCanonicalNotePath(vaultRoot, notePath) {
  // Case-insensitive filesystems (notably default macOS volumes) resolve
  // `Notes.md` and `notes.md` to the same inode. Distinct CRDT room names for
  // those spellings would silently clobber each other's Markdown projection.
  // Check actual directory entries, not realpath(), which retains the caller's
  // spelling on some macOS filesystems.
  let directory = vaultRoot;

  for (const part of notePath.split("/")) {
    const entries = await fs.promises.readdir(directory);

    if (!entries.includes(part)) {
      throw new Error("Noncanonical collaborative note path");
    }

    directory = path.join(directory, part);

    if ((await fs.promises.lstat(directory)).isSymbolicLink()) {
      throw new Error("Collaborative notes cannot be opened through symlink aliases");
    }
  }
}

function applyTextChange(text, before, after, origin) {
  if (before === after) {
    return;
  }

  let prefix = 0;

  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) {
    prefix++;
  }

  let suffix = 0;

  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix++;
  }

  text.doc.transact(() => {
    if (before.length - prefix - suffix) {
      text.delete(prefix, before.length - prefix - suffix);
    }

    if (after.length - prefix - suffix) {
      text.insert(prefix, after.slice(prefix, after.length - suffix));
    }
  }, origin);
}

async function atomicReplace(target, content) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.ignis-collab-tmp-${crypto.randomUUID()}`);
  let handle;

  try {
    handle = await fs.promises.open(temporary, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, target);
    // The rename itself must be durably recorded before an update is ACKed.
    const dir = await fs.promises.open(directory, "r");

    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function createCollaborationManager({
  wss, getVaultPath, dataRoot, writeCoalescer,
  resolveDocumentId, onPersist
}) {
  const rooms = new Map();
  const loading = new Map();
  const mutations = new Set();
  const channel = wss.channel(CHANNEL);
  const stateDir = path.join(dataRoot, "collaboration");

  function idFor(vaultId, relPath) {
    return JSON.stringify([vaultId, relPath]);
  }

  function statePathFor(vaultId, relPath) {
    const digest = crypto.createHash("sha256").update(idFor(vaultId, relPath)).digest("hex");
    return path.join(stateDir, `${digest}.yjs`);
  }

  function protectedPathFor(vaultId, relPath) {
    // The protection marker survives note deletion: an older browser may
    // reconnect before a newly created note has initialized its CRDT room.
    // Without a tombstone, its ordinary queued whole-file autosave could
    // overwrite the replacement before generation IDs can be compared.
    return `${statePathFor(vaultId, relPath)}.protected`;
  }

  function peekDocumentId(vaultId, relPath) {
    const normalized = normalizeNotePath(relPath);
    if (!normalized) return null;
    const current = rooms.get(idFor(vaultId, normalized));
    if (current) return current.documentId;
    // A tombstone or lone marker is not a valid Yjs history.
    const state = statePathFor(vaultId, normalized);
    if (!fs.existsSync(state)) return null;
    try {
      const marker = JSON.parse(fs.readFileSync(state + ".baseline.json", "utf8"));
      return DOCUMENT_ID_PATTERN.test(marker?.documentId) ? marker.documentId : null;
    } catch { return null; }
  }

  function operationConflict() {
    const error = new Error("This collaborative note is in use or has a conflicting history. Close active editors before changing its path.");
    error.code = "COLLABORATIVE_FILE_OPERATION_CONFLICT";
    return error;
  }

  function within(notePath, targetPath) {
    return notePath === targetPath || notePath.startsWith(`${targetPath}/`);
  }

  function hasLiveRoom(vaultId, targetPath) {
    for (const id of [...rooms.keys(), ...loading.keys()]) {
      const [vault, note] = JSON.parse(id);

      if (vault === vaultId && within(note, targetPath)) {
        return true;
      }
    }

    return false;
  }

  function mutationBlocked(vaultId, targetPath) {
    for (const id of mutations) {
      const [vault, name] = JSON.parse(id);

      if (vault === vaultId && (within(targetPath, name) || within(name, targetPath))) {
        return true;
      }
    }

    return false;
  }

  async function withMutation(vaultId, paths, work) {
    const ids = paths.map((notePath) => idFor(vaultId, notePath));

    if (paths.some((notePath) => hasLiveRoom(vaultId, notePath) ||
        mutationBlocked(vaultId, notePath))) {
      throw operationConflict();
    }

    for (const id of ids) {
      mutations.add(id);
    }

    try {
      return await work();
    } finally {
      for (const id of ids) {
        mutations.delete(id);
      }
    }
  }

  async function renameNote(vaultId, source, destination, renameFile, rollbackFile) {
    const from = normalizeNotePath(source);
    const to = normalizeNotePath(destination);

    if (!from || !to || from === to) {
      throw operationConflict();
    }

    return withMutation(vaultId, [from, to], async () => {
      const sourceState = statePathFor(vaultId, from);
      const destinationState = statePathFor(vaultId, to);

      if (fs.existsSync(destinationState) || fs.existsSync(`${destinationState}.baseline.json`)) {
        throw operationConflict();
      }

      const moved = [];
      const files = [[sourceState, destinationState],
        [`${sourceState}.baseline.json`, `${destinationState}.baseline.json`]];

      // Move the readable file first, then both history files. During this
      // interval the mutation lock prevents a new CRDT room being initialized.
      await renameFile();

      try {
        for (const [oldName, newName] of files) {
          if (fs.existsSync(oldName)) {
            await fs.promises.rename(oldName, newName);
            moved.push([oldName, newName]);
          }
        }

        // Only paths with a previous CRDT generation require this tombstone.
        // An ordinary Markdown rename must not accidentally become a CRDT
        // note or require a collaboration state directory to already exist.
        if (moved.length || fs.existsSync(protectedPathFor(vaultId, from))) {
          await fs.promises.mkdir(stateDir, { recursive: true });
          await atomicReplace(protectedPathFor(vaultId, to), "collaborative-path-v1");
        }
      } catch (error) {
        for (const [oldName, newName] of moved.reverse()) {
          await fs.promises.rename(newName, oldName).catch(() => {});
        }

        await rollbackFile?.().catch(() => {});

        throw error;
      }

    });
  }

  async function deleteNote(vaultId, notePath, deleteFile) {
    const normalized = normalizeNotePath(notePath);

    if (!normalized) {
      return deleteFile();
    }

    return withMutation(vaultId, [normalized], async () => {
      const state = statePathFor(vaultId, normalized);
      const saved = [];

      try {
        for (const file of [state, `${state}.baseline.json`]) {
          if (fs.existsSync(file)) {
            const backup = `${file}.deleted-${crypto.randomUUID()}`;
            await fs.promises.rename(file, backup);
            saved.push([file, backup]);
          }
        }

        await deleteFile();
      } catch (error) {
        for (const [file, backup] of saved) {
          await fs.promises.rename(backup, file).catch(() => {});
        }

        throw error;
      }

      await Promise.all(saved.map(([, backup]) => fs.promises.unlink(backup)));
    });
  }

  async function ensureNoHistoricSubtree(vaultId, relativePath, absolutePath) {
    const queue = [absolutePath];

    while (queue.length) {
      const directory = queue.pop();
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const relative = path.relative(absolutePath, full).replace(/\\/g, "/");
          const note = [relativePath, relative].filter(Boolean).join("/");

          if (fs.existsSync(statePathFor(vaultId, note))) {
            throw operationConflict();
          }
        }
      }
    }
  }

  async function assertSafeSubtree(vaultId, relativePath, absolutePath) {
    if (hasLiveRoom(vaultId, relativePath) || mutationBlocked(vaultId, relativePath)) {
      throw operationConflict();
    }

    await ensureNoHistoricSubtree(vaultId, relativePath, absolutePath);
  }

  async function mutateDirectory(vaultId, sourcePath, absolutePath, destinationPath, operation) {
    const names = destinationPath ? [sourcePath, destinationPath] : [sourcePath];

    return withMutation(vaultId, names, async () => {
      await ensureNoHistoricSubtree(vaultId, sourcePath, absolutePath);
      return operation();
    });
  }

  function send(ws, type, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ channel: CHANNEL, type, ...data }));
    }
  }

  function broadcast(room, type, data, except = null) {
    for (const ws of room.members) {
      if (ws !== except) {
        send(ws, type, { path: room.path, ...data });
      }
    }
  }

  async function persist(room) {
    // Only acknowledge updates included in this exact on-disk snapshot.
    const acknowledgements = room.acks.splice(0);
    const bytes = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    const content = room.text.toString();
    const digest = crypto.createHash("sha256").update(content).digest("hex");

    try {
      await fs.promises.mkdir(stateDir, { recursive: true });
      await atomicReplace(room.statePath, bytes);
      const writeCanonical = () => atomicReplace(room.filePath, content);

      if (writeCoalescer?.supersedePending) {
        await writeCoalescer.supersedePending(room.filePath, writeCanonical);
      } else {
        await writeCanonical();
      }

      // Commit record is written LAST. On restart it distinguishes a newer
      // Yjs state that survived a crash from a deliberate external file edit.
      const marker = `${room.statePath}.baseline.json`;
      await atomicReplace(marker, JSON.stringify({ digest, documentId: room.documentId }));

      // The Sync journal and the collaborative Yjs state share the same
      // generation and durable commit boundary. No editor receives "saved"
      // until both the canonical file and its journal position are durable.
      await onPersist?.(
        room.vaultId, room.path, room.documentId,
        digest, Buffer.byteLength(content, "utf8")
      );

      for (const { ws, seq } of acknowledgements) {
        send(ws, "saved", { path: room.path, seq });
      }
    } catch (error) {
      for (const { ws, seq } of acknowledgements) {
        send(ws, "save-error", { path: room.path, seq });
      }

      throw error;
    }
  }

  function schedulePersist(room) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      room.timer = null;
      room.pending = room.pending
        .then(() => persist(room))
        .catch((error) => console.error("[collab] Persistence failed:", error));
    }, SAVE_DELAY_MS);
  }

  async function flush(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
      room.pending = room.pending.then(() => persist(room));
    }

    await room.pending;
  }

  async function openRoom(vaultId, rawPath) {
    const relPath = normalizeNotePath(rawPath);
    const vaultRoot = getVaultPath(vaultId);

    if (!relPath || !vaultRoot) {
      throw new Error("Invalid vault or Markdown path");
    }

    const filePath = resolveVaultPath(vaultRoot, relPath);

    if (!filePath) {
      throw new Error("Path is outside the vault");
    }

    const roomId = idFor(vaultId, relPath);

    if (mutationBlocked(vaultId, relPath)) {
      throw operationConflict();
    }

    if (rooms.has(roomId)) {
      return rooms.get(roomId);
    }

    if (loading.has(roomId)) {
      return loading.get(roomId);
    }

    const operation = (async () => {
      // Establish the CRDT baseline after all conventional pending writes.
      await writeCoalescer?.flushPending?.(filePath);
      await assertCanonicalNotePath(vaultRoot, relPath);
      const stat = await fs.promises.stat(filePath);

      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) {
        throw new Error("Not a supported Markdown file");
      }

      const diskText = await fs.promises.readFile(filePath, "utf-8");
      const diskDigest = crypto.createHash("sha256").update(diskText).digest("hex");
      const statePath = statePathFor(vaultId, relPath);
      const marker = await fs.promises.readFile(`${statePath}.baseline.json`, "utf-8")
        .then((value) => JSON.parse(value)).catch(() => null);
      const doc = new Y.Doc();
      const text = doc.getText("content");
      const saved = await fs.promises.readFile(statePath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }

        return null;
      });
      // A marker without its matching Yjs state is NOT proof that a newly
      // recreated file still belongs to the preceding document generation.
      const historicDocumentId = saved && DOCUMENT_ID_PATTERN.test(marker?.documentId)
        ? marker.documentId
        : null;
      const documentId = await resolveDocumentId?.(
        vaultId, relPath, historicDocumentId
      ) || historicDocumentId || crypto.randomUUID();
      let needsBaseline = !saved || documentId !== marker?.documentId;

      if (saved) {
        Y.applyUpdate(doc, saved);
        if (text.toString() !== diskText) {
          needsBaseline = true;
          const stateStat = await fs.promises.stat(statePath);
          const diskIsExternal = marker?.digest
            ? marker.digest !== diskDigest
            : stat.mtimeMs >= stateStat.mtimeMs;

          if (diskIsExternal) {
            // A changed on-disk file is an independent edit, not an exception.
            applyTextChange(text, text.toString(), diskText, "external");
          } else {
            // CRDT snapshot committed before crash, but Markdown did not.
            // Restore the text projection without destroying CRDT identity.
            const restore = () => fs.promises.writeFile(filePath, text.toString(), "utf-8");

            if (writeCoalescer?.supersedePending) {
              await writeCoalescer.supersedePending(filePath, restore);
            } else {
              await restore();
            }
          }
        }
      } else if (diskText) {
        text.insert(0, diskText);
      }

      const room = {
        id: roomId,
        path: relPath,
        vaultId,
        filePath,
        statePath,
        documentId,
        doc,
        text,
        members: new Set(),
        people: new Map(),
        acks: [],
        pending: Promise.resolve(),
        timer: null,
      };

      doc.on("update", (update, origin) => {
        broadcast(room, "update", { update: Buffer.from(update).toString("base64") }, origin);
        schedulePersist(room);
      });

      // A document generation cannot be advertised to a browser until it has
      // a durable marker. Otherwise a crash between first join and first edit
      // would assign a new generation on restart, stranding an offline draft.
      if (needsBaseline) {
        await persist(room);
      }

      const protection = protectedPathFor(vaultId, relPath);

      if (!fs.existsSync(protection)) {
        await atomicReplace(protection, "collaborative-path-v1");
      }

      rooms.set(roomId, room);
      return room;
    })();

    loading.set(roomId, operation);

    try {
      return await operation;
    } finally {
      loading.delete(roomId);
    }
  }

  function leave(ws, relPath) {
    const key = idFor(ws.ignisVaultId, relPath);
    const room = rooms.get(key);

    if (room && room.members.delete(ws)) {
      room.people.delete(ws);
      announcePresence(room);

      if (room.members.size === 0) {
        flush(room)
          .then(() => {
            if (room.members.size === 0) {
              rooms.delete(room.id);
              room.doc.destroy();
            }
          })
          .catch((error) => console.error("[collab] Final flush failed:", error));
      }
    }
  }

  function peopleIn(room) {
    return [...room.people.values()].map((person) => ({ ...person }));
  }

  function announcePresence(room) {
    broadcast(room, "presence", {
      participants: room.members.size,
      people: peopleIn(room),
    });
  }

  function cursorPosition(encoded, room) {
    if (typeof encoded !== "string" || encoded.length > MAX_CURSOR_BYTES) {
      return null;
    }

    const bytes = Buffer.from(encoded, "base64");

    if (!bytes.length || bytes.length > MAX_CURSOR_BYTES) {
      return null;
    }

    const relative = Y.decodeRelativePosition(bytes);
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, room.doc);
    return absolute && absolute.type === room.text ? encoded : null;
  }

  channel.on("join", async (msg, ws) => {
    try {
      const room = await openRoom(ws.ignisVaultId, msg.path);

      if (ws.readyState !== ws.OPEN) {
        return;
      }

      if (!room.members.has(ws)) {
        room.members.add(ws);
        const used = new Set([...room.people.values()].map((person) => person.color));
        const color = CURSOR_COLORS.find((candidate) => !used.has(candidate)) ||
          CURSOR_COLORS[room.members.size % CURSOR_COLORS.length];
        room.people.set(ws, {
          id: crypto.randomUUID(),
          name: cleanDisplayName(msg.name),
          color,
          anchor: null,
          head: null,
        });
      }

      send(ws, "init", {
        path: room.path,
        documentId: room.documentId,
        state: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
        participants: room.members.size,
        self: { ...room.people.get(ws) },
        people: peopleIn(room),
      });
      announcePresence(room);
    } catch (error) {
      // No filesystem or state-root details are exposed to browser clients.
      send(ws, "error", {
        path: msg.path,
        error: error.code === "ENOENT" ? "Note not found" : "Unable to join note",
      });
    }
  });

  channel.on("leave", (msg, ws) => {
    const relPath = normalizeNotePath(msg.path);

    if (relPath) {
      leave(ws, relPath);
    }
  });

  channel.on("update", (msg, ws) => {
    const relPath = normalizeNotePath(msg.path);
    const room = relPath && rooms.get(idFor(ws.ignisVaultId, relPath));

    if (!room || !room.members.has(ws) || typeof msg.update !== "string") {
      return;
    }

    try {
      if (msg.update.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) + 4) {
        throw new Error("Collaboration update exceeds maximum size");
      }

      const bytes = Buffer.from(msg.update, "base64");

      if (bytes.length > MAX_UPDATE_BYTES) {
        throw new Error("Collaboration update exceeds maximum size");
      }

      Y.applyUpdate(room.doc, bytes, ws);
      if (Number.isSafeInteger(msg.seq) && msg.seq >= 0) {
        room.acks.push({ ws, seq: msg.seq });
        // An unchanged full-state exchange must still receive a durability ACK.
        schedulePersist(room);
      }
    } catch {
      send(ws, "error", { path: relPath, error: "Invalid collaboration update" });
    }
  });

  channel.on("identity", (msg, ws) => {
    const relPath = normalizeNotePath(msg.path);
    const room = relPath && rooms.get(idFor(ws.ignisVaultId, relPath));
    const person = room?.people.get(ws);

    if (!person) {
      return;
    }

    person.name = cleanDisplayName(msg.name, person.name);
    announcePresence(room);
  });

  channel.on("cursor", (msg, ws) => {
    const relPath = normalizeNotePath(msg.path);
    const room = relPath && rooms.get(idFor(ws.ignisVaultId, relPath));
    const person = room?.people.get(ws);

    if (!person) {
      return;
    }

    try {
      const anchor = cursorPosition(msg.anchor, room);
      const head = cursorPosition(msg.head, room);

      if (!anchor || !head) {
        return;
      }

      person.anchor = anchor;
      person.head = head;
      broadcast(room, "cursor", { id: person.id, anchor, head }, ws);
    } catch {
      // Malformed or outdated Yjs positions are ignored, never broadcast.
    }
  });

  channel.on("cursor-away", (msg, ws) => {
    const relPath = normalizeNotePath(msg.path);
    const room = relPath && rooms.get(idFor(ws.ignisVaultId, relPath));
    const person = room?.people.get(ws);

    if (!person) {
      return;
    }

    person.anchor = null;
    person.head = null;
    broadcast(room, "cursor", { id: person.id, anchor: null, head: null }, ws);
  });

  wss.on("connection", (ws) => {
    ws.on("close", () => {
      for (const room of rooms.values()) {
        if (room.members.has(ws)) {
          leave(ws, room.path);
        }
      }
    });
  });

  return {
    peekDocumentId,
    renameNote,
    deleteNote,
    assertSafeSubtree,
    mutateDirectory,
    checkLivePath: (vaultId, relativePath) => {
      if (hasLiveRoom(vaultId, relativePath) || mutationBlocked(vaultId, relativePath)) {
        throw operationConflict();
      }
    },
    isCollaborative(vaultId, notePath) {
      const normalized = normalizeNotePath(notePath);

      return normalized && (
        rooms.has(idFor(vaultId, normalized)) ||
        fs.existsSync(statePathFor(vaultId, normalized)) ||
        fs.existsSync(protectedPathFor(vaultId, normalized)) ||
        mutationBlocked(vaultId, normalized)
      );
    },
    getActive(vaultId, notePath) {
      const normalized = normalizeNotePath(notePath);
      const room = normalized && rooms.get(idFor(vaultId, normalized));
      // Keep native snapshot writes suppressed until the last CRDT flush finishes.
      return room || null;
    },
    async flushAll() {
      await Promise.all([...rooms.values()].map(flush));
    },
    openRoom,
  };
}

function register(opts) {
  manager = createCollaborationManager(opts);
  return manager;
}

function getActive(vaultId, notePath) {
  return manager?.getActive(vaultId, notePath) || null;
}

function peekDocumentId(vaultId, notePath) {
  return manager?.peekDocumentId(vaultId, notePath) || null;
}

function isCollaborative(vaultId, notePath) {
  return manager?.isCollaborative(vaultId, notePath) || false;
}

async function flushAll() {
  await manager?.flushAll();
}

async function renameNote(vaultId, source, destination, renameFile, rollbackFile) {
  return manager
    ? manager.renameNote(vaultId, source, destination, renameFile, rollbackFile)
    : renameFile();
}

async function deleteNote(vaultId, notePath, deleteFile) {
  return manager ? manager.deleteNote(vaultId, notePath, deleteFile) : deleteFile();
}

async function assertSafeSubtree(vaultId, relativePath, absolutePath) {
  return manager?.assertSafeSubtree(vaultId, relativePath, absolutePath);
}

async function mutateDirectory(vaultId, sourcePath, absolutePath, destinationPath, operation) {
  return manager
    ? manager.mutateDirectory(vaultId, sourcePath, absolutePath, destinationPath, operation)
    : operation();
}

function checkLivePath(vaultId, relativePath) {
  return manager?.checkLivePath(vaultId, relativePath);
}

module.exports = {
  CHANNEL,
  cleanDisplayName,
  normalizeNotePath,
  applyTextChange,
  createCollaborationManager,
  register,
  getActive,
  peekDocumentId,
  isCollaborative,
  flushAll,
  renameNote,
  deleteNote,
  assertSafeSubtree,
  mutateDirectory,
  checkLivePath,
};
