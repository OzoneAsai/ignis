const { createHash } = require("node:crypto");

const PREFIX = "IGNIS-PAIR1";
const MAX_CARD_LENGTH = 2048;
const VALIDITY_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function validateText(value, label, maxLength = 80) {
  if (typeof value !== "string" || !value.trim() ||
      value.length > maxLength ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`${label} is not a valid single-line value`);
  }
  return value.trim();
}

function normalizedIdentity(value) {
  if (typeof value !== "string") throw new Error("Device ID is missing");
  const id = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(id)) {
    throw new Error("Device ID must have eight groups of seven characters");
  }
  return id;
}

function validateAddress(value) {
  const address = validateText(value, "Tailnet address", 253);
  let parsed;
  try { parsed = new URL(address); }
  catch { throw new Error("Tailnet address must be an explicit TCP endpoint"); }
  if (parsed.protocol !== "tcp:" || !parsed.hostname ||
      !parsed.port || !/^\d+$/.test(parsed.port) ||
      Number(parsed.port) < 1 || Number(parsed.port) > 65535 ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Tailnet address must be an explicit TCP endpoint");
  }
  return `tcp://${parsed.host}`;
}

function validateFolderId(value) {
  if (typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(value)) {
    throw new Error("Invalid pilot folder ID");
  }
  return value;
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function encodePairingCard({
  deviceId, name, address, folderId = "ignis-media-pilot",
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid timestamp");
  const card = {
    version: 1,
    deviceId: normalizedIdentity(deviceId),
    name: validateText(name, "Device name"),
    address: validateAddress(address),
    folderId: validateFolderId(folderId),
    createdAt: now,
    expiresAt: now + VALIDITY_MS,
  };
  const json = JSON.stringify(card);
  return `${PREFIX}.${Buffer.from(json).toString("base64url")}.${digest(json)}`;
}

function decodePairingCard(value, { now = Date.now() } = {}) {
  if (typeof value !== "string" || value.length > MAX_CARD_LENGTH) {
    throw new Error("Pairing card is too long or missing");
  }
  const parts = value.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX ||
      !/^[A-Za-z0-9_-]{16,1900}$/.test(parts[1]) ||
      !/^[0-9a-f]{16}$/.test(parts[2])) {
    throw new Error("Pairing card format is invalid");
  }
  const bytes = Buffer.from(parts[1], "base64url");
  if (bytes.toString("base64url") !== parts[1]) {
    throw new Error("Pairing card encoding is invalid");
  }
  const json = bytes.toString("utf8");
  if (digest(json) !== parts[2]) {
    throw new Error("Pairing card checksum mismatch");
  }
  let raw;
  try { raw = JSON.parse(json); }
  catch { throw new Error("Pairing card contents are invalid"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !==
        "address,createdAt,deviceId,expiresAt,folderId,name,version") {
    throw new Error("Pairing card has unexpected fields");
  }
  const card = {
    version: raw.version,
    deviceId: normalizedIdentity(raw.deviceId),
    name: validateText(raw.name, "Device name"),
    address: validateAddress(raw.address),
    folderId: validateFolderId(raw.folderId),
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };
  if (card.version !== 1 ||
      !Number.isSafeInteger(card.createdAt) ||
      !Number.isSafeInteger(card.expiresAt) ||
      card.expiresAt - card.createdAt !== VALIDITY_MS ||
      card.createdAt > now + MAX_CLOCK_SKEW_MS ||
      card.expiresAt < now) {
    throw new Error("Pairing card has expired or has an invalid timestamp");
  }
  return card;
}

function tailscaleIPv4Candidates(interfaces) {
  const found = new Set();
  if (!interfaces || typeof interfaces !== "object") return [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal ||
          !(entry.family === "IPv4" || entry.family === 4) ||
          typeof entry.address !== "string") continue;
      const bytes = entry.address.split(".").map(Number);
      if (bytes.length !== 4 || bytes.some((part) => !Number.isInteger(part) ||
          part < 0 || part > 255)) continue;
      if (bytes[0] !== 100 || bytes[1] < 64 || bytes[1] > 127) continue;
      found.add(`${entry.address}`);
    }
  }
  return [...found].sort();
}

function configuredTcpPorts(config) {
  const addresses = config?.options?.listenAddresses;
  if (!Array.isArray(addresses)) return [];
  const ports = new Set();
  for (const address of addresses) {
    if (typeof address !== "string") continue;
    const match = /^tcp:\/\/(?:0\.0\.0\.0|\[::\]|[\w.:-]+):(\d{1,5})$/.exec(address);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

module.exports = {
  encodePairingCard, decodePairingCard,
  tailscaleIPv4Candidates, configuredTcpPorts,
};
