const RESERVED = new Set([".obsidian", ".git", ".trash", ".ignis-connector"]);

function canonicalPath(relative) {
  if (typeof relative !== "string" || !relative || relative.length > 2048 ||
      relative.includes("\\") || relative.includes("\0") ||
      relative.startsWith("/") || /[\r\n]/u.test(relative)) {
    throw new Error("Invalid relative Vault path");
  }
  const parts = relative.normalize("NFC").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid Vault path segment");
  }
  return parts.join("/");
}

function excluded(relative) {
  return relative.split("/").some((part) => {
    const lower = part.toLocaleLowerCase("en-US");
    return RESERVED.has(lower) ||
      lower.startsWith(".ignis-sync-tmp-") ||
      lower.startsWith(".ignis-collab-tmp-");
  });
}

function comparisonKey(relative) {
  return canonicalPath(relative).toLocaleLowerCase("en-US");
}

function isInside(root, relative) {
  return relative === root || relative.startsWith(root + "/");
}

// The route's owner is persisted configuration, never derived from daemon
// health. Not installing Syncthing leaves the existing IGNIS policy unchanged.
function createSyncPolicy({ enabled = false, roots = [] } = {}) {
  if (typeof enabled !== "boolean" || !Array.isArray(roots)) {
    throw new Error("Invalid synchronization policy");
  }
  const canonRoots = roots.map((raw) => {
    const normalized = canonicalPath(raw);
    if (excluded(normalized) || normalized.toLowerCase().endsWith(".md")) {
      throw new Error("Syncthing root must be an ordinary folder");
    }
    return comparisonKey(normalized);
  });
  for (let i = 0; i < canonRoots.length; i += 1) {
    for (let j = i + 1; j < canonRoots.length; j += 1) {
      if (isInside(canonRoots[i], canonRoots[j]) ||
          isInside(canonRoots[j], canonRoots[i])) {
        throw new Error("Overlapping Syncthing roots");
      }
    }
  }
  const rootSet = Object.freeze(canonRoots);

  function ownerFor(relative) {
    let normalized;
    try {
      normalized = canonicalPath(relative);
    } catch {
      return "internal";
    }
    if (excluded(normalized)) return "internal";
    if (!enabled) return "ignis";

    const lower = comparisonKey(normalized);
    const managed = rootSet.some((root) => isInside(root, lower));
    if (!managed) return "ignis";
    // A managed subtree is never a place for Yjs projections. Activation of
    // an existing mixed subtree is rejected by the migration/scan stage.
    return lower.endsWith(".md") ? "conflict" : "syncthing";
  }

  return Object.freeze({ enabled, roots: rootSet, ownerFor });
}

module.exports = { createSyncPolicy, canonicalPath };
