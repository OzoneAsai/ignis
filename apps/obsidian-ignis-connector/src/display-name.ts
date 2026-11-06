// Presentation names are deliberately distinct from authenticated device
// identities and Vault permissions. Match the server's 40-character limit.
export const DISPLAY_NAME_LIMIT = 40;

export function normalizeDisplayName(input: string): string {
  return input
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, DISPLAY_NAME_LIMIT);
}

export function effectiveDisplayName(name: string, deviceId: string): string {
  return normalizeDisplayName(name) ||
    ("Obsidian " + (deviceId ? deviceId.slice(0, 6) : "Native"));
}
