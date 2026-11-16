// A path collision is NOT evidence of shared document ancestry. First save
// immutable, separately named versions; only then may a user reconcile them.
// This module is transport/UI independent so desktop and mobile use one model.

export type PreservedMigration = {
  scope: string;
  path: string;
  sourceHash: string;
  sourceCopy: string;
  remoteHash: string | null;
  remoteCopy: string | null;
  remoteFileId: string | null;
  remoteGenerationId: string | null;
};

export type VersionRole = "device" | "server";

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function trimToByteLength(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let output = "";
  let used = 0;
  for (const char of input) {
    const length = encoder.encode(char).byteLength;
    if (used + length > maxBytes) break;
    output += char;
    used += length;
  }
  return output;
}

// Keep the original folder and extension, so copies remain easy to discover
// alongside their source. Include real device/generation identity and content
// hash; a changed draft always gets a NEW independent name.
export function migrationVersionPath(
  original: string, role: VersionRole, identity: string,
  digest: string, ordinal = 0
): string {
  if (!original || original.includes("\\") || original.startsWith("/") ||
      original.split("/").some(part => !part || part === "." || part === "..") ||
      !HEX64.test(digest) || !SAFE_ID.test(identity) ||
      !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 99) {
    throw new Error("Invalid migration filename");
  }
  const slash = original.lastIndexOf("/");
  const parent = slash < 0 ? "" : original.slice(0, slash + 1);
  const filename = original.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot) : "";
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const suffix = " (Ignis " + role + " " + identity.slice(0, 12) +
    " " + digest.slice(0, 12) + (ordinal ? "-" + ordinal : "") + ")";
  // 230 UTF-8 bytes stays below common 255-byte component limits, including
  // macOS normalization differences and the extension.
  const allowance = 230 - new TextEncoder().encode(suffix + extension).byteLength;
  if (allowance < 1) throw new Error("Migration filename is too long");
  const shortStem = trimToByteLength(stem, allowance) || "note";
  const result = parent + shortStem + suffix + extension;
  if (new TextEncoder().encode(result).byteLength > 2048) {
    throw new Error("Migration path is too long");
  }
  return result;
}

export function isMigrationRecordCurrent(
  record: PreservedMigration | undefined,
  scope: string, sourceHash: string,
  remote: { hash: string; fileId: string; generationId: string } | null
): boolean {
  return !!record && record.scope === scope && record.sourceHash === sourceHash &&
    record.remoteHash === (remote?.hash ?? null) &&
    record.remoteFileId === (remote?.fileId ?? null) &&
    record.remoteGenerationId === (remote?.generationId ?? null);
}

export function migrationNeedsPreservation(reason: string): boolean {
  return /Existing on both devices|Concurrent edit|Replaced document generation|Live editor blocked|Remote deleted|Remote missing/i.test(reason);
}

export function migrationCardLabel(path: string): string {
  const filename = path.split("/").at(-1) || path;
  // The distinguishing suffix matters more than the shared directory and
  // prefix: MacFirst.md and SLSFirst.md must never look identical in a row.
  return [...filename].length > 28 ? "…" + [...filename].slice(-25).join("") : filename;
}
