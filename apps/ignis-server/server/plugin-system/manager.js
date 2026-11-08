const fs = require("fs");
const path = require("path");
const express = require("express");
const { discoverPlugins } = require("./discovery");
const configStore = require("./config-store");
const { getVersion } = require("../version");
const { SidecarSupervisor } = require("./sidecar-supervisor");

let discoveredPlugins = new Map();
const loadedPlugins = new Map();
const pluginRouters = new Map();
const activatingServerPlugins = new Map();
let pluginConfig = {};
let configPath = "";
let serverCtx = null;

async function initPlugins(ctx) {
  serverCtx = ctx;
  configPath = path.join(ctx.config.dataRoot, "plugin-config.json");

  ctx.app.use("/api/ext/:pluginId", (req, res, next) => {
    const router = pluginRouters.get(req.params.pluginId);

    if (router) {
      router(req, res, next);
    } else {
      next();
    }
  });

  const pluginsDir = ctx.pluginsDir || path.join(__dirname, "..", "plugins");
  discoveredPlugins = discoverPlugins(pluginsDir);
  pluginConfig = await configStore.load(configPath);

  for (const [pluginId, discovered] of discoveredPlugins) {
    if (discovered.scope === "server") {
      if (!configStore.isServerEnabled(pluginConfig, pluginId)) continue;
      try {
        await activateServerPlugin(pluginId);
      } catch (e) {
        console.error(`[plugins] Failed to activate ${pluginId}: ${e.message}`);
      }
      continue;
    }
    const enabledVaults = configStore.getEnabledVaults(pluginConfig, pluginId);

    if (enabledVaults.length === 0) {
      continue;
    }

    try {
      await loadPlugin(pluginId);

      for (const vaultId of enabledVaults) {
        const vaultPath = ctx.config.getVaultPath(vaultId);

        if (!vaultPath) {
          continue;
        }

        const loaded = loadedPlugins.get(pluginId);

        if (loaded?.module?.onVaultEnabled) {
          await loaded.module.onVaultEnabled(vaultId, vaultPath);
        }
      }
    } catch (e) {
      console.error(`[plugins] Failed to load ${pluginId}: ${e.message}`);
      console.error(e.stack);
    }
  }
}

async function shutdownPlugins() {
  console.log("[plugins] Shutting down all plugins...");

  for (const loaded of loadedPlugins.values()) {
    if (loaded.shutdown) {
      try {
        console.log(`[plugins] Shutting down: ${loaded.name}`);
        await loaded.shutdown();
      } catch (e) {
        console.error(
          `[plugins] Error shutting down ${loaded.name}: ${e.message}`,
        );
      }
    }
  }

  loadedPlugins.clear();
  pluginRouters.clear();
  console.log("[plugins] All plugins shut down");
}

function getPluginDataDir(dataRoot, pluginId) {
  return path.join(dataRoot, "plugins", pluginId);
}

async function loadPlugin(pluginId) {
  if (loadedPlugins.has(pluginId)) {
    return;
  }

  const discovered = discoveredPlugins.get(pluginId);

  if (!discovered) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }
  const dataDir = getPluginDataDir(serverCtx.config.dataRoot, pluginId);

  await fs.promises.mkdir(dataDir, { recursive: true });

  if (discovered.runtime === "sidecar") {
    const sidecar = new SidecarSupervisor({
      id: pluginId, entry: discovered.entry, dataDir,
    });
    await sidecar.start();
    loadedPlugins.set(pluginId, {
      id: pluginId, name: discovered.name, module: null,
      ctx: { dataDir }, sidecar, shutdown: () => sidecar.stop(),
    });
    console.log(`[plugins] Sidecar running: ${discovered.name}`);
    return;
  }

  const plugin = discovered.module;

  const router = express.Router();

  const pluginCtx = {
    config: serverCtx.config,
    wss: serverCtx.wss,
    watcher: serverCtx.watcher,
    router,
    log: (msg) => console.log(`[plugin:${pluginId}] ${msg}`),
    dataDir,
    getEnabledVaults: () =>
      configStore.getEnabledVaults(pluginConfig, pluginId),
  };

  try {
    await plugin.register(pluginCtx);
  } catch (e) {
    // An incomplete registration must not leave timers or subprocesses behind.
    if (typeof plugin.shutdown === "function") {
      try { await plugin.shutdown(); }
      catch (cleanupError) {
        console.error(`[plugins] Cleanup failed for ${pluginId}: ${cleanupError.message}`);
      }
    }
    throw e;
  }

  pluginRouters.set(pluginId, router);

  loadedPlugins.set(pluginId, {
    id: pluginId,
    name: discovered.name,
    module: plugin,
    ctx: pluginCtx,
    shutdown: plugin.shutdown ? plugin.shutdown.bind(plugin) : null,
  });

  console.log(`[plugins] Loaded: ${discovered.name}`);
}

