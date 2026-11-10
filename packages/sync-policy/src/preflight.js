const fs = require("node:fs/promises");
const path = require("node:path");
const { createSyncPolicy, canonicalPath } = require("./index");

const MAX_ROOTS = 8;
const MAX_SAMPLES = 16;

// A read-only migration inventory. It is intentionally stricter than a
// generic file scanner because failing open would turn an old journal entry
// into a remote tombstone when a subtree is handed to Syncthing.
async function preflightMediaOwnership({
  vaultRoot,
  roots,
  journalPaths = [],
  activeDeviceCount = 0,
} = {}) {
  if (typeof vaultRoot !== "string" || !path.isAbsolute(vaultRoot) ||
      !Array.isArray(roots) || roots.length < 1 || roots.length > MAX_ROOTS ||
      !Number.isSafeInteger(activeDeviceCount) || activeDeviceCount < 0) {
    throw new Error("Invalid media migration preflight request");
  }
  const policy = createSyncPolicy({ enabled: true, roots });
  const issues = [];
  const emit = (code, description, relative = null) => {
    const existing = issues.find((issue) => issue.code === code);
    if (existing) {
      existing.count += 1;
      if (relative && existing.examples.length < MAX_SAMPLES) existing.examples.push(relative);
    } else {
      issues.push({ code, description, count: 1, examples: relative ? [relative] : [] });
    }
  };

  const vault = path.resolve(vaultRoot);
  const rootStat = await fs.lstat(vault).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    emit("VAULT_UNAVAILABLE", "Vault root must be a directly accessible directory");
  } else {
    for (const raw of roots) {
      const root = canonicalPath(raw);
      const segments = root.split("/");
      let parent = vault;
      let blocked = false;
      for (const part of segments) {
        parent = path.join(parent, part);
        const stat = await fs.lstat(parent).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
          emit("ROOT_NOT_READY",
            "Each media root and its parent directories must exist without links", root);
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const entries = await fs.readdir(parent, { withFileTypes: true });
      for (const entry of entries) {
        // Syncthing's own folder marker is not user data. All other entries
        // demand an explicit migration before a second authority is enabled.
        if (entry.name === ".stfolder" && entry.isDirectory()) continue;
        const relative = root + "/" + entry.name;
        emit(
          entry.name.toLowerCase().endsWith(".md") ? "MARKDOWN_IN_MEDIA" : "ROOT_NOT_EMPTY",
          "Existing data must be migrated with explicit verification, not silently reassigned",
          relative,
        );
      }
    }
  }

  for (const record of journalPaths) {
    for (const candidate of [record.path, record.toPath]) {
      if (typeof candidate !== "string") continue;
      const owner = policy.ownerFor(candidate);
      if (owner === "syncthing" || owner === "conflict") {
        emit("IGNIS_JOURNAL_HISTORY",
          "An existing IGNIS file or change refers to this media subtree", candidate);
      }
    }
  }
  if (activeDeviceCount) {
    emit("DEVICES_NOT_QUIESCED",
      "Enrolled clients may have unsent operations; their agreement is required");
  }

  return {
    mode: "read-only-preflight",
    safeForEmptyPilot: issues.length === 0,
    policy: { enabled: policy.enabled, roots: [...policy.roots] },
    activeDeviceCount,
    issues,
    // Do not return a mutation token. A separate transactional migration
    // protocol must coordinate the server and *all* registered clients.
    activationAvailable: false,
  };
}

module.exports = { preflightMediaOwnership };
