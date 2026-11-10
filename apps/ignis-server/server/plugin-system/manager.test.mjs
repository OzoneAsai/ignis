import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manager = require("./manager.js");

let root;
let pluginsDir;
let config;

function fixture(name, scope = "vault", options = {}) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const code = `
    const fs = require("node:fs");
    const path = require("node:path");
    let dataDir;
    function record(event) {
      fs.appendFileSync(path.join(dataDir, "events.txt"), event + "\\n");
    }
    module.exports = {
      id: ${JSON.stringify(name)},
      name: ${JSON.stringify(name)},
      ${scope === null ? "" : `scope: ${JSON.stringify(scope)},`}
      async register(ctx) {
        dataDir = ctx.dataDir;
        record("register");
        ${options.throwRegister ? "throw new Error('register failed');" : ""}
      },
      async onEnable() {
        record("enable");
        ${options.throwEnable ? "throw new Error('enable failed');" : ""}
      },
      async onDisable() { record("disable"); },
      async onVaultEnabled(vaultId) { record("vault:" + vaultId); },
      async onVaultDisabled(vaultId) { record("unvault:" + vaultId); },
      async shutdown() { record("shutdown"); }
    };
  `;
  fs.writeFileSync(path.join(dir, "index.js"), code, "utf8");
}

function sidecarFixture(name) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
    id: name, name, scope: "server", runtime: "sidecar", entry: "./worker.js",
  }));
  fs.writeFileSync(path.join(dir, "worker.js"), `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.writeFileSync(path.join(process.env.IGNIS_SIDECAR_DATA_DIR, "worker.txt"), "started");
    process.send({ type: "ready", id: process.env.IGNIS_SIDECAR_ID,
      protocol: "ignis-sidecar-v1" });
    process.on("message", (message) => {
      if (message.type === "ping" && message.protocol === "ignis-sidecar-v1") {
        process.send({ type: "pong", id: process.env.IGNIS_SIDECAR_ID,
          protocol: "ignis-sidecar-v1", requestId: message.requestId });
      }
      if (message.type === "shutdown" && message.protocol === "ignis-sidecar-v1") {
        fs.appendFileSync(path.join(process.env.IGNIS_SIDECAR_DATA_DIR, "worker.txt"), ":stopped");
        process.exit(0);
      }
    });
  `);
}

function events(name) {
  const file = path.join(root, "data", "plugins", name, "events.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}

async function init() {
  const app = { use: vi.fn() };
  await manager.initPlugins({
    app,
    pluginsDir,
    config: {
      dataRoot: path.join(root, "data"),
      getVaultPath: (id) => id === "alpha" ? path.join(root, "alpha") : null,
    },
    watcher: {},
    wss: { broadcastToVault: vi.fn() },
  });
  return app;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-plugin-scope-"));
  pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);
  fs.mkdirSync(path.join(root, "data"));
  config = {};
});

