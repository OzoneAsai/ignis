import { createContentScope, type SyncContentScope } from "../../../packages/sync-policy/src/content-scope";
import {
  normalizeMediaBypassExtensions,
} from "../../../packages/sync-policy/src/media-bypass";

export type DeviceContentScope = "follow-server" | "markdown-only";

export function formatLocalBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return Math.floor(bytes) + " B";
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return value.toFixed(1) + " " + units[index];
}

// Server policy is an upper bound, not a suggestion. A device may narrow
// sharing but can never opt into a file the server explicitly excludes.
export function effectiveContentScope(
  serverScope: SyncContentScope,
  deviceScope: DeviceContentScope,
): SyncContentScope {
  if (serverScope === "markdown-only" || deviceScope === "markdown-only") {
    return "markdown-only";
  }
  return "all";
}

// Per-device exceptions only narrow the verified server allowance. This
// calculation is intentionally independent of the Syncthing process state.
export function effectiveMediaBypassExtensions(
  serverScope: SyncContentScope,
  deviceScope: DeviceContentScope,
  serverExtensions: readonly string[] = [],
  selectedExtensions: readonly string[] = [],
): readonly string[] {
  const offered = normalizeMediaBypassExtensions(serverExtensions);
  const selected = normalizeMediaBypassExtensions(selectedExtensions);
  if (deviceScope !== "markdown-only") return offered;
  return selected.filter((extension) =>
    serverScope === "all" || offered.includes(extension));
}

type FileDescriptor = { path: string; stat?: { size?: number } };
type QueuedPath = { path: string; toPath?: string };

export function sharingSummary(
  files: readonly FileDescriptor[],
  serverScope: SyncContentScope,
  deviceScope: DeviceContentScope,
  pending: readonly QueuedPath[] = [],
  pendingWrites: readonly QueuedPath[] = [],
  serverBypassExtensions: readonly string[] = [],
  deviceBypassExtensions: readonly string[] = [],
) {
  const effective = effectiveContentScope(serverScope, deviceScope);
  const effectiveBypass = effectiveMediaBypassExtensions(serverScope, deviceScope,
    serverBypassExtensions, deviceBypassExtensions);
  const policy = createContentScope(effective, effectiveBypass);
  let sharedFiles = 0;
  let localOnlyFiles = 0;
  let oversizedFiles = 0;
  let localOnlyBytes = 0;
  for (const file of files) {
    const bytes = Math.max(0, Number(file.stat?.size) || 0);
    if (policy.allowsPath(file.path) && bytes <= 4 * 1024 * 1024) {
      sharedFiles += 1;
    } else if (createContentScope("all").allowsPath(file.path)) {
      localOnlyFiles += 1;
      localOnlyBytes += bytes;
      if (bytes > 4 * 1024 * 1024) oversizedFiles += 1;
    }
  }
  const blockedQueued = [...pending, ...pendingWrites].filter((item) =>
    !policy.allowsPath(item.path) ||
    (item.toPath !== undefined && !policy.allowsPath(item.toPath))
  ).length;
  return {
    serverScope, deviceScope, effective, effectiveBypass,
    sharedFiles, localOnlyFiles, localOnlyBytes, oversizedFiles,
    pendingOperations: pending.length + pendingWrites.length,
    blockedQueued,
  };
}
