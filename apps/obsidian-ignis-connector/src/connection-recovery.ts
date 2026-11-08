// Connection identity survives a restart, but a device credential may not.
// Keep the guidance separate from transport and avoid implying that the
// synchronized Vault or its pending edits have been removed.
export function connectionRecoveryLabel(state: {
  ready: boolean; vaultId: string;
}, settings: {
  serverUrl: string; authMode: "device" | "tailnet";
}): string {
  if (state.ready) {
    return "Connected to " + state.vaultId +
      (settings.authMode === "tailnet" ? " · Tailscale" : " · Device token");
  }
  if (state.vaultId && settings.serverUrl) {
    if (settings.authMode === "device") {
      return "Previously connected to " + state.vaultId +
        ". This device needs its verified token again after restart. " +
        "Open Advanced: Vault ID or device-token connection, paste the device " +
        "token and select Connect and verify. Your local notes are retained.";
    }
    return "Previously connected to " + state.vaultId +
      ". Reconnect through your trusted Tailscale identity. " +
      "Your local notes are retained.";
  }
  return "Not connected. Paste your Ignis invite link to start.";
}
