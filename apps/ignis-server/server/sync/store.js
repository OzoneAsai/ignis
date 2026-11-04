// One server-owned SQLite journal for ordinary Vault files. The native Obsidian
// connector is an edge cache, never a second conflict authority.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { resolveVaultPath } = require("@ignis/server-core");

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRS = new Set([".obsidian", ".git", ".ignis-connector"]);

function permittedPath(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 2048 ||
      rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") ||
      rel.split("/").some((p) => !p || p === "." || p === "..")) {
    return false;
  }
  const parts = rel.split("/");
  return !parts.some((part) => SKIPPED_DIRS.has(part) ||
    part.startsWith(".ignis-sync-tmp-") || part.startsWith(".ignis-collab-tmp-"));
}

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Binary assets use the SAME conditional operation and revision journal as
// Markdown. The base64 JSON preview is deliberately capped for mobile; large
// attachments will use resumable blobs in a later protocol version.
function operationBytes(input) {
  const text = typeof input.content === "string" &&
    input.contentBase64 === undefined;
  const binary = typeof input.contentBase64 === "string" &&
    input.content === undefined;
  if (text === binary) {
    const error = new Error("Specify exactly one of content or contentBase64");
    error.status = 400;
    throw error;
  }
  if (binary && typeof input.path === "string" &&
      input.path.toLowerCase().endsWith(".md")) {
    const error = new Error("Markdown must be supplied as UTF-8 text");
    error.status = 400;
    throw error;
  }
  if (text) {
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length <= MAX_TEXT_BYTES) return bytes;
  } else {
    const value = input.contentBase64;
    if (value.length <= Math.ceil(MAX_BINARY_BYTES / 3) * 4 &&
        value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      const bytes = Buffer.from(value, "base64");
      if (bytes.length <= MAX_BINARY_BYTES &&
          bytes.toString("base64") === value) return bytes;
    }
  }
  const error = new Error("Sync payload exceeds the mobile-safe limit or has invalid base64");
  error.status = 413;
  throw error;
}

function withTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

async function inspectFile(absolute) {
  const stat = await fs.promises.lstat(absolute).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const digest = crypto.createHash("sha256");
  for await (const block of fs.createReadStream(absolute)) digest.update(block);
  return { hash: digest.digest("hex"), size: stat.size };
}

// The API never resolves a remote path through a symlinked parent.
async function safeFile(root, rel, createParents = false) {
  if (!permittedPath(rel)) throw conflict("INVALID_PATH", "Path excluded from sync");
  const absolute = resolveVaultPath(root, rel);
  if (!absolute) throw conflict("INVALID_PATH", "Invalid Vault path");
  let cursor = root;
  const segments = rel.split("/");
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    let stat = await fs.promises.lstat(cursor).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat && createParents) {
      await fs.promises.mkdir(cursor).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      stat = await fs.promises.lstat(cursor);
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw conflict("INVALID_PATH", "Parent folder is not a regular directory");
    }
  }
  return absolute;
}

