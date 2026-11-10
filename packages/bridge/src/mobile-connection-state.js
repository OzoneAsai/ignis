// One model for mobile visibility and the desktop status-bar's underlying
// connection facts. A live WebSocket is not evidence of a durable document.
import { mobileUiCopy } from "../../server-core/src/mobile-ui-copy.ts";

export function mobileConnectionState(current, transport, writes = "clean", failedWrites = 0, language = "ja") {
  const t = mobileUiCopy(language);
  const needsReview = failedWrites > 0 || current?.storageError || current?.serverSaveError ||
      current?.protocolError || current?.generationMismatch || current?.pendingConflict;
  if (transport !== "open") {
    if (needsReview) return { kind: "error", label: language === "en"
      ? "Offline · needs review" : "オフライン・要確認" };
    return transport === "connecting"
      ? { kind: "connecting", label: t.connecting }
      : { kind: "offline", label: t.offline };
  }
  if (needsReview) {
    return { kind: "error", label: t.attention };
  }
  if (current?.causalGap) {
    return { kind: "syncing", label: language === "en"
      ? "Recovering shared history" : "共同編集履歴を修復中" };
  }
  if (current && (!current.hydrated || !current.initialized || !current.joined)) {
    return { kind: "connecting", label: t.joining };
  }
  const pending = writes === "pending" || current?.dirty || current?.localSaving ||
      current?.previewSaving || current?.identitySaving ||
      (current && current.confirmedSeq < current.sentSeq);
  if (current?.composing) {
    const ja = language !== "en";
    return { kind: "syncing", label: pending
      ? (ja ? "同期中・変換未確定" : "Syncing · converting")
      : (ja ? "変換中・未確定" : "Converting · not confirmed") };
  }
  if (pending) {
    return { kind: "syncing", label: t.syncing };
  }
  return current
    ? { kind: "connected", label: t.synced }
    : { kind: "connected", label: t.serverConnected };
}
