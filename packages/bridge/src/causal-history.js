// Yjs may accept an update frame but defer integration when an earlier
// referenced operation is absent. A live transport, and even a server ACK
// for local updates, do not prove that a participant has received every
// operation needed to reconstruct the shared document.
export function hasMissingYjsAncestors(doc) {
  return Boolean(doc?.store?.pendingStructs?.missing?.size);
}

export const MAX_CAUSAL_REPAIR_ATTEMPTS = 4;

export function causalRepairDelay(attempt) {
  return Math.min(2400, 240 * 2 ** Math.min(attempt, MAX_CAUSAL_REPAIR_ATTEMPTS));
}
