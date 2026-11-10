// One status projection over the document state. A recovery copy is an
// independent fact, not a replacement for the current document's save state.
// Therefore it must never hide a local write, failed server ACK, or disconnect.
export function collaborationStatus(current, online) {
  if (!current) {
    return "";
  }

  let status;

  if (current.storageError) {
    status = "Collab: local storage failed · keep this tab open";
  } else if (current.generationMismatch) {
    status = current.joinConflictReason === "independent"
      ? "Collab: separate original · draft protected"
      : "Collab: note replaced · old draft protected";
  } else if (!current.hydrated) {
    status = "Collab: loading local draft…";
  } else if (!current.initialized) {
    status = online ? "Collab: loading note…" : "Collab: offline · note unavailable";
  } else if (current.serverSaveError) {
    status = "Collab: server save failed · local draft retained";
  } else if (current.protocolError) {
    status = "Collab: synchronization error · check this note";
  } else if (current.causalGap) {
    status = online
      ? "Collab: recovering missing shared history…"
      : "Collab: offline · shared history incomplete";
  } else if (current.localSaving || current.previewSaving || current.identitySaving) {
    status = online ? "Collab: saving to device…" : "Collab: offline · saving locally…";
  } else if (!online) {
    status = "Collab: offline · saved on device";
  } else if (!current.joined) {
    status = "Collab: reconnecting · local copy ready";
  } else if (current.dirty || current.confirmedSeq < current.sentSeq) {
    status = `Collab: syncing · ${current.participants} online`;
  } else {
    status = `Collab: ${current.participants} online · saved`;
  }

  // A successful server receipt confirms durability of the *provisional*
  // CRDT bytes, not that the human accepted an IME conversion candidate.
  // These are independent dimensions and both need to be visible.
  if (current.composing) {
    status = status.replace(/ · saved$/, " · provisional draft acknowledged");
    status += " · IME not confirmed";
    if (current.compositionPublished && online) {
      status += " · draft may be visible to peers";
    }
    if (current.imeProjectionBlocked) {
      status += " · peer edit waiting for candidate end";
    }
  }

  if (typeof current.pendingConflict === "string" && !current.generationMismatch) {
    status += " · recovered draft available";
  }

  return status;
}

// The status bar is narrow, especially alongside Obsidian's other items.
// Keep the full, truthful state in the dialog / accessible label; make the
// always-visible summary readable without truncating the critical IME fact.
export function collaborationStatusSummary(current, online) {
  if (!current) return "";
  if (!current.composing) return collaborationStatus(current,online);
  if (current.storageError) return "ローカル保存失敗 · IME未確定";
  if (current.serverSaveError) return "サーバー保存失敗 · IME未確定";
  if (current.protocolError || current.generationMismatch) {
    return "同期確認が必要 · IME未確定";
  }
  if (current.causalGap) return "履歴を修復中 · IME未確定";
  if (!online) return "オフライン · IME未確定";
  if (!current.joined || !current.initialized) return "再接続中 · IME未確定";
  if (current.imeProjectionBlocked) return "競合保留中 · IME未確定";
  return "IME変換中 · 未確定";
}
