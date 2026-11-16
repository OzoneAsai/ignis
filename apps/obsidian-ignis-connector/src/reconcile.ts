import type { TrackedFile } from "./pending";

export type JournalChange = {
  seq: number;
  type: string;
  path: string;
  toPath?: string | null;
  fileId: string;
  generationId: string;
};

export type DeletionProof = {
  seq: number;
  fileId: string;
  generationId: string;
};

// The journal cursor is a verified frontier, not the resolution state of
// individual file conflicts. Keep proofs for still-tracked identities even
// after the cursor passes their deletion, so a later user opt-in to remote
// deletion cannot turn an unseen absence into an unsafe guess.
export function retainDeletionProofs(
  known: Readonly<Record<string, DeletionProof>>,
  tracked: Readonly<Record<string, TrackedFile>>,
  changes: readonly JournalChange[]
): Record<string, DeletionProof> {
  const proofs: Record<string, DeletionProof> = {};
  for (const [name, base] of Object.entries(tracked)) {
    const old = known[name];
    if (old && old.fileId === base.fileId &&
        old.generationId === base.generationId) proofs[name] = old;
  }
  for (const change of changes) {
    const base = tracked[change.path];
    if (change.type === "delete" && base &&
        change.fileId === base.fileId &&
        change.generationId === base.generationId &&
        (!proofs[change.path] || proofs[change.path].seq < change.seq)) {
      proofs[change.path] = {
        seq: change.seq, fileId: change.fileId,
        generationId: change.generationId
      };
    }
  }
  return proofs;
}

// An absent path is NOT evidence of deletion. Only a durable server tombstone
// for the exact known identity is sufficient to consider a local trash move.
export function classifyAbsence(
  path: string, baseline: TrackedFile,
  currentRemotePaths: ReadonlySet<string>,
  changes: readonly JournalChange[]
): "present" | "tombstone" | "unverified" {
  if (currentRemotePaths.has(path)) return "present";
  const deleted = changes.some((change) =>
    change.type === "delete" && change.path === path &&
    change.fileId === baseline.fileId &&
    change.generationId === baseline.generationId
  );
  return deleted ? "tombstone" : "unverified";
}

// A manifest describes one server snapshot, not writes this client commits
// later in the same reconciliation pass. Compare absence only against the
// exact tracked version that existed when that manifest was requested.
// Otherwise a newly acknowledged local create would appear absent from an
// older manifest and be misreported as a remote deletion.
export function classifySnapshotAbsence(
  path: string,
  current: TrackedFile,
  atManifest: TrackedFile | undefined,
  currentRemotePaths: ReadonlySet<string>,
  changes: readonly JournalChange[],
  proof?: DeletionProof
): "post-snapshot" | "present" | "tombstone" | "unverified" {
  if (!atManifest ||
      atManifest.fileId !== current.fileId ||
      atManifest.generationId !== current.generationId ||
      atManifest.hash !== current.hash ||
      atManifest.revision !== current.revision) return "post-snapshot";
  if (currentRemotePaths.has(path)) return "present";
  if (proof?.fileId === atManifest.fileId &&
      proof.generationId === atManifest.generationId) return "tombstone";
  return classifyAbsence(path, atManifest, currentRemotePaths, changes);
}

export async function readChangesThrough(
  start: number, through: number,
  fetchPage: (since: number, limit: number) =>
    Promise<{ changes: JournalChange[]; vaultSeq: number }>
): Promise<JournalChange[]> {
  if (!Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(through) || through < start) {
    throw new Error("Invalid journal range");
  }
  const result: JournalChange[] = [];
  let cursor = start;
  for (let page = 0; cursor < through && page < 100; page++) {
    const response = await fetchPage(cursor, 500);
    if (!response || !Array.isArray(response.changes) ||
        !Number.isSafeInteger(response.vaultSeq) ||
        response.vaultSeq < through) {
      throw new Error("Server returned an incomplete journal");
    }
    const batch = response.changes.filter((change) =>
      Number.isSafeInteger(change.seq) && change.seq > cursor &&
      change.seq <= through
    );
    if (!batch.length) throw new Error("Journal cursor cannot advance");
    for (const change of batch) {
      if (change.seq !== cursor + 1) {
        throw new Error("Gap in server change journal");
      }
      result.push(change);
      cursor = change.seq;
    }
  }
  if (cursor !== through) throw new Error("Change journal exceeds preview replay limit");
  return result;
}
