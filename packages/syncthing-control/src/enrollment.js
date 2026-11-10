const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { SyncthingClient, localOrigin } = require("./client");

const MAX_RESPONSE_BYTES = 1024 * 1024;

function contained(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function localRead(port, resource, key, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  timer.unref?.();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${resource}`, {
      headers: { "X-API-Key": key }, signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Local Syncthing API rejected credentials");
    let bytes = 0;
    const chunks = [];
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Syncthing API response is too large");
      chunks.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover an already-running Syncthing instance through an explicit private
 * home and loopback port. No process is started, adopted or configured here.
 */
async function probeRunningSyncthing({
  homeDir, port = 8386, fetchImpl = globalThis.fetch,
}) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir) ||
      !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Explicit absolute Syncthing home and local port are required");
  }
  const home = await fs.realpath(homeDir);
  const stat = await fs.lstat(path.join(home, "config.xml"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 ||
      (stat.mode & 0o077) !== 0) {
    throw new Error("Syncthing config.xml must be a private regular file");
  }
  const xml = await fs.readFile(path.join(home, "config.xml"), "utf8");
  const apiKey = xml.match(/<apikey>\s*([^<\s]+)\s*<\/apikey>/i)?.[1];
  if (!apiKey || apiKey.length < 16) {
    throw new Error("Missing private Syncthing local API key");
  }
  const [status, directories] = await Promise.all([
    localRead(port, "/rest/system/status", apiKey, fetchImpl),
    localRead(port, "/rest/system/paths", apiKey, fetchImpl),
  ]);
  const deviceId = status?.myID;
  const configDir = directories?.["baseDir-config"];
  const dataDir = directories?.["baseDir-data"];
  if (typeof deviceId !== "string" ||
      !/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(deviceId) ||
      typeof configDir !== "string" ||
      typeof dataDir !== "string" ||
      !path.isAbsolute(configDir) || !path.isAbsolute(dataDir) ||
      await fs.realpath(configDir) !== home) {
    throw new Error("The local API identity does not match the selected Syncthing home");
  }
  const stateDir = await fs.realpath(dataDir);
  const origin = localOrigin(`http://127.0.0.1:${port}`);
  const connection = { origin, apiKey, deviceId,
    configDir, dataDir };
  const client = new SyncthingClient({ ...connection, fetchImpl });
  await client.attest();
  return {
    connection,
    preview: { deviceId, configDir, dataDir: stateDir,
      origin, homeDir: home },
  };
}

/**
 * Atomic create-only enrollment. Never replace an existing connection file,
 * even if it appears to contain the same identity. That state belongs to an
 * earlier operator session or a concurrently running server.
 */
async function enrollPrivateSidecar({ sidecarDir, connection }) {
  if (typeof sidecarDir !== "string" || !path.isAbsolute(sidecarDir)) {
    throw new Error("Backend sidecar directory must be absolute");
  }
  await fs.mkdir(sidecarDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(sidecarDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0) {
    throw new Error("Backend sidecar directory must be private");
  }
  const canonical = await fs.realpath(sidecarDir);
  const configDir = await fs.realpath(connection.configDir);
  const dataDir = await fs.realpath(connection.dataDir);
  if (contained(configDir, canonical) ||
      contained(canonical, configDir) ||
      contained(dataDir, canonical) ||
      contained(canonical, dataDir)) {
    throw new Error("Backend plugin state and Syncthing private home must be separate");
  }
  const target = path.join(canonical, "syncthing-connection.json");
  const temporary = path.join(canonical, `.connection-${randomUUID()}.tmp`);
  let file;
  try {
    file = await fs.open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(connection), { encoding: "utf8" });
    await file.sync();
    await file.close();
    file = null;
    // Linking, unlike renaming, fails if target already exists. The final
    // file is never half-written and concurrent enrollments cannot overwrite.
    await fs.link(temporary, target);
    return { created: true, path: target };
  } finally {
    await file?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { probeRunningSyncthing, enrollPrivateSidecar };
