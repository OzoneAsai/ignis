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
  if (/revoked|rejected|unauthoriz|denied|not allowed|not available|error|failed|need.s? review|conflict|blocked|Undo\/Redo \d+件を確認|server history|sync paused|server update required|journal identity/i.test(message)) {
    return { kind: "error", label: t.attention };
  }
  if (!configured) return { kind: "offline", label: t.unconfigured };
  if (!socketOpen) return { kind: "offline", label: t.offline };
  if (/IME not confirmed|IME未確定|変換未確定/i.test(message)) {
    return { kind: "syncing", label: language === "ja"
      ? (/peer edit waiting|競合保留/i.test(message)
        ? "競合保留中・IME未確定" : "IME変換中・未確定")
      : (/peer edit waiting/i.test(message)
        ? "Peer edit waiting · IME draft" : "Converting · not confirmed") };
  }
  if (/device token not saved/i.test(message)) {
    return { kind: "syncing", label: language === "ja"
      ? "認証未保存・再接続が必要" : "Session only · token not saved" };
  }
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
