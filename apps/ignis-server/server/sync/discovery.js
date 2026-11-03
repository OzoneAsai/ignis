// Syncthing Global Discovery v3 client. This is an endpoint registry, not BEP.
// License reference for protocol research: Syncthing MPL-2.0.
const fs = require("node:fs");
const crypto = require("node:crypto");
const https = require("node:https");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes) {
  let bits = 0;
  let carry = 0;
  let result = "";
  for (const byte of bytes) {
    carry = (carry << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(carry >>> (bits - 5)) & 31];
      bits -= 5;
    }
    carry &= (1 << bits) - 1;
  }
  if (bits) result += ALPHABET[(carry << (5 - bits)) & 31];
  return result;
}

function luhn32(chunk) {
  let factor = 1;
  let sum = 0;
  for (const char of chunk) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error("Invalid Device ID alphabet");
    const addend = factor * value;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / 32) + (addend % 32);
  }
  return ALPHABET[(32 - (sum % 32)) % 32];
}

function deviceIdFromCert(pem) {
  const cert = new crypto.X509Certificate(pem);
  const digest = crypto.createHash("sha256").update(cert.raw).digest();
  const raw = base32(digest);
  if (raw.length !== 52) throw new Error("Incorrect SHA256 Base32 encoding");
  let checksummed = "";
  for (let i = 0; i < 4; i++) {
    const chunk = raw.slice(i * 13, (i + 1) * 13);
    checksummed += chunk + luhn32(chunk);
  }
  return checksummed.match(/.{7}/g).join("-");
}

function parseDiscoverySettings({ discoveryUrl, publicUrl }) {
  const discovery = new URL(discoveryUrl);
  const publicEndpoint = new URL(publicUrl);
  if (discovery.protocol !== "https:" || discovery.username ||
      discovery.password || discovery.search || discovery.hash ||
      publicEndpoint.protocol !== "https:" || publicEndpoint.username ||
      publicEndpoint.password || publicEndpoint.search || publicEndpoint.hash ||
      publicEndpoint.pathname !== "/") {
    throw new Error("Discovery requires HTTPS URLs without credentials or query strings");
  }
  // stdiscosrv currently accepts generic URI schemes, but HTTPS is not a
  // standardized Syncthing transport. Explicit port is required by stdiscosrv.
  const port = publicEndpoint.port || "443";
  return { discovery: discovery.toString(),
    address: "https://" + publicEndpoint.hostname + ":" + port };
}

function announceOnce({ discoveryUrl, publicUrl, cert, key }) {
  const { discovery, address } = parseDiscoverySettings({ discoveryUrl, publicUrl });
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ addresses: [address] });
    const url = new URL(discovery);
    const req = https.request(url, {
      method: "POST", cert, key, timeout: 10000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      res.resume();
      if (res.statusCode !== 204) {
        reject(new Error("Discovery announce rejected with HTTP " + res.statusCode));
        return;
      }
      const seconds = Number(res.headers["reannounce-after"]);
      resolve(Number.isFinite(seconds) && seconds > 0 ?
        Math.max(60, Math.min(seconds, 86400)) : 1800);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Discovery timeout")));
    req.end(body);
  });
}

function startDiscoveryFromEnv(env = process.env) {
  if (!env.IGNIS_DISCOVERY_URL) return { stop() {}, deviceId: null };
  const required = ["IGNIS_DISCOVERY_CERT", "IGNIS_DISCOVERY_KEY", "IGNIS_SYNC_PUBLIC_URL"];
  for (const name of required) {
    if (!env[name]) throw new Error(name + " is required for Discovery");
  }
  const cert = fs.readFileSync(env.IGNIS_DISCOVERY_CERT, "utf8");
  const key = fs.readFileSync(env.IGNIS_DISCOVERY_KEY, "utf8");
  const deviceId = deviceIdFromCert(cert);
  let stopped = false;
  let timer;
  async function announce() {
    let delay = 300;
    try {
      delay = await announceOnce({
        discoveryUrl: env.IGNIS_DISCOVERY_URL,
        publicUrl: env.IGNIS_SYNC_PUBLIC_URL, cert, key
      });
      console.log("[sync] Discovery announced as " + deviceId);
    } catch (e) {
      console.warn("[sync] Discovery announce:", e.message);
    }
    if (!stopped) {
      timer = setTimeout(announce, delay * 1000);
      timer.unref?.();
    }
  }
  void announce();
  return { deviceId, stop() { stopped = true; clearTimeout(timer); } };
}

module.exports = {
  base32, luhn32, deviceIdFromCert, parseDiscoverySettings,
  announceOnce, startDiscoveryFromEnv
};