async function unloadPlugin(pluginId) {
  const loaded = loadedPlugins.get(pluginId);

  if (!loaded) {
    return;
  }

  try {
    if (loaded.shutdown) {
      console.log(`[plugins] Shutting down: ${loaded.name}`);
      await loaded.shutdown();
    }
  } finally {
    pluginRouters.delete(pluginId);
    loadedPlugins.delete(pluginId);
  }
  console.log(`[plugins] Unloaded: ${loaded.name}`);
}

async function activateServerPlugin(pluginId) {
  const discovered = discoveredPlugins.get(pluginId);
  if (!discovered || discovered.scope !== "server") {
    throw new Error(`Not a server plugin: ${pluginId}`);
  }
  if (activatingServerPlugins.has(pluginId)) {
    return activatingServerPlugins.get(pluginId);
  }
  const existing = loadedPlugins.get(pluginId);
  if (existing) {
    if (existing.sidecar && existing.sidecar.status().state !== "running") {
      await existing.sidecar.start();
    }
    return;
  }
  const activation = startServerPlugin(pluginId, discovered);
  activatingServerPlugins.set(pluginId, activation);
  try {
    await activation;
  } finally {
    activatingServerPlugins.delete(pluginId);
  }
}

async function startServerPlugin(pluginId, discovered) {
  await loadPlugin(pluginId);
  try {
    await discovered.module?.onEnable?.(loadedPlugins.get(pluginId).ctx);
  } catch (e) {
    try { await unloadPlugin(pluginId); }
    catch (cleanupError) {
      console.error(`[plugins] Cleanup failed for ${pluginId}: ${cleanupError.message}`);
      pluginRouters.delete(pluginId);
      loadedPlugins.delete(pluginId);
    }
    throw e;
  }
}

// Trusted server-side control only. The current public plugin routes do not
// authenticate server administrators and must not expose these operations.
async function enablePluginForServer(pluginId) {
  const discovered = discoveredPlugins.get(pluginId);
  if (!discovered || discovered.scope !== "server") {
    throw new Error(`Not a server plugin: ${pluginId}`);
  }
  await activateServerPlugin(pluginId);
  configStore.setServerEnabled(pluginConfig, pluginId, true);
  await configStore.save(configPath, pluginConfig);
}

async function disablePluginForServer(pluginId) {
  const discovered = discoveredPlugins.get(pluginId);
  if (!discovered || discovered.scope !== "server") {
    throw new Error(`Not a server plugin: ${pluginId}`);
  }
  if (activatingServerPlugins.has(pluginId)) {
    await activatingServerPlugins.get(pluginId);
  }
  const loaded = loadedPlugins.get(pluginId);
  if (loaded) {
    await loaded.module?.onDisable?.(loaded.ctx);
    await unloadPlugin(pluginId);
  }
  configStore.setServerEnabled(pluginConfig, pluginId, false);
  await configStore.save(configPath, pluginConfig);
}

// Only internal trusted backend callers may issue management RPC. Never expose
// this directly through the existing unauthenticated /api/plugins routes.
async function invokeServerSidecar(pluginId, method, params = {}) {
  const discovered = discoveredPlugins.get(pluginId);
  const loaded = loadedPlugins.get(pluginId);
  if (discovered?.scope !== "server" || discovered?.runtime !== "sidecar" ||
      !loaded?.sidecar) {
    throw new Error(`Sidecar unavailable: ${pluginId}`);
  }
  return loaded.sidecar.request(method, params);
}

async function enablePluginForVault(pluginId, vaultId) {
  const discovered = discoveredPlugins.get(pluginId);

  if (!discovered) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }
  if (discovered.scope !== "vault") {
    throw new Error(`Cannot enable server plugin for a vault: ${pluginId}`);
  }

  const vaultPath = serverCtx.config.getVaultPath(vaultId);

  if (!vaultPath) {
    throw new Error(`Vault not found: ${vaultId}`);
  }

  const enabledVaults = configStore.getEnabledVaults(pluginConfig, pluginId);

  if (!enabledVaults.includes(vaultId)) {
    enabledVaults.push(vaultId);
    configStore.setEnabledVaults(pluginConfig, pluginId, enabledVaults);
    await configStore.save(configPath, pluginConfig);
  }

  if (!loadedPlugins.has(pluginId)) {
    await loadPlugin(pluginId);
  }

  const loaded = loadedPlugins.get(pluginId);

  if (loaded?.module?.onVaultEnabled) {
    await loaded.module.onVaultEnabled(vaultId, vaultPath);
  }

  // Broadcast to any open tabs on this vault so they load the plugin properly.
  if (discovered.obsidianPlugin && discovered.bundledPluginId) {
    const v = `?v=${getVersion()}`;
    const entry = {
      id: discovered.bundledPluginId,
      scriptUrl: `/${discovered.bundledPluginId}.js${v}`,
      cssUrl: `/${discovered.bundledPluginId}.css${v}`,
      manifest: discovered.bundledManifest,
    };

    serverCtx.wss?.broadcastToVault?.(vaultId, {
      type: "virtual-plugin-enable",
      vault: vaultId,
      entry,
    });
  }
}

