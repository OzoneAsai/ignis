import { uniqueUploadPath, type VaultPathLookup } from
  "../../../packages/server-core/src/vault-upload-path";
import { mobileUiCopy } from "../../../packages/server-core/src/mobile-ui-copy";

export type NativeStatus = { kind: "connected" | "syncing" | "offline" | "error";
  label: string };

// Native Obsidian's desktop status bar is not supported on iOS. The mobile
// indicator must not call a merely open socket "saved" until the server ACKs.
export function nativeConnectionState(
  message: string, configured: boolean, socketOpen: boolean,
  language: "ja" | "en" = "ja"
): NativeStatus {
  const t = mobileUiCopy(language);
  if (/revoked|unauthoriz|error|failed|need.s? review|conflict|blocked/i.test(message)) {
    return { kind: "error", label: t.attention };
  }
  if (!configured) return { kind: "offline", label: t.unconfigured };
  if (!socketOpen) return { kind: "offline", label: t.offline };
  if (/syncing|pending|waiting|offline|reconnect|awaiting/i.test(message)) {
    return { kind: "syncing", label: t.syncing };
  }
  if (/^Synced · server acknowledged$/i.test(message)) {
    return { kind: "connected", label: t.synced };
  }
  return { kind: "connected", label: t.serverConnected };
}

export type NativeFile = Pick<File, "name" | "size" | "arrayBuffer">;
export type NativeUploadVault = VaultPathLookup & {
  getRoot(): { path: string };
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
};

export async function importNativeFiles(
  vault: NativeUploadVault, files: readonly NativeFile[],
  isSafePath: (path: string) => boolean, maxFileBytes = 4 * 1024 * 1024
): Promise<{ imported: number; failed: number; tooLarge: number }> {
  let imported = 0;
  let failed = 0;
  let tooLarge = 0;
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size > maxFileBytes) {
      tooLarge++;
      continue;
    }
    try {
      const path = uniqueUploadPath(vault, vault.getRoot().path, file.name);
      if (!isSafePath(path)) {
        failed++;
        continue;
      }
      await vault.createBinary(path, await file.arrayBuffer());
      imported++;
    } catch {
      failed++;
    }
  }
  return { imported, failed, tooLarge };
}
