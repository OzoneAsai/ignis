/**
 * An Obsidian Vault file is not an atomic unit while Finder, a downloader, or
 * a camera is copying bytes into it. Do not create a durable operation from
 * a transient prefix. A file is eligible only after two byte-identical reads
 * separated by a quiet interval, with unchanged size/mtime on both sides.
 *
 * This is a conservative eligibility check, not an OS-wide write lock.
 * The durable operation receipt/abandon protocol handles a later race.
 */
export type BinaryStamp = { size: number; mtime: number };

function sameStamp(a: BinaryStamp | null, b: BinaryStamp | null): boolean {
  return !!a && !!b && Number.isFinite(a.size) &&
    Number.isFinite(a.mtime) && a.size === b.size && a.mtime === b.mtime;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function readQuiescentBinary(options: {
  stat: () => Promise<BinaryStamp | null>;
  read: () => Promise<Uint8Array>;
  wait: () => Promise<void>;
  maxBytes: number;
}): Promise<Uint8Array | null> {
  const firstStart = await options.stat();
  if (!firstStart || firstStart.size > options.maxBytes ||
      firstStart.size < 0) return null;
  const first = await options.read();
  const firstEnd = await options.stat();
  if (first.byteLength !== firstStart.size ||
      !sameStamp(firstStart, firstEnd)) return null;
  await options.wait();
  const secondStart = await options.stat();
  if (!sameStamp(firstEnd, secondStart)) return null;
  const second = await options.read();
  const secondEnd = await options.stat();
  if (second.byteLength !== secondStart!.size ||
      !sameStamp(secondStart, secondEnd) || !sameBytes(first, second)) {
    return null;
  }
  return second;
}
