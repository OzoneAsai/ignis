// These extensions are eligible for explicit IGNIS Vault Sync bypass.
// The list is intentionally finite. An extension does not establish trusted
// content, but it prevents executable/config/credential files being opted in.
const MEDIA_BYPASS_TYPES = Object.freeze([
  "pdf", "docx", "xlsx", "pptx", "doc", "xls", "ppt",
  "odt", "ods", "odp", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "heic",
  "mp3", "m4a", "wav", "mp4", "mov",
]);
const KNOWN = new Set(MEDIA_BYPASS_TYPES);

function normalizeMediaBypassExtensions(value = []) {
  if (!Array.isArray(value) || value.length > MEDIA_BYPASS_TYPES.length) {
    throw new Error("Invalid media bypass extension list");
  }
  const extensions = value.map((raw) => {
    if (typeof raw !== "string" || !/^[a-zA-Z0-9]{2,6}$/.test(raw)) {
      throw new Error("Invalid media bypass extension");
    }
    const extension = raw.toLowerCase();
    if (!KNOWN.has(extension)) {
      throw new Error("Unsupported media bypass extension");
    }
    return extension;
  });
  return Object.freeze([...new Set(extensions)].sort());
}

function bypassesPath(relative, extensions) {
  if (typeof relative !== "string") return false;
  const name = relative.split("/").at(-1);
  const dot = name?.lastIndexOf(".") ?? -1;
  if (dot <= 0 || dot === name.length - 1) return false;
  return extensions.includes(name.slice(dot + 1).toLowerCase());
}

module.exports = {
  MEDIA_BYPASS_TYPES,
  normalizeMediaBypassExtensions,
  bypassesPath,
};
