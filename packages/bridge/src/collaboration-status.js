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
    status = "Collab: note replaced · old draft protected";
  } else if (!current.hydrated) {
    status = "Collab: loading local draft…";
  } else if (!current.initialized) {
    status = online ? "Collab: loading note…" : "Collab: offline · note unavailable";
  } else if (current.serverSaveError) {
    status = "Collab: server save failed · local draft retained";
  } else if (current.protocolError) {
    status = "Collab: synchronization error · check this note";
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

  if (typeof current.pendingConflict === "string" && !current.generationMismatch) {
    status += " · recovered draft available";
  }

  return status;
}