async function disablePluginForVault(pluginId, vaultId) {
  const discovered = discoveredPlugins.get(pluginId);

  if (!discovered) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }
  if (discovered.scope !== "vault") {
    throw new Error(`Cannot disable server plugin for a vault: ${pluginId}`);
  }

  const vaultPath = serverCtx.config.getVaultPath(vaultId);

  if (!vaultPath) {
    throw new Error(`Vault not found: ${vaultId}`);
  }

  const loaded = loadedPlugins.get(pluginId);

  if (loaded?.module?.onVaultDisabled) {
    await loaded.module.onVaultDisabled(vaultId, vaultPath);
  }

  const enabledVaults = configStore.getEnabledVaults(pluginConfig, pluginId);
  const updated = enabledVaults.filter((id) => id !== vaultId);
  configStore.setEnabledVaults(pluginConfig, pluginId, updated);
  await configStore.save(configPath, pluginConfig);

  if (updated.length === 0) {
    await unloadPlugin(pluginId);
  }

  if (discovered.bundledPluginId) {
    serverCtx.wss?.broadcastToVault?.(vaultId, {
      type: "virtual-plugin-disable",
      vault: vaultId,
      id: discovered.bundledPluginId,
    });
  }
}

function getBundledPluginDirs() {
  const dirs = [];

  for (const [, discovered] of discoveredPlugins) {
    if (discovered.obsidianPlugin && discovered.bundledPluginId) {
      dirs.push({
        bundledPluginId: discovered.bundledPluginId,
        distDir: path.join(discovered.obsidianPlugin, "dist"),
      });
    }
  }

  return dirs;
}

function getVirtualPluginsForVault(vaultId, version) {
  const v = version ? `?v=${version}` : "";
  const result = [];

  for (const [pluginId, discovered] of discoveredPlugins) {
    if (!discovered.obsidianPlugin || !discovered.bundledPluginId) {
      continue;
    }

    const enabled = discovered.scope === "server"
      ? configStore.isServerEnabled(pluginConfig, pluginId) && loadedPlugins.has(pluginId)
      : configStore.getEnabledVaults(pluginConfig, pluginId).includes(vaultId);

    if (!enabled) {
      continue;
    }

    result.push({
      id: discovered.bundledPluginId,
      scriptUrl: `/${discovered.bundledPluginId}.js${v}`,
      cssUrl: `/${discovered.bundledPluginId}.css${v}`,
      manifest: discovered.bundledManifest,
    });
  }

  return result;
}

function getDiscoveredPlugins() {
  const result = [];

  for (const [pluginId, discovered] of discoveredPlugins) {
    result.push({
      id: discovered.id,
      name: discovered.name,
      scope: discovered.scope,
      runtime: discovered.runtime,
      description: discovered.description,
      hasBundledPlugin: !!discovered.obsidianPlugin,
      bundledPluginId: discovered.bundledPluginId,
      enabledVaults: configStore.getEnabledVaults(pluginConfig, pluginId),
      serverEnabled: discovered.scope === "server" && configStore.isServerEnabled(pluginConfig, pluginId),
      loaded: loadedPlugins.has(pluginId) &&
        (loadedPlugins.get(pluginId).sidecar === undefined ||
          loadedPlugins.get(pluginId).sidecar.status().state === "running"),
      sidecarStatus: loadedPlugins.get(pluginId)?.sidecar?.status() ?? null,
    });
  }

  return result;
}

module.exports = {
  initPlugins,
  shutdownPlugins,
  getPluginDataDir,
  enablePluginForVault,
  disablePluginForVault,
  enablePluginForServer,
  disablePluginForServer,
  invokeServerSidecar,
  getDiscoveredPlugins,
  getBundledPluginDirs,
  getVirtualPluginsForVault,
};
