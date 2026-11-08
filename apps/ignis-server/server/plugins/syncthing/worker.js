const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SyncthingClient } = require("../../../../../packages/syncthing-control/src/client");
const {
  encodePairingCard, decodePairingCard,
  tailscaleIPv4Candidates, configuredTcpPorts,
} = require("../../../../../packages/syncthing-control/src/pairing-card");
const { prepareEmptyPilotFolder, assertEmptyPilotFolder } =
  require("../../../../../packages/syncthing-control/src/pilot-folder");
const { inspectStorageCapacity } =
  require("../../../../../packages/syncthing-control/src/storage-capacity");

const PROTOCOL = "ignis-sidecar-v1";
const ID = process.env.IGNIS_SIDECAR_ID;
const DATA_DIR = process.env.IGNIS_SIDECAR_DATA_DIR;
const CONNECTION_FILE = path.join(DATA_DIR, "syncthing-connection.json");
// The pilot remains inside the *IGNIS backend plugin's* private data root,
// NOT the Syncthing private home and NOT any existing Vault collection.
const PILOT_SUBDIRECTORY = "pilot-media";

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function overlap(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}

function validFolderId(value) {
  if (typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(value)) {
    throw new Error("Invalid pilot folder ID");
  }
  return value;
}

let mutationQueue = Promise.resolve();
function serializeMutation(action) {
  const task = mutationQueue.then(action);
  mutationQueue = task.catch(() => {});
  return task;
}

function publicFailure(error) {
  const message = String(error?.message || "");
  if (message.includes("private regular file")) {
    return "Syncthing connection must be a private regular file";
  }
  if (message.includes("has not been enrolled")) {
    return "Syncthing connection has not been enrolled";
  }
  if (message.includes("identity") || message.includes("directory mismatch")) {
    return "Syncthing identity verification failed";
  }
  if (message.includes("insufficient disk reserve")) {
    return "Not enough free disk space for a new pilot share (2 GiB reserve)";
  }
  return "Syncthing control unavailable";
}

async function readConnection() {
  let stat;
  try {
    stat = await fs.lstat(CONNECTION_FILE);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() ||
      stat.size > 8192 || (stat.mode & 0o077) !== 0) {
    throw new Error("Syncthing connection must be a private regular file");
  }
  return JSON.parse(await fs.readFile(CONNECTION_FILE, "utf8"));
}

