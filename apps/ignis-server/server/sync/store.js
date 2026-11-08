// One server-owned SQLite journal for ordinary Vault files. The native Obsidian
// connector is an edge cache, never a second conflict authority.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { resolveVaultPath } = require("@ignis/server-core");
const { preflightMediaOwnership } = require("../../../../packages/sync-policy/src/preflight");
const { createContentScope } = require("../../../../packages/sync-policy/src/content-scope");
const {
  normalizeMediaBypassExtensions,
} = require("../../../../packages/sync-policy/src/media-bypass");

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRS = new Set([".obsidian", ".git", ".ignis-connector", ".trash"]);

function permittedPath(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 2048 ||
      rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") ||
      rel.split("/").some((p) => !p || p === "." || p === "..")) {
    return false;
  }
  const parts = rel.split("/");
  return !parts.some((part) => {
    const lower = part.toLowerCase();
    return SKIPPED_DIRS.has(lower) ||
      lower.startsWith(".ignis-sync-tmp-") ||
      lower.startsWith(".ignis-collab-tmp-");
  });
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
  const handle = await fs.promises.open(
    absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  ).catch((e) => {
    if (e.code === "ENOENT" || e.code === "ELOOP") return null;
    throw e;
  });
  if (!handle) return null;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(position) !== before.size || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw conflict("FILE_CHANGED_DURING_HASH", "File changed while reading");
    }
    return { hash: digest.digest("hex"), size: position };
  } finally {
    await handle.close();
  }
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
  constructor({ dataRoot, getVaultPath, collaboration, writeCoalescer,
    contentScope = "all", contentScopes = {} }) {
    const baseScope = createContentScope(contentScope);
    if (!contentScopes || typeof contentScopes !== "object" ||
        Array.isArray(contentScopes)) {
      throw new Error("Invalid per-Vault content scopes");
    }
    const overrides = new Map(Object.entries(contentScopes).map(
      ([vaultId, scope]) => {
        if (!vaultId || vaultId.length > 200 ||
            [...vaultId].some((char) => char.charCodeAt(0) < 32 ||
              char.charCodeAt(0) === 127)) {
          throw new Error("Invalid content-scope Vault ID");
        }
        return [vaultId, createContentScope(scope)];
      }
    ));
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
      "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER);",
      "CREATE INDEX IF NOT EXISTS devices_by_vault ON devices(vault_id, revoked_at);",
      "CREATE TABLE IF NOT EXISTS vault_content_scopes (vault_id TEXT PRIMARY KEY, scope TEXT NOT NULL);",
      // Admin-selected choices are the durable override; environment values
      // remain defaults for Vaults with no explicit owner preference.
      "CREATE TABLE IF NOT EXISTS vault_sync_preferences (vault_id TEXT PRIMARY KEY, content_scope TEXT NOT NULL);",
      // Kept separate from the historical two-valued scope for a non-breaking
      // upgrade. Server authorization is the upper bound for every device.
      "CREATE TABLE IF NOT EXISTS vault_sync_media_bypass (vault_id TEXT PRIMARY KEY, extensions_json TEXT NOT NULL);",
    ].join("\n"));
    this.contentScope = baseScope;
    this.contentScopeOverrides = overrides;
    this.getVaultPath = getVaultPath;
    this.collaboration = collaboration;
    this.writeCoalescer = writeCoalescer;
    this.locks = new Map();
    this.listeners = new Set();
    this.revocationListeners = new Set();
  }

  close() { this.db.close(); }

  // Enrollment is performed by the server owner using IGNIS_SYNC_TOKEN.
  // Clients only receive a scoped device token, never the bootstrap secret.
  // Persist a hash rather than reusable bearer credentials in the SQLite DB.
  enrollDevice(vaultId, label) {
    this.root(vaultId);
    if (typeof label !== "string" || label.trim().length < 1 ||
        label.length > 100 || /\p{Cc}/u.test(label)) {
      const e = new Error("Device label must be 1-100 printable characters");
      e.status = 400;
      throw e;
    }
    const deviceId = crypto.randomUUID();
    const token = "ignis_dev_" + crypto.randomBytes(32).toString("base64url");
    const tokenHash = hash(Buffer.from(token, "utf8"));
    const createdAt = Date.now();
    this.db.prepare(
      "INSERT INTO devices(device_id, vault_id, label, token_hash, created_at, revoked_at) VALUES(?,?,?,?,?,NULL)"
    ).run(deviceId, vaultId, label.trim(), tokenHash, createdAt);
    return { deviceId, vaultId, label: label.trim(), createdAt, token };
  }

  // Tailscale Serve already authenticated the user at the network edge.
  // Reuse one revocable server-side principal per user + Vault, with no
  // reusable bearer secret ever sent to Obsidian/iOS. The HMAC namespace is
  // disjoint from device-token hashes; a revoked principal stays revoked.
  ensureTailnetDevice(login, vaultId, adminSecret) {
    this.root(vaultId);
    const key = crypto.createHmac("sha256", adminSecret)
      .update("ignis-tailnet-v1\0" + vaultId + "\0" + login).digest("hex");
    let row = this.db.prepare(
      "SELECT device_id AS deviceId, vault_id AS vaultId, label, revoked_at AS revokedAt FROM devices WHERE token_hash=?"
    ).get(key);
    if (!row) {
      try {
        const deviceId = crypto.randomUUID();
        this.db.prepare(
          "INSERT INTO devices(device_id,vault_id,label,token_hash,created_at,revoked_at) VALUES(?,?,?,?,?,NULL)"
        ).run(deviceId, vaultId, "Tailnet " + login, key, Date.now());
      } catch (e) {
        // Concurrent HTTP and WSS handshakes can race at first connection.
        if (e.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
      }
      row = this.db.prepare(
        "SELECT device_id AS deviceId, vault_id AS vaultId, label, revoked_at AS revokedAt FROM devices WHERE token_hash=?"
      ).get(key);
    }
    if (!row || row.revokedAt != null || row.vaultId !== vaultId) return null;
    return { deviceId: row.deviceId, vaultId: row.vaultId, label: row.label };
  }

  listDevices(vaultId) {
    this.root(vaultId);
    return this.db.prepare(
      "SELECT device_id AS deviceId, vault_id AS vaultId, label, created_at AS createdAt, revoked_at AS revokedAt FROM devices WHERE vault_id=? ORDER BY created_at, device_id"
    ).all(vaultId);
  }

  // Revealing whether a token was ever valid would aid guessing; callers
  // treat a revoked token and an unknown token identically.
  authenticateDevice(token, vaultId) {
    if (typeof token !== "string" ||
        !/^ignis_dev_[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof vaultId !== "string") return null;
    const record = this.db.prepare(
      "SELECT device_id AS deviceId, vault_id AS vaultId, label FROM devices WHERE token_hash=? AND vault_id=? AND revoked_at IS NULL"
    ).get(hash(Buffer.from(token, "utf8")), vaultId);
    return record || null;
  }

  deviceActive(deviceId, vaultId) {
    if (typeof deviceId !== "string" || typeof vaultId !== "string") return false;
    return !!this.db.prepare(
      "SELECT 1 FROM devices WHERE device_id=? AND vault_id=? AND revoked_at IS NULL"
    ).get(deviceId, vaultId);
  }

  revokeDevice(deviceId) {
    if (typeof deviceId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deviceId)) {
      const e = new Error("Invalid device ID");
      e.status = 400;
      throw e;
    }
    const result = this.db.prepare(
      "UPDATE devices SET revoked_at=COALESCE(revoked_at, ?) WHERE device_id=?"
    ).run(Date.now(), deviceId);
    if (result.changes) {
      for (const listener of this.revocationListeners) {
        try { listener(deviceId); } catch (e) { console.warn("[sync] revoke:", e.message); }
      }
    }
    return result.changes > 0;
  }
  onRevoke(fn) {
    this.revocationListeners.add(fn);
    return () => this.revocationListeners.delete(fn);
  }
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
    // Scope belongs to the durable Vault journal, not to an optional binary
    // transport's process status. Never reinterpret previous binary history
    // as a deletion when starting a Markdown-only server.
    const scope = this.db.prepare(
      "SELECT scope FROM vault_content_scopes WHERE vault_id=?"
    ).get(vaultId);
    const desired = this.desiredContentScope(vaultId);
    if (scope?.scope !== desired.mode) {
      // Before the first file or device enrollment, selecting another mode
      // is safe and should not force a migration wizard. After history exists,
      // scope changes require a coordinated handover across all devices.
      const activity = this.db.prepare(
        "SELECT (SELECT COUNT(*) FROM files WHERE vault_id=?)+" +
        "(SELECT COUNT(*) FROM changes WHERE vault_id=?)+" +
        "(SELECT COUNT(*) FROM devices WHERE vault_id=?) AS count"
      ).get(vaultId, vaultId, vaultId);
      if (activity.count && (scope || desired.mode === "markdown-only")) {
        throw conflict("SCOPE_MIGRATION_REQUIRED",
          "An active Vault journal requires an explicit content-scope migration");
      }
    }
    if (!scope) {
      this.db.prepare(
        "INSERT OR IGNORE INTO vault_content_scopes(vault_id,scope) VALUES (?,?)"
      ).run(vaultId, desired.mode);
    } else if (scope.scope !== desired.mode) {
      this.db.prepare(
        "UPDATE vault_content_scopes SET scope=? WHERE vault_id=?"
      ).run(desired.mode, vaultId);
    }
    return root;
  }
  contentScopeFor(vaultId) {
    this.root(vaultId);
    return this.desiredContentScope(vaultId).mode;
  }
  mediaBypassFor(vaultId) {
    if (!this.getVaultPath(vaultId)) {
      const e = new Error("Vault not found");
      e.status = 404;
      throw e;
    }
    const row = this.db.prepare(
      "SELECT extensions_json FROM vault_sync_media_bypass WHERE vault_id=?"
    ).get(vaultId);
    return row ? normalizeMediaBypassExtensions(JSON.parse(row.extensions_json)) :
      normalizeMediaBypassExtensions();
  }
  desiredContentScope(vaultId) {
    const bypass = this.mediaBypassFor(vaultId);
    const preference = this.db.prepare(
      "SELECT content_scope FROM vault_sync_preferences WHERE vault_id=?"
    ).get(vaultId);
    const mode = preference?.content_scope ||
      this.contentScopeOverrides.get(vaultId)?.mode || this.contentScope.mode;
    return createContentScope(mode, bypass);
  }
  permits(vaultId, rel) {
    return this.desiredContentScope(vaultId).allowsPath(rel);
  }
  // Bypass expansion is additive. Reducing it on a Vault with registered
  // devices or history needs a coordinated barrier: otherwise _scan would
  // interpret a previously tracked document as deleted.
  previewMediaBypass(vaultId, requested = null) {
    const current = this.mediaBypassFor(vaultId);
    const next = requested === null ? current :
      normalizeMediaBypassExtensions(requested);
    const removing = current.filter((extension) => !next.includes(extension));
    const activity = this.db.prepare(
      "SELECT (SELECT COUNT(*) FROM files WHERE vault_id=?) AS files," +
      "(SELECT COUNT(*) FROM changes WHERE vault_id=?) AS events," +
      "(SELECT COUNT(*) FROM devices WHERE vault_id=?) AS devices"
    ).get(vaultId, vaultId, vaultId);
    const canApply = removing.length === 0 ||
      !(activity.files || activity.events || activity.devices);
    return {
      vaultId, extensions: current, requestedExtensions: next,
      removedExtensions: removing,
      canApply, reason: canApply ? null : "BYPASS_MIGRATION_REQUIRED",
      trackedFiles: activity.files, journalEvents: activity.events,
      registeredDevices: activity.devices,
    };
  }
  setMediaBypass(vaultId, requested, expected) {
    return this.locked(vaultId, () => {
      const normalized = normalizeMediaBypassExtensions(requested);
      const previous = normalizeMediaBypassExtensions(expected);
      const current = this.mediaBypassFor(vaultId);
      if (JSON.stringify(current) !== JSON.stringify(previous)) {
        throw conflict("BYPASS_CHANGED", "Media bypass configuration changed; refresh");
      }
      const preview = this.previewMediaBypass(vaultId, normalized);
      if (!preview.canApply) {
        throw conflict("BYPASS_MIGRATION_REQUIRED",
          "Removing existing bypass rules requires coordinated journal migration");
      }
      if (JSON.stringify(normalized) === JSON.stringify(current)) {
        return { ...preview, applied: false };
      }
      this.db.prepare(
        "INSERT INTO vault_sync_media_bypass(vault_id,extensions_json) VALUES(?,?)" +
        " ON CONFLICT(vault_id) DO UPDATE SET extensions_json=excluded.extensions_json"
      ).run(vaultId, JSON.stringify(normalized));
      return { ...this.previewMediaBypass(vaultId), applied: true };
    });
  }
  // Inspect without scanning the filesystem, assigning identities, touching
  // the journal, or enabling Syncthing. Read-only and safe on existing Vaults.
  previewContentScope(vaultId, requestedScope = null) {
    if (!this.getVaultPath(vaultId)) {
      const e = new Error("Vault not found");
      e.status = 404;
      throw e;
    }
    const requested = requestedScope === null ? null : createContentScope(requestedScope);
    const persisted = this.db.prepare(
      "SELECT scope FROM vault_content_scopes WHERE vault_id=?"
    ).get(vaultId);
    const preference = this.db.prepare(
      "SELECT content_scope FROM vault_sync_preferences WHERE vault_id=?"
    ).get(vaultId);
    const active = this.db.prepare(
      "SELECT (SELECT COUNT(*) FROM files WHERE vault_id=?) AS trackedFiles," +
      "(SELECT COUNT(*) FROM changes WHERE vault_id=?) AS journalEvents," +
      "(SELECT COUNT(*) FROM devices WHERE vault_id=?) AS registeredDevices"
    ).get(vaultId, vaultId, vaultId);
    const currentScope = persisted?.scope || this.desiredContentScope(vaultId).mode;
    const changed = !!requested && requested.mode !== currentScope;
    const historyExists = active.trackedFiles !== 0 ||
      active.journalEvents !== 0 || active.registeredDevices !== 0;
    const configured = this.desiredContentScope(vaultId).mode;
    const configurationMismatch = !!persisted &&
      persisted.scope !== configured && historyExists;
    return {
      vaultId, contentScope: currentScope,
      source: preference ? "owner" : persisted ? "startup" : "not-enrolled",
      trackedFiles: active.trackedFiles,
      journalEvents: active.journalEvents,
      registeredDevices: active.registeredDevices,
      locked: historyExists,
      canApply: !configurationMismatch && (!changed || !historyExists),
      configurationMismatch,
      requestedScope: requested?.mode || null,
      reason: configurationMismatch ? "CONFIGURATION_MISMATCH" :
        changed && historyExists ? "SCOPE_MIGRATION_REQUIRED" : null,
    };
  }
  setContentScope(vaultId, requestedScope, expectedScope) {
    return this.locked(vaultId, () => {
      const requested = createContentScope(requestedScope);
      createContentScope(expectedScope);
      const preview = this.previewContentScope(vaultId, requested.mode);
      if (preview.contentScope !== expectedScope) {
        throw conflict("SCOPE_CHANGED", "Vault scope changed; refresh before saving");
      }
      if (!preview.canApply) {
        throw conflict(preview.reason || "SCOPE_MIGRATION_REQUIRED",
          "Vault scope requires review of existing history and devices");
      }
      if (preview.source === "owner" && preview.contentScope === requested.mode) {
        return { ...preview, applied: false };
      }
      // Both values commit together; a restart must never momentarily adopt
      // an old environment default or erase an earlier file history.
      withTransaction(this.db, () => {
        this.db.prepare(
          "INSERT INTO vault_sync_preferences(vault_id,content_scope) VALUES(?,?)" +
          " ON CONFLICT(vault_id) DO UPDATE SET content_scope=excluded.content_scope"
        ).run(vaultId, requested.mode);
        this.db.prepare(
          "INSERT INTO vault_content_scopes(vault_id,scope) VALUES(?,?)" +
          " ON CONFLICT(vault_id) DO UPDATE SET scope=excluded.scope"
        ).run(vaultId, requested.mode);
      });
      return { ...this.previewContentScope(vaultId, requested.mode), applied: true };
    });
  }
  // Read-only preview. A history-aware barrier is mandatory before the Vault
  // scanner may ever stop tracking a subtree, or it could generate tombstones.
  preflightMediaOwnership(vaultId, roots) {
    return this.locked(vaultId, () => {
      const activeDeviceCount = this.db.prepare(
        "SELECT COUNT(*) AS count FROM devices WHERE vault_id=? AND revoked_at IS NULL"
      ).get(vaultId).count;
      const self = this;
      function* journalPaths() {
        for (const row of self.db.prepare(
          "SELECT path FROM files WHERE vault_id=?"
        ).iterate(vaultId)) yield row;
        for (const row of self.db.prepare(
          "SELECT path, to_path AS toPath FROM changes WHERE vault_id=?"
        ).iterate(vaultId)) yield row;
      }
      return preflightMediaOwnership({
        vaultRoot: this.root(vaultId), roots,
        journalPaths: journalPaths(), activeDeviceCount,
      });
    });
  }
  head(vaultId) {
    return this.db.prepare("SELECT seq FROM vaults WHERE vault_id=?").get(vaultId)?.seq || 0;
  }
  fileByPath(vaultId, rel) {
    if (!this.permits(vaultId, rel)) return null;
    return this.db.prepare("SELECT * FROM files WHERE vault_id=? AND path=? AND deleted=0").get(vaultId, rel);
  }
  fileById(vaultId, id) {
    const row = this.db.prepare(
      "SELECT * FROM files WHERE vault_id=? AND file_id=? AND deleted=0"
    ).get(vaultId, id);
    return row && this.permits(vaultId, row.path) ? row : null;
  }
  manifest(vaultId) {
    this.root(vaultId);
    return { vaultId, vaultSeq: this.head(vaultId), files: this.db.prepare(
      "SELECT file_id AS fileId, generation_id AS generationId, path, revision, hash, size FROM files WHERE vault_id=? AND deleted=0 ORDER BY path"
    ).all(vaultId).filter((file) => this.permits(vaultId, file.path)) };
  }
  changes(vaultId, since, limit = 200) {
    this.root(vaultId);
    return { vaultId, vaultSeq: this.head(vaultId), changes: this.db.prepare(
      "SELECT seq, file_id AS fileId, generation_id AS generationId, type, path, to_path AS toPath, hash, size, op_id AS opId FROM changes WHERE vault_id=? AND seq>? ORDER BY seq LIMIT ?"
    ).all(vaultId, since, limit) };
  }
  operationReceipt(vaultId, opId) {
    this.root(vaultId);
    if (typeof opId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(opId)) {
      const e = new Error("Invalid operation ID");
      e.status = 400;
      throw e;
    }
    const record = this.db.prepare(
      "SELECT result FROM operations WHERE vault_id=? AND op_id=?"
    ).get(vaultId, opId);
    return record ? JSON.parse(record.result) : null;
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
  async _filesOnDisk(root, vaultId) {
    const result = new Map();
    const oversizedBypass = new Set();
    // Resolve the persisted policy once per scan. A Vault can hold hundreds
    // of thousands of media entries; an SQLite preference lookup for every
    // child would make the Markdown-only preview unnecessarily expensive.
    const contentScope = this.desiredContentScope(vaultId);
    const visit = async (rel) => {
      const dir = path.join(root, rel);
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const child = rel ? rel + "/" + entry.name : entry.name;
        if (!permittedPath(child) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile() && contentScope.allowsPath(child)) {
          const absolute = path.join(root, child);
          // The old Ignis shim can acknowledge a coalesced write before
          // its delayed disk flush. Drain it before hashing the canonical
          // on-disk source; never journal a known stale snapshot.
          await this.writeCoalescer.flushPending(absolute);
          if (contentScope.mode === "markdown-only" &&
              !child.toLowerCase().endsWith(".md")) {
            // A bypass is only a route for mobile-safe small files, never a
            // way to start hashing/advertising a multi-gigabyte media file.
            // Keep oversized entries distinct from missing files: otherwise
            // an existing journal row would be mistaken for a deletion.
            const stat = await fs.promises.lstat(absolute).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (stat && stat.isFile() && stat.size > MAX_BINARY_BYTES) {
              oversizedBypass.add(child);
              continue;
            }
          }
          const snapshot = await inspectFile(absolute);
          if (snapshot) result.set(child, snapshot);
        }
      }
    };
    await visit("");
    return { disk: result, oversizedBypass };
  }
  async _scan(vaultId) {
    const root = this.root(vaultId);
    const { disk, oversizedBypass } = await this._filesOnDisk(root, vaultId);
    const known = this.db.prepare("SELECT * FROM files WHERE vault_id=? AND deleted=0").all(vaultId);
    if (known.some((file) => oversizedBypass.has(file.path))) {
      throw conflict("OVERSIZE_MEDIA_BYPASS",
        "A tracked bypass file exceeds the 4 MiB limit; the journal was left unchanged");
    }
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
    // The native Vault API buffers binary files on mobile, so the preview
    // protocol has a hard limit. Enforce it server-side *before* allocating
    // a response; an authenticated request must not load a 10 GiB attachment.
    const downloadLimit = Math.max(MAX_TEXT_BYTES, MAX_BINARY_BYTES);
    if (file.size > downloadLimit) {
      const e = new Error("File exceeds the preview download limit");
      e.status = 413;
      throw e;
    }
    const absolute = await safeFile(this.root(vaultId), file.path);
    await this.writeCoalescer.flushPending(absolute);
    const pathStat = await fs.promises.lstat(absolute);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw conflict("INVALID_PATH", "File is not a regular file");
    }
    // Open a regular file without following the final symlink. Verify the
    // opened handle, then read at most the size approved by that fstat.
    const handle = await fs.promises.open(
      absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    ).catch((e) => {
      if (e.code === "ELOOP") throw conflict("INVALID_PATH", "File is not a regular file");
      throw e;
    });
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > downloadLimit ||
          stat.size !== file.size) {
        throw conflict("STALE_MANIFEST", "File changed; retry manifest");
      }
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(
          bytes, offset, stat.size - offset, offset
        );
        if (!bytesRead) {
          throw conflict("STALE_MANIFEST", "File changed; retry manifest");
        }
        offset += bytesRead;
      }
      if ((await handle.stat()).size !== stat.size) {
        throw conflict("STALE_MANIFEST", "File changed; retry manifest");
      }
    } finally {
      await handle.close();
    }
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
      if (!this.permits(vaultId, input.path) ||
          (input.type === "rename" && !this.permits(vaultId, input.toPath))) {
        throw conflict("OUT_OF_SCOPE", "File type is excluded from this Vault's sync");
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
      // Scanning at the start of an operation is not enough: a conventional
      // editor can save between the scan and the filesystem mutation. Check
      // the observed file immediately before changing or removing it.
      await this.writeCoalescer.flushPending(absolute);
      const current = await inspectFile(absolute);
      if (!current || current.hash !== file.hash || current.size !== file.size) {
        throw conflict("BASE_MISMATCH", "File changed after the sync precondition");
      }
      if (input.type === "modify") {
        const bytes = payload;
        if (this.collaboration.isCollaborative(vaultId, rel)) {
          throw conflict("COLLABORATIVE_WRITE_CONFLICT", "Use Yjs for collaborative Markdown");
        }
        if (hash(bytes) !== file.hash) {
          await durableWrite(absolute, bytes);
        }
        return this._record(vaultId, "modify", { ...file,
          hash: hash(bytes), size: bytes.length }, null, input.opId, requestHash);
      }
      if (input.type === "delete") {
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
      // A native Vault rename may create its destination folder locally
      // while the remote Vault does not yet have that folder. The server
      // owns projection of the operation's parent directories as well.
      const destAbsolute = await safeFile(root, dest, true);
      const destStat = await fs.promises.lstat(destAbsolute).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      // On default macOS volumes Case.md and case.md name the same inode.
      // A case-only rename must preserve the file identity, while a genuine
      // second directory entry (including a hard link) must never be replaced.
      // Compare actual directory entries instead of approximating filesystem
      // case folding or Unicode normalization with JavaScript string rules.
      let selfAlias = false;
      if (destStat && path.dirname(absolute) === path.dirname(destAbsolute) &&
          destStat.isFile() && !destStat.isSymbolicLink()) {
        const sourceStat = await fs.promises.lstat(absolute);
        const exactEntry = (await fs.promises.readdir(path.dirname(destAbsolute)))
          .includes(path.basename(destAbsolute));
        selfAlias = !exactEntry && sourceStat.isFile() &&
          !sourceStat.isSymbolicLink() &&
          sourceStat.dev === destStat.dev && sourceStat.ino === destStat.ino;
      }
      if (dest === rel || this.fileByPath(vaultId, dest) ||
          (destStat && !selfAlias)) {
        throw conflict("DESTINATION_EXISTS", "Destination already exists");
      }
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
