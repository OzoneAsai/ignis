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
const CURSOR_LIMITS = require("../../../../packages/server-core/src/collab-cursor-limits.json");
const MAX_CURSOR_BYTES = CURSOR_LIMITS.maxEncodedCursorChars;
// Bound per-message work and WebSocket payload size. If an editor exceeds
// this limit it receives an explicit error; no selection is silently dropped.
const MAX_SELECTIONS = CURSOR_LIMITS.maxSelections;
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
      // A new native-only note does not exist on an empty Ignis server yet.
      // This is a missing file, not a generic collaboration failure. Keep a
      // differently-cased existing name distinct to protect canonical rooms.
      if (!entries.some(name => name.toLowerCase() === part.toLowerCase())) {
        const missing = new Error("Note not found");
        missing.code = "ENOENT";
        throw missing;
      }
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

  async function saveRecoveryCopy(room, bytes, label) {
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const ext = path.extname(room.filePath);
    const stem = path.basename(room.filePath, ext);
    const candidate = path.join(path.dirname(room.filePath),
      stem + " (Ignis " + label + " " + digest.slice(0, 16) + ")" + ext);
    const existing = await fs.promises.readFile(candidate).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (existing && !existing.equals(bytes)) {
      throw new Error("External conflict recovery path is occupied");
    }
    if (!existing) {
      let recovery;
      try {
        recovery = await fs.promises.open(candidate, "wx", 0o600);
        await recovery.writeFile(bytes);
        await recovery.sync();
        await recovery.close();
        recovery = null;
        const parent = await fs.promises.open(path.dirname(candidate), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } catch (e) {
        throw new Error("Could not durably save recovery before Yjs projection", { cause: e });
      } finally {
        await recovery?.close().catch(() => {});
      }
    }
    return path.basename(candidate);
  }

  async function recoverExternalProjection(room, desiredContent, desiredDigest) {
    // The last acknowledged projection is the common ancestor between CRDT
    // and filesystem editors. Neither branch may erase an independent edit.
    let parent = getVaultPath(room.vaultId);
    for (const segment of room.path.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      const state = await fs.promises.lstat(parent);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error("Collaborative note's parent is no longer a regular directory");
      }
    }
    // Do not follow a replaced final-path symlink or block forever opening a
    // FIFO which another process substituted after the room was initialized.
    const handle = await fs.promises.open(room.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0)).catch((e) => {
      if (e.code === "ENOENT" || e.code === "ELOOP") return null;
      throw e;
    });
    let disk = null;
    if (handle) {
      try {
        const before = await handle.stat({ bigint: true });
        if (before.isFile() && before.size <= BigInt(MAX_NOTE_BYTES)) {
          disk = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          if (after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
              after.ctimeNs !== before.ctimeNs || disk.length !== Number(before.size)) {
            throw new Error("Collaborative note changed during verification");
          }
        }
      } finally {
        await handle.close();
      }
    }
    if (!disk) {
      // A deleted or replaced on-disk note cannot be silently resurrected.
      // Retain the unsaved live Yjs branch as a visible recovery note instead.
      const copy = await saveRecoveryCopy(
        room, Buffer.from(desiredContent, "utf8"), "Yjs recovery"
      );
      const error = new Error(
        "Canonical note was removed or replaced; Yjs content saved as " + copy
      );
      error.code = "EXTERNAL_NOTE_REPLACED";
      // Only the recovery basename is intentionally disclosed to the client.
      // Never serialize arbitrary filesystem error.message values.
      error.clientMessage = "Canonical note replaced; Yjs content saved as " + copy;
      throw error;
    }
    const diskDigest = crypto.createHash("sha256").update(disk).digest("hex");
    if (diskDigest === room.projectedDigest || diskDigest === desiredDigest) {
      return;
    }
    // A hash-named conflict sibling is discoverable by ordinary Vault sync.
    const copy = await saveRecoveryCopy(room, disk, "external conflict");
    return "External disk edit preserved as " + copy;
  }

  async function persist(room) {
    // Only acknowledge updates included in this exact on-disk snapshot.
    const acknowledgements = room.acks.splice(0);
    const bytes = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    const content = room.text.toString();
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    let recoveryNotice = null;

    try {
      await fs.promises.mkdir(stateDir, { recursive: true });
      recoveryNotice = await recoverExternalProjection(room, content, digest);
      aw