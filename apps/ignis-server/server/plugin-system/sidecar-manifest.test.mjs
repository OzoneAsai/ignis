import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { discoverPlugins } = require("./discovery.js");

let root;

function pluginFolder(name, manifest) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

function validManifest() {
  return {
    id: "media-sidecar", name: "Media sidecar", scope: "server",
    runtime: "sidecar", entry: "./worker.js",
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-sidecar-discovery-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete globalThis.__ignisSidecarDiscoveryExecuted;
  vi.restoreAllMocks();
});

describe("declarative backend sidecar discovery", () => {
  it("discovers sidecars without evaluating JavaScript in the Ignis process", () => {
    const dir = pluginFolder("media-sidecar", validManifest());
    fs.writeFileSync(path.join(dir, "worker.js"), "throw new Error('must not execute during discovery')");
    fs.writeFileSync(path.join(dir, "index.js"),
      "globalThis.__ignisSidecarDiscoveryExecuted = true;");

    const discovered = discoverPlugins(root);
    expect(globalThis.__ignisSidecarDiscoveryExecuted).toBeUndefined();
    expect(discovered.get("media-sidecar")).toMatchObject({
      id: "media-sidecar", scope: "server", runtime: "sidecar", module: null,
      entry: path.join(dir, "worker.js"),
    });
  });

  it("rejects a sidecar with invalid scope or runtime", () => {
    const manifest = { ...validManifest(), scope: "vault" };
    const dir = pluginFolder("invalid", manifest);
    fs.writeFileSync(path.join(dir, "worker.js"), "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(discoverPlugins(root).size).toBe(0);

    manifest.scope = "server";
    manifest.runtime = "in-process";
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    expect(discoverPlugins(root).size).toBe(0);
  });

  it("rejects traversal, missing and symlinked sidecar entries", () => {
    const manifest = validManifest();
    const dir = pluginFolder("invalid", manifest);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    manifest.entry = "../other.js";
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    expect(discoverPlugins(root).size).toBe(0);

    manifest.entry = "./worker.js";
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    expect(discoverPlugins(root).size).toBe(0);

    fs.writeFileSync(path.join(root, "external.js"), "");
    fs.symlinkSync(path.join(root, "external.js"), path.join(dir, "worker.js"));
    expect(discoverPlugins(root).size).toBe(0);
  });

  it("keeps legacy CommonJS plugins in-process and vault-scoped", () => {
    const dir = path.join(root, "legacy");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.js"),
      'module.exports = { id: "legacy", name: "Legacy", register() {} };');
    expect(discoverPlugins(root).get("legacy")).toMatchObject({
      id: "legacy", scope: "vault", runtime: "in-process",
    });
  });
});
