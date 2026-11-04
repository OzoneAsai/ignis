// A write is an immutable, durably staged request. Retrying after a lost HTTP
// response must reuse both the opId and the exact bytes of the first request.
// Reconstructing the request from the current editor would silently turn a
// network retry into a different mutation.
export type StagedWrite = {
  opId: string;
  type: "create" | "modify";
  path: string;
  content?: string;
  contentBase64?: string;
  fileId?: string;
  generationId?: string;
  baseHash?: string;
  localHash: string;
};

export type WriteReceipt = {
  opId: string;
  type: string;
  path: string;
  fileId: string;
  generationId: string;
  hash: string | null;
  seq: number;
};

export function stageWrite(
  pending: StagedWrite[], request: StagedWrite
): StagedWrite {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(request.opId) ||
      !["create", "modify"].includes(request.type) ||
      !request.path || !/^[a-f0-9]{64}$/.test(request.localHash) ||
      (typeof request.content === "string") ===
        (typeof request.contentBase64 === "string")) {
    throw new Error("Invalid staged write");
  }
  const existing = pending.find((item) => item.path === request.path);
  if (existing) return existing;
  pending.push({ ...request });
  return request;
}

export function acknowledgeWrite(
  pending: StagedWrite[], receipt: WriteReceipt
): StagedWrite {
  const staged = pending[0];
  if (!staged || receipt.opId !== staged.opId ||
      receipt.type !== staged.type || receipt.path !== staged.path ||
      typeof receipt.fileId !== "string" ||
      typeof receipt.generationId !== "string" ||
      !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 ||
      receipt.hash !== staged.localHash) {
    throw new Error("Server acknowledged a different staged write");
  }
  pending.shift();
  return staged;
}