afterEach(async () => {
  await manager.shutdownPlugins();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function saveConfig() {
  fs.writeFileSync(path.join(root, "data", "plugin-config.json"), JSON.stringify(config));
}

describe("IGNIS plugin scopes", () => {
  it("keeps legacy plugins vault-scoped without a scope field", async () => {
    fixture("legacy", null);
    config.legacy = { enabledVaults: ["alpha"] };
    saveConfig();
    await init();

    expect(events("legacy")).toEqual(["register", "vault:alpha"]);
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "legacy")).toMatchObject({
      scope: "vault", loaded: true, enabledVaults: ["alpha"], serverEnabled: false,
    });
    await expect(manager.enablePluginForServer("legacy")).rejects.toThrow("Not a server plugin");
  });

  it("does not load a disabled server-wide plugin", async () => {
    fixture("global", "server");
    saveConfig();
    await init();
    expect(events("global")).toEqual([]);
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "global")).toMatchObject({
      scope: "server", loaded: false, serverEnabled: false,
    });
    await expect(manager.enablePluginForVault("global", "alpha"))
      .rejects.toThrow("Cannot enable server plugin for a vault");
  });

  it("activates an enabled server plugin only once and never per vault", async () => {
    fixture("global", "server");
    config.global = { enabled: true, enabledVaults: ["alpha"] };
    saveConfig();
    await init();
    expect(events("global")).toEqual(["register", "enable"]);
    await manager.enablePluginForServer("global");
    expect(events("global")).toEqual(["register", "enable"]);
    await expect(manager.disablePluginForVault("global", "alpha"))
      .rejects.toThrow("Cannot disable server plugin for a vault");
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "global"))
      .toMatchObject({ scope: "server", loaded: true, serverEnabled: true });
  });

  it("serializes simultaneous server activation requests", async () => {
    fixture("global", "server");
    saveConfig();
    await init();
    await Promise.all([
      manager.enablePluginForServer("global"),
      manager.enablePluginForServer("global"),
      manager.enablePluginForServer("global"),
    ]);
    expect(events("global")).toEqual(["register", "enable"]);
  });

  it("rejects unknown scopes rather than treating them as vault plugins", async () => {
    fixture("invalid", "process");
    saveConfig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await init();
    expect(manager.getDiscoveredPlugins().some((p) => p.id === "invalid")).toBe(false);
    expect(events("invalid")).toEqual([]);
  });

  it("persists explicit enable and disable without touching vault configuration", async () => {
    fixture("global", "server");
    config.global = { enabledVaults: ["alpha"] };
    saveConfig();
    await init();

    await manager.enablePluginForServer("global");
    expect(events("global")).toEqual(["register", "enable"]);
    await manager.disablePluginForServer("global");
    expect(events("global")).toEqual(["register", "enable", "disable", "shutdown"]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "data", "plugin-config.json"), "utf8")))
      .toEqual({ global: { enabled: false, enabledVaults: ["alpha"] } });
  });

  it("isolates broken server plugin activation from other plugins", async () => {
    fixture("broken", "server", { throwEnable: true });
    fixture("healthy", "server");
    config.broken = { enabled: true };
    config.healthy = { enabled: true };
    saveConfig();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await init();

    expect(events("broken")).toEqual(["register", "enable", "shutdown"]);
    expect(events("healthy")).toEqual(["register", "enable"]);
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "broken").loaded).toBe(false);
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "healthy").loaded).toBe(true);
  });

  it("cleans up a failed registration while preserving the rest of startup", async () => {
    fixture("broken", "server", { throwRegister: true });
    fixture("healthy", "server");
    config.broken = { enabled: true };
    config.healthy = { enabled: true };
    saveConfig();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await init();
    expect(events("broken")).toEqual(["register", "shutdown"]);
    expect(events("healthy")).toEqual(["register", "enable"]);
  });

  it("runs a declarative sidecar in a separate process without requiring it in Ignis", async () => {
    sidecarFixture("media-sidecar");
    config["media-sidecar"] = { enabled: true };
    saveConfig();
    await init();

    const sidecar = manager.getDiscoveredPlugins().find((p) => p.id === "media-sidecar");
    expect(sidecar).toMatchObject({
      scope: "server", runtime: "sidecar", serverEnabled: true, loaded: true,
      sidecarStatus: { state: "running", error: null },
    });
    expect(sidecar.sidecarStatus.pid).toBeGreaterThan(0);
    const log = path.join(root, "data", "plugins", "media-sidecar", "worker.txt");
    expect(fs.readFileSync(log, "utf8")).toBe("started");

    await manager.disablePluginForServer("media-sidecar");
    expect(fs.readFileSync(log, "utf8")).toBe("started:stopped");
    expect(manager.getDiscoveredPlugins().find((p) => p.id === "media-sidecar"))
      .toMatchObject({ serverEnabled: false, loaded: false });
  });
});
