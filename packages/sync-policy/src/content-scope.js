const { createSyncPolicy } = require("./index");
const {
  normalizeMediaBypassExtensions, bypassesPath,
} = require("./media-bypass");

const CONTENT_SCOPES = Object.freeze(["all", "markdown-only"]);

// Content eligibility and ownership are orthogonal: whether Syncthing is
// installed or running must never change the set of files IGNIS may publish.
function createContentScope(mode = "all", bypassExtensions = []) {
  if (!CONTENT_SCOPES.includes(mode)) {
    throw new Error("Unknown IGNIS sync content scope");
  }
  const base = createSyncPolicy();
  const bypass = normalizeMediaBypassExtensions(bypassExtensions);
  function allowsPath(relative) {
    if (base.ownerFor(relative) !== "ignis") return false;
    return mode !== "markdown-only" || relative.toLowerCase().endsWith(".md") ||
      bypassesPath(relative, bypass);
  }
  return Object.freeze({ mode, bypassExtensions: bypass, allowsPath });
}

module.exports = { CONTENT_SCOPES, createContentScope };
