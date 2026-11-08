// One model for mobile visibility and the desktop status-bar's underlying
// connection facts. A live WebSocket is not evidence of a durable document.
import { mobileUiCopy } from "../../server-core/src/mobile-ui-copy.ts";

export function mobileConnectionState(current, transport, writes = "clean", failedWrites = 0, language = "ja") {
  const t = mobileUiCopy(language);
  if (transport !== "open") {
    return transport === "connecting"
      ? { kind: "connecting", label: t.connecting }
      : { kind: "offline", label: t.offline };
  }
  if (failedWrites > 0 || current?.storageError || current?.serverSaveError ||
      current?.protocolError || current?.generationMismatch ||
      current?.pendingConflict) {
    return { kind: "error", label: t.attention };
  }
  if (current && (!current.hydrated || !current.initialized || !current.joined)) {
    return { kind: "connecting", label: t.joining };
  }
  if (writes === "pending" || current?.dirty || current?.localSaving ||
      current?.previewSaving || current?.identitySaving ||
      (current && current.confirmedSeq < current.sentSeq)) {
    return { kind: "syncing", label: t.syncing };
  }
  return current
    ? { kind: "connected", label: t.synced }
    : { kind: "connected", label: t.serverConnected };
}
