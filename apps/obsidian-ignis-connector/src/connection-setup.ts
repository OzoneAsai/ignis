// A connection is a transaction, not three independently saved text fields.
// Keep the draft local until one explicit user action has verified all inputs.
export type ConnectionDraft = {
  serverUrl: string;
  vaultId: string;
  token: string;
};

export type ValidatedConnection = {
  origin: string;
  vaultId: string;
  token: string;
  scope: string;
};

const TOKEN = /^ignis_dev_[A-Za-z0-9_-]{43}$/;
const VAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Connection links carry public routing metadata only, NEVER credentials.
// This is usable as one pasted URL on iOS, desktop and future QR pairing.
export function parseJoinLink(raw: string): { origin: string; vaultId: string } {
  const input = raw.trim();
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Paste a complete Ignis HTTPS connection link."); }
  if ((url.protocol !== "https:" &&
    !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS Ignis link without credentials or extra parameters.");
  }
  const matches = /^\/join\/([A-Za-z0-9._%-]+)\/?$/.exec(url.pathname);
  if (url.pathname !== "/" && !matches) {
    throw new Error("Paste the server address or an Ignis /join/VaultID link.");
  }
  let vaultId = "";
  if (matches) {
    try { vaultId = decodeURIComponent(matches[1]); }
    catch { throw new Error("Invalid Vault ID in connection link."); }
    if (!VAULT_ID.test(vaultId)) throw new Error("Invalid Vault ID in connection link.");
  }
  return { origin: url.origin, vaultId };
}

export function normalizeOrigin(raw: string): string {
  const input = raw.trim();
  if (!input) throw new Error("Enter your Ignis server URL first.");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Enter a complete URL, including https://."); }
  if ((url.protocol !== "https:" &&
    !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/") {
    throw new Error("Use only the HTTPS server address, including its port; no extra path.");
  }
  return url.origin;
}

export function validateConnection(
  draft: ConnectionDraft, existingToken = "", allowTailnet = false
): ValidatedConnection {
  const link = parseJoinLink(draft.serverUrl);
  const origin = link.origin;
  const vaultId = link.vaultId || draft.vaultId.trim();
  if (!vaultId) throw new Error("Enter the Vault ID provided by your server.");
  if (!VAULT_ID.test(vaultId)) {
    throw new Error("The Vault ID can contain letters, numbers, dots, hyphens and underscores.");
  }
  const token = draft.token.trim() || existingToken;
  if (!token && !allowTailnet) throw new Error("Paste your device token to connect.");
  if (token && !TOKEN.test(token)) {
    throw new Error("This is not an Ignis device token. It must start with ignis_dev_.");
  }
  return { origin, vaultId, token, scope: origin + "|" + vaultId };
}

export function sessionError(
  status: number, body: unknown, expectedVaultId: string
): string | null {
  if (status === 401 || status === 403) {
    return "Device not authorized for this Vault. Check the Vault ID and device token together.";
  }
  if (status === 404) {
    return "Sync API not found. Check the full server address and port, and confirm that the Vault ID exists.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The HTTPS gateway cannot reach Ignis. Check that the Mac server is running.";
  }
  if (status !== 200) {
    return "Ignis returned HTTP " + status + ". Check the server address and try again.";
  }
  const data = body as { vaultId?: unknown; deviceId?: unknown } | null;
  if (data?.vaultId !== expectedVaultId || typeof data?.deviceId !== "string" ||
      !data.deviceId) {
    return "The server confirmed a different Vault or returned an invalid device identity.";
  }
  return null;
}