async function request(method, params = {}) {
  const connection = await readConnection();
  if (!connection) {
    if (method === "status") {
      return { configured: false, connected: false, reason: "not-configured" };
    }
    throw new Error("Syncthing connection has not been enrolled");
  }

  const client = new SyncthingClient(connection);
  try {
    await client.attest();
    if (method === "status") {
      const state = await client.status();
      return { configured: true, connected: true, deviceId: state.myID,
        uptime: state.uptime ?? null };
    }
    if (method === "listPeers") {
      const config = await client.config();
      return {
        localDeviceId: client.deviceId,
        peers: (Array.isArray(config?.devices) ? config.devices : [])
          .filter((device) => device?.deviceID &&
            device.deviceID !== client.deviceId)
          .map((device) => ({
            deviceId: device.deviceID,
            name: typeof device.name === "string" ? device.name : "",
            paused: device.paused === true,
          })),
        folderIds: (Array.isArray(config?.folders) ? config.folders : [])
          .filter((folder) => typeof folder?.id === "string")
          .map((folder) => folder.id),
      };
    }
    if (method === "pairingCard") {
      // Only accessible from trusted in-process backend callers. This is a
      // portable contact card, NOT a bearer credential and NOT remote approval.
      const settings = await client.config();
      const candidates = tailscaleIPv4Candidates(os.networkInterfaces());
      const ports = configuredTcpPorts(settings);
      const endpoint = params.address ||
        (candidates.length === 1 && ports.length === 1
          ? `tcp://${candidates[0]}:${ports[0]}` : null);
      if (!endpoint) {
        return { available: false,
          reason: "Choose a Tailnet address and Syncthing TCP listen port" };
      }
      const card = encodePairingCard({
        deviceId: client.deviceId,
        name: params.name || os.hostname(),
        address: endpoint,
        folderId: params.folderId || "ignis-media-pilot",
      });
      return { available: true, card };
    }
    if (method === "importPairingCard") {
      // The trusted local backend is the only caller. The imported card
      // provides contact information, not permission to share any Vault.
      const peer = decodePairingCard(params.card);
      const localStatus = await client.status();
      if (peer.deviceId === localStatus.myID) {
        throw new Error("Cannot enroll this Syncthing instance as its own peer");
      }
      const checked = await client.request(
        "/rest/svc/deviceid?id=" + encodeURIComponent(peer.deviceId)
      );
      if (checked?.id !== peer.deviceId) {
        throw new Error("Syncthing rejected the peer device identifier");
      }
      const config = await client.config();
      if (!Array.isArray(config?.devices)) {
        throw new Error("Syncthing config has no device list");
      }
      if (config.devices.some((device) => device?.deviceID === peer.deviceId)) {
        return { deviceId: peer.deviceId, folderId: peer.folderId,
          alreadyPresent: true };
      }
      const defaults = await client.request("/rest/config/defaults/device");
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
        throw new Error("Syncthing device defaults are invalid");
      }
      await client.request("/rest/config/devices", { method: "POST", body: {
        ...defaults, deviceID: peer.deviceId, name: peer.name,
        addresses: [peer.address], autoAcceptFolders: false,
        introducer: false, paused: false,
      } });
      return { deviceId: peer.deviceId, folderId: peer.folderId,
        alreadyPresent: false };
    }
    if (method === "createPilotShare") {
      // Only this exact private descendant is eligible; callers cannot pass
      // an arbitrary Vault location or adopt an existing media collection.
      const folderId = validFolderId(params.folderId);
      const peerDeviceId = params.peerDeviceId;
      const config = await client.config();
      const local = await client.status();
      if (typeof peerDeviceId !== "string" ||
          peerDeviceId === local.myID ||
          !Array.isArray(config?.devices) ||
          !config.devices.some((item) => item?.deviceID === peerDeviceId)) {
        throw new Error("Pilot peer is not enrolled");
      }
      if (!Array.isArray(config?.folders)) {
        throw new Error("Syncthing folder list is invalid");
      }
      const privateRoot = await fs.realpath(DATA_DIR);
      const target = path.join(privateRoot, PILOT_SUBDIRECTORY, folderId);
      const configRoot = await fs.realpath(client.configDir);
      const dataRoot = await fs.realpath(client.dataDir);
      if (overlap(target, configRoot) || overlap(target, dataRoot)) {
        throw new Error("Pilot folder may not overlap Syncthing private state");
      }
      const existing = config.folders.find((folder) => folder?.id === folderId);
      if (existing) {
        // Retry or reconnect must not replace a preexisting configuration.
        // Only the exact same destination and peer counts as a no-op.
        const ids = (Array.isArray(existing.devices) ? existing.devices : [])
          .map((device) => device?.deviceID).filter(Boolean).sort();
        if (path.resolve(existing.path || "") !== target ||
            existing.type !== "sendreceive" ||
            ids.length !== 2 ||
            ids[0] !== [local.myID, peerDeviceId].sort()[0] ||
            ids[1] !== [local.myID, peerDeviceId].sort()[1]) {
          throw new Error("Pilot folder ID belongs to different configuration");
        }
        return { folderId, folderPath: target, alreadyPresent: true };
      }
      const capacity = await inspectStorageCapacity(privateRoot);
      if (capacity.constrained && params.allowLowSpace !== true) {
        throw new Error("insufficient disk reserve");
      }
      await prepareEmptyPilotFolder(target);
      // A race with another local process is checked again immediately
      // before registration; do not adopt files that appeared meanwhile.
      await assertEmptyPilotFolder(target);
      const defaults = await client.request("/rest/config/defaults/folder");
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
        throw new Error("Syncthing folder defaults are invalid");
      }
      await client.request("/rest/config/folders", { method: "POST", body: {
        ...defaults,
        id: folderId,
        label: "IGNIS Media Pilot",
        path: target,
        type: "sendreceive",
        devices: [{ deviceID: local.myID }, { deviceID: peerDeviceId }],
        paused: false,
      } });
      return { folderId, folderPath: target, alreadyPresent: false };
    }
    if (method === "pause") {
      await client.pause();
      return { configured: true, paused: true };
    }
    if (method === "resume") {
      await client.resume();
      return { configured: true, paused: false };
    }
  } catch (error) {
    if (method === "status") {
      return { configured: true, connected: false, reason: publicFailure(error) };
    }
    throw error;
  }
  throw new Error("Unsupported Syncthing control command");
}

process.on("message", (message) => {
  if (message?.protocol !== PROTOCOL) return;
  if (message.type === "ping") {
    process.send?.({ type: "pong", protocol: PROTOCOL, id: ID,
      requestId: message.requestId });
  } else if (message.type === "shutdown") {
    process.exit(0);
  } else if (message.type === "rpc") {
    const { requestId, method, params } = message;
    if (!["status", "listPeers", "pause", "resume", "pairingCard",
      "importPairingCard", "createPilotShare"].includes(method)) {
      process.send?.({ type: "rpc-result", protocol: PROTOCOL, id: ID,
        requestId, ok: false, error: "Unsupported Syncthing control command" });
      return;
    }
    const invoke = () => request(method, params);
    const command = ["importPairingCard", "createPilotShare"].includes(method)
      ? serializeMutation(invoke) : invoke();
    void command.then((result) => {
      process.send?.({ type: "rpc-result", protocol: PROTOCOL, id: ID,
        requestId, ok: true, result });
    }, (error) => {
      process.send?.({ type: "rpc-result", protocol: PROTOCOL, id: ID,
        requestId, ok: false, error: publicFailure(error) });
    });
  }
});

process.send?.({ type: "ready", protocol: PROTOCOL, id: ID });