async function durableWrite(target, contents, exclusive = false) {
  const tmp = path.join(path.dirname(target),
    ".ignis-sync-tmp-" + crypto.randomUUID());
  let handle;
  try {
    handle = await fs.promises.open(tmp, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      // Hard-link creation is atomic and fails rather than replacing an
      // unrelated file created between our preflight and the write.
      await fs.promises.link(tmp, target);
      await fs.promises.unlink(tmp);
    } else {
      await fs.promises.rename(tmp, target);
    }
    const dir = await fs.promises.open(path.dirname(target), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

class VaultSyncStore {
  constructor({ dataRoot, getVaultPath, collaboration, writeCoalescer }) {
    fs.mkdirSync(path.join(dataRoot, "sync"), { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, "sync", "vault.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS vaults (vault_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0);",
      "CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, generation_id TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);",
      "CREATE UNIQUE INDEX IF NOT EXISTS active_file_path ON files(vault_id, path) WHERE deleted=0;",
      "CREATE UNIQUE INDEX IF NOT EXISTS active_document_generation ON files(vault_id, generation_id) WHERE deleted=0;",
      "CREATE INDEX IF NOT EXISTS files_by_vault ON files(vault_id, deleted);",
      "CREATE TABLE IF NOT EXISTS changes (vault_id TEXT NOT NULL, seq INTEGER NOT NULL, file_id TEXT NOT NULL, generation_id TEXT NOT NULL, type TEXT NOT NULL, path TEXT NOT NULL, to_path TEXT, hash TEXT, size INTEGER, op_id TEXT, PRIMARY KEY(vault_id, seq));",
      "CREATE TABLE IF NOT EXISTS operations (vault_id TEXT NOT NULL, op_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(vault_id, op_id));",
    ].join("\n"));
    this.getVaultPath = getVaultPath;
    this.collaboration = collaboration;
    this.writeCoalescer = writeCoalescer;
    this.locks = new Map();
    this.listeners = new Set();
  }

  close() { this.db.close(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (e) { console.warn("[sync] notify:", e.message); }
    }
  }
  locked(vaultId, operation) {
    const previous = this.locks.get(vaultId) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const tail = task.catch(() => {});
    this.locks.set(vaultId, tail);
    tail.finally(() => { if (this.locks.get(vaultId) === tail) this.locks.delete(vaultId); });
    return task;
  }
  root(vaultId) {
    const root = this.getVaultPath(vaultId);
    if (!root) {
      const e = new Error("Vault not found");
      e.status = 404;
      throw e;
    }
    return root;
  }
  head(vaultId) {
    return this.db.prepare("SELECT seq FROM vaults WHERE vault_id=?").get(vaultId)?.seq || 0;
  }
  fileByPath(vaultId, rel) {
    return this.db.prepare("SELECT * FROM files WHERE vault_id=? AND path=? AND deleted=0").get(vaultId, rel);
  }
  fileById(vaultId, id) {
    return this.db.prepare("SELECT * FROM files WHERE vault_id=? AND file_id=? AND deleted=0").get(vaultId, id);
  }
  manifest(vaultId) {
    this.root(vaultId);
    return { vaultId, vaultSeq: this.head(vaultId), files: this.db.prepare(
      "SELECT file_id AS fileId, generation_id AS generationId, path, revision, hash, size FROM files WHERE vault_id=? AND deleted=0 ORDER BY path"
    ).all(vaultId) };
  }
  changes(vaultId, since, limit = 200) {
    this.root(vaultId);
    return { vaultId, vaultSeq: this.head(vaultId), changes: this.db.prepare(
      "SELECT seq, file_id AS fileId, generation_id AS generationId, type, path, to_path AS toPath, hash, size, op_id AS opId FROM changes WHERE vault_id=? AND seq>? ORDER BY seq LIMIT ?"
    ).all(vaultId, since, limit) };
  }
  _record(vaultId, type, file, toPath = null, opId = null, requestHash = null) {
    const event = withTransaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO vaults(vault_id,seq) VALUES (?,0)").run(vaultId);
      this.db.prepare("UPDATE vaults SET seq=seq+1 WHERE vault_id=?").run(vaultId);
      const seq = this.head(vaultId);
      if (type === "delete") {
        this.db.prepare("UPDATE files SET deleted=1,revision=revision+1 WHERE file_id=?").run(file.file_id);
      } else if (type === "rename") {
        this.db.prepare("UPDATE files SET path=?,revision=revision+1 WHERE file_id=?").run(toPath, file.file_id);
      } else if (type === "create") {
        this.db.prepare("INSERT INTO files(file_id,vault_id,generation_id,path,revision,hash,size,deleted) VALUES(?,?,?,?,?,?,?,0)")
          .run(file.file_id, vaultId, file.generation_id, file.path, 1, file.hash, file.size);
      } else if (type === "identity") {
        // Prefer the existing CRDT history during migration over arbitrary
        // metadata generations created by the earlier file-only Sync store.
        this.db.prepare("UPDATE files SET generation_id=?,revision=revision+1 WHERE file_id=?")
          .run(file.generation_id, file.file_id);
      } else {
        this.db.prepare("UPDATE files SET hash=?,size=?,revision=revision+1 WHERE file_id=?")
          .run(file.hash, file.size, file.file_id);
      }
      const event = {
        vaultId, seq, fileId: file.file_id, generationId: file.generation_id,
        type, path: file.path, toPath, hash: type === "delete" ? null : file.hash,
        size: type === "delete" ? null : file.size, opId
      };
      this.db.prepare("INSERT INTO changes(vault_id,seq,file_id,generation_id,type,path,to_path,hash,size,op_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(vaultId, seq, file.file_id, file.generation_id, type,
          file.path, toPath, event.hash, event.size, opId);
      if (opId) {
        this.db.prepare("INSERT INTO operations(vault_id,op_id,request_hash,result) VALUES(?,?,?,?)")
          .run(vaultId, opId, requestHash, JSON.stringify(event));
      }
      return event;
    });
    this.notify(event);
    return event;
  }
  async _filesOnDisk(root) {
    const result = new Map();
    const visit = async (rel) => {
      const dir = path.join(root, rel);
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const child = rel ? rel + "/" + entry.name : entry.name;
        if (!permittedPath(child) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) {
          const absolute = path.join(root, child);
          // The old Ignis shim can acknowledge a coalesced write before
          // its delayed disk flush. Drain it before hashing the canonical
          // on-disk source; never journal a known stale snapshot.
          await this.writeCoalescer.flushPending(absolute);
          const snapshot = await inspectFile(absolute);
          if (snapshot) result.set(child, snapshot);
        }
      }
    };
    await visit("");
    return result;
  }
  async _scan(vaultId) {
    const root = this.root(vaultId);
    const disk = await this._filesOnDisk(root);
    const known = this.db.prepare("SELECT * FROM files WHERE vault_id=? AND deleted=0").all(vaultId);
    const knownPaths = new Set(known.map((f) => f.path));
    const histories = new Map();
    const newByIdentity = new Map();
    for (const rel of disk.keys()) {
      const historic = rel.toLowerCase().endsWith(".md") ?
        this.collaboration.peekDocumentId?.(vaultId, rel) : null;
      if (!historic) continue;
      histories.set(rel, historic);
      if (!knownPaths.has(rel)) {
        if (!newByIdentity.has(historic)) newByIdentity.set(historic, []);
        newByIdentity.get(historic).push(rel);
      }
    }
    for (const file of known) {
      const actual = disk.get(file.path);
      if (!actual) {
        const matching = newByIdentity.get(file.generation_id) || [];
        // The Yjs document generation survives an ordinary filesystem move.
        // A unique matching history is proof of continuity; a mere matching
        // hash or basename is not. Ambiguity fails closed as delete/create.
        if (matching.length === 1 && disk.has(matching[0])) {
          const destination = matching[0];
          const moved = disk.get(destination);
          this._record(vaultId, "rename", file, destination);
          if (moved.hash !== file.hash || moved.size !== file.size) {
            this._record(vaultId, "modify", {
              ...file, path: destination, ...moved
            });
          }
          disk.delete(destination);
        } else {
          this._record(vaultId, "delete", file);
        }
      } else {
        const historic = histories.get(file.path);
        if (historic && historic !== file.generation_id) {
          file.generation_id = historic;
          this._record(vaultId, "identity", file);
        }
        // A live Yjs room may not have projected its edit to disk yet.
        // Its authoritative stream must not be interpreted as a disk edit.
        if ((actual.hash !== file.hash || actual.size !== file.size) &&
            !this.collaboration.getActive(vaultId, file.path)) {
          this._record(vaultId, "modify", { ...file, ...actual });
        }
      }
      disk.delete(file.path);
    }
    for (const [rel, snapshot] of disk) {
      this._record(vaultId, "create", {
        file_id: crypto.randomUUID(),
        generation_id: histories.get(rel) || crypto.randomUUID(),
        path: rel, ...snapshot
      });
    }
    return this.manifest(vaultId);
  }
  scan(vaultId) { return this.locked(vaultId, () => this._scan(vaultId)); }

  // One generation per logical note, shared by conventional file sync and
  // Yjs. New Yjs rooms inherit the durable Vault generation. Existing Yjs
  // history is authoritative during a one-time migration.
  ensureDocumentId(vaultId, rel, historicDocumentId = null) {
    return this.locked(vaultId, async () => {
      if (!permittedPath(rel) || !rel.toLowerCase().endsWith(".md")) {
        throw conflict("INVALID_PATH", "Invalid collaborative path");
      }
      await this._scan(vaultId);
      const file = this.fileByPath(vaultId, rel);
      if (!file) {
        const e = new Error("Collaborative note not found");
        e.status = 404;
        throw e;
      }
      if (historicDocumentId && historicDocumentId !== file.generation_id) {
        this._record(vaultId, "identity", {
          ...file, generation_id: historicDocumentId
        });
        return historicDocumentId;
      }
      return file.generation_id;
    });
  }

  // Called after the Yjs snapshot, Markdown projection and baseline marker
  // are durable, before any "saved" ACK to the editor. The active room
  // suppresses watcher-based competing text modifications.
  recordCollaborationSave(vaultId, rel, documentId, digest, byteLength) {
    return this.locked(vaultId, async () => {
      let current = this.fileByPath(vaultId, rel);
      if (!current) {
        await this._scan(vaultId);
        current = this.fileByPath(vaultId, rel);
      }
      if (!current) throw conflict("STALE_MANIFEST", "Collaborative note missing");
      if (current.generation_id !== documentId) {
        current = { ...current, generation_id: documentId };
        this._record(vaultId, "identity", current);
      }
      if (current.hash !== digest || current.size !== byteLength) {
        return this._record(vaultId, "modify", {
          ...current, hash: digest, size: byteLength
        });
      }
      return null;
    });
  }

  async read(vaultId, fileId) {
    const file = this.fileById(vaultId, fileId);
    if (!file) {
      const e = new Error("File not found");
      e.status = 404;
      throw e;
    }
    const absolute = await safeFile(this.root(vaultId), file.path);
    await this.writeCoalescer.flushPending(absolute);
    const bytes = await fs.promises.readFile(absolute);
    if (hash(bytes) !== file.hash) {
      throw conflict("STALE_MANIFEST", "File changed; retry manifest");
    }
    return { file, bytes };
  }
  async apply(vaultId, input) {
    return this.locked(vaultId, async () => {
      const root = this.root(vaultId);
      if (!input || !["create", "modify", "delete", "rename"].includes(input.type) ||
          typeof input.opId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.opId)) {
        const e = new Error("Invalid operation");
        e.status = 400;
        throw e;
      }
      const requestHash = hash(Buffer.from(JSON.stringify(input)));
      const previous = this.db.prepare(
        "SELECT request_hash,result FROM operations WHERE vault_id=? AND op_id=?"
      ).get(vaultId, input.opId);
      if (previous) {
        if (previous.request_hash !== requestHash) throw conflict("OP_ID_REUSED", "Operation ID reused");
        return JSON.parse(previous.result);
      }
      // Validate the payload before creating any missing parent directories.
      const payload = ["create", "modify"].includes(input.type) ?
        operationBytes(input) : null;
      await this._scan(vaultId);
      const rel = input.path;
      const absolute = await safeFile(root, rel, input.type === "create");
      let file = this.fileByPath(vaultId, rel);
      if (input.type === "create") {
        if (file) {
          throw conflict("CREATE_CONFLICT", "Create requires an unused path");
        }
        const bytes = payload;
        await durableWrite(absolute, bytes, true);
        file = { file_id: crypto.randomUUID(), generation_id: crypto.randomUUID(),
          path: rel, hash: hash(bytes), size: bytes.length };
        return this._record(vaultId, "create", file, null, input.opId, requestHash);
      }
      if (!file || file.file_id !== input.fileId ||
          file.generation_id !== input.generationId) {
        throw conflict("GENERATION_MISMATCH", "File identity changed");
      }
      if (input.baseHash !== file.hash) {
        throw conflict("BASE_MISMATCH", "File was edited on another device");
      }
      if (input.type === "modify") {
        const bytes = payload;
        if (this.collaboration.isCollaborative(vaultId, rel)) {
          throw conflict("COLLABORATIVE_WRITE_CONFLICT", "Use Yjs for collaborative Markdown");
        }
        if (hash(bytes) !== file.hash) {
          await this.writeCoalescer.flushPending(absolute);
          await durableWrite(absolute, bytes);
        }
        return this._record(vaultId, "modify", { ...file,
          hash: hash(bytes), size: bytes.length }, null, input.opId, requestHash);
      }
      if (input.type === "delete") {
        await this.writeCoalescer.flushPending(absolute);
        if (rel.toLowerCase().endsWith(".md")) {
          await this.collaboration.deleteNote(vaultId, rel,
            () => fs.promises.unlink(absolute));
        } else {
          this.collaboration.checkLivePath(vaultId, rel);
          await fs.promises.unlink(absolute);
        }
        return this._record(vaultId, "delete", file, null, input.opId, requestHash);
      }
      const dest = input.toPath;
      const destAbsolute = await safeFile(root, dest);
      if (dest === rel || this.fileByPath(vaultId, dest) ||
          await fs.promises.lstat(destAbsolute).catch(() => null)) {
        throw conflict("DESTINATION_EXISTS", "Destination already exists");
      }
      await this.writeCoalescer.flushPending(absolute);
      if (rel.endsWith(".md") && dest.endsWith(".md")) {
        await this.collaboration.renameNote(vaultId, rel, dest,
          () => fs.promises.rename(absolute, destAbsolute),
          () => fs.promises.rename(destAbsolute, absolute));
      } else {
        if (this.collaboration.isCollaborative(vaultId, rel)) {
          throw conflict("COLLABORATIVE_FILE_OPERATION_CONFLICT", "Cannot change collaborative file type");
        }
        await fs.promises.rename(absolute, destAbsolute);
      }
      return this._record(vaultId, "rename", file, dest, input.opId, requestHash);
    });
  }
}

module.exports = { VaultSyncStore, permittedPath, hash, safeFile, operationBytes };
