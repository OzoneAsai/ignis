// A successful HTTP device-session check does not imply that the server's
// WebSocket Origin policy permits Obsidian's app:// renderer. Only the
// explicit sync-auth denial means the device token was rejected.
export function classifySyncSocketClose(
  code: number, reason: string
): { terminal: boolean; status: string } {
  if (code === 4001) {
    return { terminal: true, status: "Vault is not available on this server" };
  }
  if (code === 4003) {
    const status = reason === "Origin not allowed"
      ? "Obsidian app origin not allowed by server"
      : reason === "Tailnet identity not authorized"
        ? "Tailnet identity not authorized for this Vault"
        : reason === "Sync authorization failed"
          ? "Device token rejected or revoked"
          : "Realtime connection denied by server";
    return { terminal: true, status };
  }
  if (code === 4002) {
    return { terminal: false, status: "Vault changed · reconnecting" };
  }
  return { terminal: false, status: "Offline · local Vault retained" };
}
