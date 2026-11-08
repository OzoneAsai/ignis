const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Sidecar discovery is data-only. Loading metadata must never evaluate plugin
// JavaScript in the Ignis process (unlike legacy in-process extensions).
function readSidecarManifest(pluginDir) {
  const manifestFile = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(manifestFile)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      !ID_PATTERN.test(manifest.id || "") ||
      typeof manifest.name !== "string" || !manifest.name.trim() ||
      manifest.scope !== "server" || manifest.runtime !== "sidecar" ||
      typeof manifest.entry !== "string" ||
      !/^\.[/](?:[a-zA-Z0-9_.-]|[/])+$/.test(manifest.entry) ||
      manifest.entry.split("/").some((part) => part === ".." || part === "") ||
      path.extname(manifest.entry) !== ".js") {
    throw new Error("Invalid sidecar manifest: expected id, name, scope=server, runtime=sidecar and a safe relative .js entry");
  }

  const entry = path.resolve(pluginDir, manifest.entry);
  const relative = path.relative(pluginDir, entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Sidecar entry must be inside its plugin directory");
  }
  const base = fs.realpathSync(pluginDir);
  const canonical = fs.realpathSync(entry);
  const canonicalRelative = path.relative(base, canonical);
  if (!canonicalRelative || canonicalRelative.startsWith("..") ||
      path.isAbsolute(canonicalRelative)) {
    throw new Error("Sidecar entry resolves outside its plugin directory");
  }
  let cursor = pluginDir;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Sidecar entry must not traverse a symlink");
    }
  }
  if (!fs.statSync(entry).isFile()) {
    throw new Error("Sidecar entry must be a regular file");
  }

  return {
    id: manifest.id,
    name: manifest.name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    scope: "server",
    runtime: "sidecar",
    entry,
  };
}

module.exports = { readSidecarManifest };
