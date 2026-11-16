import type { PendingMutation } from "./pending";

// The server can refuse one immutable intention without making every other
// file's sync dependent on it. The refusal is evidence of an unresolved
// intention, never permission to discard the local bytes or opId.
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super("Ignis Sync HTTP " + status + (code ? " (" + code + ")" : ""));
    this.name = "SyncHttpError";
  }
}

const REVIEWABLE = new Set([
  "BASE_MISMATCH", "GENERATION_MISMATCH", "CREATE_CONFLICT",
  "DESTINATION_EXISTS", "RECOVERY_BLOCKED",
  "COLLABORATIVE_FILE_OPERATION_CONFLICT", "COLLABORATIVE_WRITE_CONFLICT",
]);

export function isReviewableConflict(error: unknown): error is SyncHttpError {
  return error instanceof SyncHttpError && error.status === 409 &&
    REVIEWABLE.has(error.code);
}

// Pending renames/deletions form an ordered dependency graph. Two operations
// are independent only if neither touches the other's identity or old/new
// paths. A deferred conflict prevents every dependent successor, but must
// not stop an unrelated file's operation.
export function pendingDependent(
  a: PendingMutation, b: PendingMutation
): boolean {
  if (a.fileId === b.fileId) return true;
  const aPaths = [a.path, a.toPath].filter((v): v is string => !!v);
  const bPaths = [b.path, b.toPath].filter((v): v is string => !!v);
  return aPaths.some(path => bPaths.includes(path));
}
