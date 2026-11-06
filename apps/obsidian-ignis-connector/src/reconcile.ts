import type { TrackedFile } from "./pending";

export type JournalChange = {
  seq: number;
  type: string;
  path: string;
  toPath?: string | null;
  fileId: string;
  generationId: string;
};

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
