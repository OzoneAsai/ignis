const path = require("node:path");

function localOrigin(address) {
  const url = new URL(address);
  if (url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Syncthing management API must use a plain localhost HTTP origin");
  }
  return url.origin;
}

function absoluteDir(directory, name) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error(`${name} must be an absolute directory`);
  }
  return path.resolve(directory);
}

// A local GUI port is an address, not identity. Before issuing commands,
// verify *both* Syncthing's persisted device ID and its private state paths.
class SyncthingClient {
  constructor({ origin, apiKey, deviceId, configDir, dataDir,
    fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
    this.origin = localOrigin(origin);
    if (typeof apiKey !== "string" || apiKey.length < 16) {
      throw new Error("A configured Syncthing API key is required");
    }
    if (typeof deviceId !== "string" || !/^[A-Z0-9-]{32,128}$/.test(deviceId)) {
      throw new Error("A previously enrolled Syncthing device ID is required");
    }
    this.apiKey = apiKey;
    this.deviceId = deviceId;
    this.configDir = absoluteDir(configDir, "configDir");
    this.dataDir = absoluteDir(dataDir, "dataDir");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.verified = false;
  }

  async request(endpoint, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.origin + endpoint, {
        method,
        redirect: "error",
        headers: {
          "X-API-Key": this.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Syncthing API rejected request (HTTP ${response.status})`);
      }
      if (response.status === 204 || response.status === 205) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async attest() {
    // Never keep a stale authorization after a failed identity check.
    this.verified = false;
    const [status, paths] = await Promise.all([
      this.request("/rest/system/status"),
      this.request("/rest/system/paths"),
    ]);
    if (status?.myID !== this.deviceId ||
        typeof paths?.["baseDir-config"] !== "string" ||
        typeof paths?.["baseDir-data"] !== "string" ||
        path.resolve(paths["baseDir-config"]) !== this.configDir ||
        path.resolve(paths["baseDir-data"]) !== this.dataDir) {
      throw new Error("Syncthing device identity or private state directory mismatch");
    }
    this.verified = true;
    return {
      deviceId: status.myID,
      state: status?.uptime !== undefined ? "running" : "reachable",
      configDir: this.configDir,
      dataDir: this.dataDir,
    };
  }

  assertVerified() {
    if (!this.verified) {
      throw new Error("Syncthing instance is not attested");
    }
  }

  async status() {
    this.assertVerified();
    const result = await this.request("/rest/system/status");
    if (result?.myID !== this.deviceId) {
      this.verified = false;
      throw new Error("Syncthing instance changed during session");
    }
    return result;
  }

  async config() {
    this.assertVerified();
    return this.request("/rest/config");
  }

  async pause() {
    this.assertVerified();
    return this.request("/rest/system/pause", { method: "POST" });
  }

  async resume() {
    this.assertVerified();
    return this.request("/rest/system/resume", { method: "POST" });
  }
}

module.exports = { SyncthingClient, localOrigin };
