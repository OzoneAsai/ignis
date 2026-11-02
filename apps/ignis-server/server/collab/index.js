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

let manager = null;

function normalizeNotePath(notePath) {
  if (typeof notePath !== "string" || !notePath || notePath.length > 2048) {
    return null;
  }

  const normalized = notePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (!normalized.toLowerCase().endsWith(".md") || normalized.includes("\0")) {
    return null;
  }

  return normalized;
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

function createCollaborationManager({ wss, getVaultPath, dataRoot, writeCoalescer }) {
  const rooms = new Map();
  const loading = new Map();
  const channel = wss.channel(CHANNEL);
  const stateDir = path.join(dataRoot, "collaboration");

  function idFor(vaultId, relPath) {
    return JSON.stringify([vaultId, relPath]);
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
    const bytes = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    const content = room.text.toString();
    const temp = `${room.statePath}.${process.pid}.tmp`;

    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(temp, bytes);
    await fs.promises.rename(temp, room.statePath);
    const writeCanonical = () => fs.promises.writeFile(room.filePath, content, "utf-8");

    if (writeCoalescer?.supersedePending) {
      // Serialize behind in-flight conventional writes and atomically supersede
      // queued stale snapshots before writing the CRDT's canonical content.
      await writeCoalescer.supersedePending(room.filePath, writeCanonical);
    } else {
      await writeCanonical();
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

    if (rooms.has(roomId)) {
      return rooms.get(roomId);
    }

    if (loading.has(roomId)) {
      return loading.get(roomId);
    }

    const operation = (async () => {
      const stat = await fs.promises.stat(filePath);

      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) {
        throw new Error("Not a supported Markdown file");
      }

      const diskText = await fs.promises.readFile(filePath, "utf-8");
      const digest = crypto.createHash("sha256").update(roomId).digest("hex");
      const statePath = path.join(stateDir, `${digest}.yjs`);
      const doc = new Y.Doc();
      const text = doc.getText("content");
      const saved = await fs.promises.readFile(statePath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }

        return null;
      });

      if (saved) {
        Y.applyUpdate(doc, saved);
        // Preserve Yjs identity while acknowledging offline/external file edits.
        applyTextChange(text, text.toString(), diskText, "external");
      } else if (diskText) {
        text.insert(0, diskText);
      }

      const room = {
        id: roomId,
        path: relPath,
        vaultId,
        filePath,
        statePath,
        doc,
        text,
        members: new Set(),
        pending: Promise.resolve(),
        timer: null,
      };

      doc.on("update", (update, origin) => {
        broadcast(room, "update", { update: Buffer.from(update).toString("base64") }, origin);
        schedulePersist(room);
      });

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
      broadcast(room, "presence", { participants: room.members.size });

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

  channel.on("join", async (msg, ws) => {
    try {
      const room = await openRoom(ws.ignisVaultId, msg.path);

      if (ws.readyState !== ws.OPEN) {
        return;
      }

      room.members.add(ws);
      send(ws, "init", {
        path: room.path,
        state: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
        participants: room.members.size,
      });
      broadcast(room, "presence", { participants: room.members.size });
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
    } catch {
      send(ws, "error", { path: relPath, error: "Invalid collaboration update" });
    }
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

async function flushAll() {
  await manager?.flushAll();
}

module.exports = {
  CHANNEL,
  normalizeNotePath,
  applyTextChange,
  createCollaborationManager,
  register,
  getActive,
  flushAll,
};
