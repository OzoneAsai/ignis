// Shared by the Ignis WebUI and native Obsidian Connector. Obsidian may report
// the Vault root as "/" even though getAbstractFileByPath expects a relative
// path. One canonical naming model prevents cross-platform data loss.
export type VaultPathLookup = {
  getAbstractFileByPath(path: string): unknown;
};

export function uniqueUploadPath(
  vault: VaultPathLookup, folderPath: string, fileName: string
): string {
  const name = String(fileName || "").split(/[\\/]/).pop();
  if (!name || name === "." || name === "..") {
    throw new Error("Invalid upload filename");
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const normalizedFolder = String(folderPath || "").replace(/^\/+|\/+$/g, "");
  const pathFor = (candidate: string) => normalizedFolder
    ? `${normalizedFolder}/${candidate}` : candidate;
  const initial = pathFor(name);
  if (!vault.getAbstractFileByPath(initial)) return initial;
  for (let i = 1; i <= 9999; i++) {
    const candidate = pathFor(`${stem} (${i})${ext}`);
    if (!vault.getAbstractFileByPath(candidate)) return candidate;
  }
  throw new Error("No available filename for this upload");
}
