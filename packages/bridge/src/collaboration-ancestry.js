// A filename is a locator, not document ancestry. Yjs operations created
// independently by two clients have distinct struct IDs: applying both
// snapshots doubles even IDENTICAL text. Only a proven server document ID
// licenses merging two CRDT histories.
export function classifyDocumentAncestry({
  hasLocalCopy, localDocumentId, incomingDocumentId,
  localText, incomingText, localHasOperations = true,
}) {
  if (localDocumentId) {
    return localDocumentId === incomingDocumentId
      ? "shared" : "replaced";
  }
  // An initialized but *never edited* offline note may have metadata and no
  // Yjs structs. It has no independent text ancestry to merge or protect.
  if (!hasLocalCopy || !localHasOperations) return "shared";
  if (localText === incomingText) return "adopt-identical";
  return "independent";
}
