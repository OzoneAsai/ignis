// Participant names are a device preference, not a tab identity. In an
// installed PWA, sessionStorage disappears when the standalone app is closed,
// but the locally chosen name should survive the next launch.
export const NAME_KEY = "ignis-collab-display-name";

export function normalizeDisplayName(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim().slice(0, 40);
}

export function preferredDisplayName(persistent, tab) {
  for (const [index, storage] of [persistent, tab].entries()) {
    try {
      const value = normalizeDisplayName(storage?.getItem(NAME_KEY));
      if (value) {
        // Migrate a name saved by older WebUI versions in sessionStorage.
        if (index === 1) {
          try {
            persistent?.setItem(NAME_KEY, value);
          } catch {
            // It remains available for the lifetime of the current tab.
          }
        }
        return value;
      }
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }
  return "";
}

export function saveDisplayName(value, persistent, tab) {
  const clean = normalizeDisplayName(value);
  if (!clean) return "";
  for (const storage of [persistent, tab]) {
    try {
      storage?.setItem(NAME_KEY, clean);
    } catch {
      // Keep the other storage as a fallback when one cannot be written.
    }
  }
  return clean;
}
