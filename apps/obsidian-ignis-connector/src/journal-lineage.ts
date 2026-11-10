// Server URL, Vault name, sequence number and visible file bytes are not
// identities. A SQLite sync journal has a durable lineage independent of its
// monotonic sequence and the individual file generations it contains.
export type JournalFileIdentity = {
  path: string;
  fileId: string;
  generationId: string;
};

export type JournalTrust =
  | { state: "trusted"; lineage: string; newlyPinned: boolean }
  | { state: "hold"; reason:
    "unsupported" | "changed" | "behind" | "legacy-unproven" | "diverged" };

export type JournalEvidence = {
  pinnedLineage?: string | null;
  remoteLineage?: string | null;
  cursor: number;
  remoteSeq: number;
  tracked: JournalFileIdentity[];
  liveGenerations: string[];
  remoteFiles: JournalFileIdentity[];
};

const LINEAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function assessJournalTrust(evidence: JournalEvidence): JournalTrust {
  const { pinnedLineage, remoteLineage, cursor, remoteSeq, tracked,
    liveGenerations, remoteFiles } = evidence;
  if (!remoteLineage || !LINEAGE_ID.test(remoteLineage)) {
    return { state: "hold", reason: "unsupported" };
  }
  if (pinnedLineage && pinnedLineage !== remoteLineage) {
    return { state: "hold", reason: "changed" };
  }
  if (!Number.isSafeInteger(remoteSeq) || remoteSeq < 0 ||
      !Number.isSafeInteger(cursor) || cursor < 0 || remoteSeq < cursor) {
    return { state: "hold", reason: "behind" };
  }
  if (pinnedLineage) {
    return { state: "trusted", lineage: remoteLineage, newlyPinned: false };
  }
  const priorHistory = cursor > 0 || tracked.length > 0 || liveGenerations.length > 0;
  if (!priorHistory) {
    return { state: "trusted", lineage: remoteLineage, newlyPinned: true };
  }
  // Upgrade from a pre-lineage Connector: do not blindly pin whatever is
  // reachable at the old URL. Require at least one verified persisted file
  // generation as continuity evidence. Matching Markdown bytes do not prove
  // that an offline Yjs document belongs to the same CRDT ancestry.
  const continuity = tracked.some(local => remoteFiles.some(remote =>
    local.fileId === remote.fileId &&
    local.generationId === remote.generationId)) ||
    liveGenerations.some(id => remoteFiles.some(remote =>
      remote.generationId === id));
  return continuity
    ? { state: "trusted", lineage: remoteLineage, newlyPinned: true }
    : { state: "hold", reason: "legacy-unproven" };
}

// A restored SQLite snapshot keeps its original journal UUID. If it later
// receives different operations, the sequence may catch up or run ahead of
// the last verified cursor. Compare the exact historical entry, never the
// latest mutable counter. The server's checkpoint endpoint uses an indexed
// (vault_id,seq) lookup, so a large Vault needs no full history scan.
export function journalProofMatches(pinned: string,
  observed: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(pinned) &&
    typeof observed === "string" && pinned === observed;
}

export function journalHoldMessage(reason: Extract<JournalTrust,{state:"hold"}>["reason"]): string {
  switch (reason) {
    case "unsupported": return "Server update required · local notes retained";
    case "changed": return "Server history changed · sync paused · local notes retained";
    case "behind": return "Server history is behind · sync paused · local notes retained";
    case "legacy-unproven": return "Server history cannot be verified · local notes retained";
    case "diverged": return "Server history diverged · sync paused · local notes retained";
  }
}

export function journalHoldExplanation(reason: Extract<JournalTrust,{state:"hold"}>["reason"]): string {
  switch (reason) {
    case "unsupported":
      return "This server does not provide a durable Sync history identity. Update Ignis Server, then recheck. Local drafts and queued edits are unchanged.";
    case "changed":
      return "This Vault name now points to a different Sync history. Restore the former server journal, or explicitly connect to a new Vault and review both versions. No automatic upload or deletion was attempted.";
    case "behind":
      return "The server has fewer journal events than this Connector already acknowledged. Restore the complete server journal and recheck. Your local originals and pending operations remain intact.";
    case "legacy-unproven":
      return "The Connector knows older document generations, but cannot prove that this is their original server after the upgrade. Verify the old journal or use an explicitly separate Vault. Nothing was overwritten.";
    case "diverged":
      return "This server has different operations at a previously confirmed history checkpoint. Restore the original journal or explicitly migrate to another Vault. No queued writes or collaborative edits were sent to the divergent history.";
  }
}
