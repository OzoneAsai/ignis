const fs = require("fs");
const path = require("path");
const { readSidecarManifest } = require("./sidecar-manifest");

function discoverPlugins(pluginsDir) {
  const discovered = new Map();

  let entries;

  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return discovered;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const pluginPath = path.join(pluginsDir, entry.name);
    try {
      const sidecar = readSidecarManifest(pluginPath);
      if (sidecar) {
        discovered.set(sidecar.id, {
          ...sidecar,
          module: null,
          obsidianPlugin: null,
          bundledPluginId: null,
          bundledManifest: null,
        });
        console.log(`[plugins] Discovered sidecar: ${sidecar.name}`);
        continue;
      }
    } catch (error) {
      console.warn(`[plugins] Skipping ${entry.name}: ${error.message}`);
      continue;
    }
    const indexPath = path.join(pluginPath, "index.js");

    if (!fs.existsSync(indexPath)) {
      continue;
    }

    let plugin;

    try {
      plugin = require(indexPath);
    } catch (e) {
      console.warn(`[plugins] Failed to load ${entry.name}: ${e.message}`);
      continue;
    }

    if (!plugin.id || !plugin.name || typeof plugin.register !== "function") {
      console.warn(
        `[plugins] Skipping ${entry.name}: missing id, name, or register`,
      );
      continue;
    }
    const scope = plugin.scope ?? "vault";
    if (scope !== "vault" && scope !== "server") {
      console.warn(`[plugins] Skipping ${entry.name}: invalid scope ${scope}`);
      continue;
    }

    let bundledManifest = null;

    if (plugin.obsidianPlugin) {
      try {
        bundledManifest = JSON.parse(
          fs.readFileSync(
            path.join(plugin.obsidianPlugin, "manifest.json"),
            "utf-8",
          ),
        );
      } catch {
        // No valid bundled plugin manifest
      }
    }

    discovered.set(plugin.id, {
      id: plugin.id,
      name: plugin.name,
      scope,
      runtime: "in-process",
      description: plugin.description || "",
      obsidianPlugin: plugin.obsidianPlugin || null,
      bundledPluginId: bundledManifest ? bundledManifest.id : null,
      bundledManifest,
      module: plugin,
    });

    console.log(`[plugins] Discovered: ${plugin.name}`);
  }

  return discovered;
}

module.exports = { discoverPlugins };
