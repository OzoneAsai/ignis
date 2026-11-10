// The local operation queue is a sequence of path transitions of *file
// identities*, not a list of unrelated filenames. The server remains the
// authority: these are durable local intentions until each opId is ACKed.
export type TrackedFile = {
  fileId: string;
  generationId: string;
  hash: string;
  revision: number;
};

export type PendingMutation = {
  opId: string;
  type: "rename" | "delete";
  path: string;
  toPath?: string;
  fileId: string;
  generationId: string;
  baseHash: string;
};

export type PendingState = {
  baselines: Record<string, TrackedFile>;
  pending: PendingMutation[];
};

type Receipt = {
  seq: number;
  fileId: string;
  generationId: string;
  hash: string | null;
  opId: string;
  type: string;
  path: string;
  toPath?: string | null;
};

function sameIdentity(file: TrackedFile, operation: PendingMutation): boolean {
  return file.fileId === operation.fileId &&
    file.generationId === operation.generationId;
}

// Replay every unacknowledged operation over the last confirmed paths. This
// gives us the local file identity after arbitrary rename chains:
// A -> B -> C, A -> B -> delete(B), and even A -> B -> A.
export function localPaths(state: PendingState): Map<string, TrackedFile> {
  const paths = new Map(Object.entries(state.baselines));
  for (const operation of state.pending) {
    const identity = paths.get(operation.path);
    if (!identity || !sameIdentity(identity, operation)) continue;
    paths.delete(operation.path);
    if (operation.type === "rename" && operation.toPath) {
      paths.set(operation.toPath, identity);
    }
  }
  return paths;
}

export function queueRename(
  state: PendingState, oldPath: string, newPath: string, opId: string
): boolean {
  if (!oldPath || !newPath || oldPath === newPath) return false;
  const paths = localPaths(state);
  const identity = paths.get(oldPath);
  if (!identity || paths.has(newPath)) return false;
  state.pending.push({
    opId, type: "rename", path: oldPath, toPath: newPath,
    fileId: identity.fileId, generationId: identity.generationId,
    baseHash: identity.hash
  });
  return true;
}

export function queueDelete(
  state: PendingState, path: string, opId: string
): boolean {
  const identity = localPaths(state).get(path);
  if (!identity) return false;
  state.pending.push({
    opId, type: "delete", path, fileId: identity.fileId,
    generationId: identity.generationId, baseHash: identity.hash
  });
  return true;
}

export function acknowledgePending(
  state: PendingState, received: Receipt
): PendingMutation {
  const index = state.pending.findIndex(item => item.opId === received.opId);
  const pending = state.pending[index];
  if (!pending || !Number.isSafeInteger(received.seq) || received.seq < 1 ||
      pending.fileId !== received.fileId ||
      pending.generationId !== received.generationId ||
      pending.opId !== received.opId || pending.type !== received.type ||
      pending.path !== received.path ||
      (pending.type === "rename" && pending.toPath !== received.toPath)) {
    throw new Error("Server acknowledged a different queued operation");
  }
  const tracked = state.baselines[pending.path];
  if (!tracked || !sameIdentity(tracked, pending)) {
    throw new Error("Confirmed file baseline does not match queued operation");
  }
  if (pending.type === "rename" && !pending.toPath) {
    throw new Error("Rename has no destination");
  }
  if (pending.type === "rename" && state.baselines[pending.toPath!]) {
    throw new Error("Rename destination already has a confirmed identity");
  }
  delete state.baselines[pending.path];
  if (pending.type === "rename") {
    state.baselines[pending.toPath!] = {
      ...tracked,
      hash: received.hash ?? tracked.hash,
      generationId: received.generationId
    };
  }
  state.pending.splice(index, 1);
  return pending;
}
