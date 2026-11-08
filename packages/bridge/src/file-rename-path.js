// The user edits the visible basename; the existing extension and directory
// are part of the file identity and never change from this mobile action.
export function renameDestination(vault, file, enteredName) {
  if (!file || typeof file.path !== "string" || !file.path) {
    throw new Error("変更するファイルが見つかりません");
  }
  const previous = file.path.split("/").pop();
  const dot = previous.lastIndexOf(".");
  const extension = dot > 0 ? previous.slice(dot) : "";
  let basename = String(enteredName ?? "").trim();

  // Accept either '写真' or a pasted '写真.png', but never double the extension.
  if (extension && basename.toLowerCase().endsWith(extension.toLowerCase())) {
    basename = basename.slice(0, -extension.length).trim();
  }
  if (!basename || basename === "." || basename === ".." ||
      /[/\\<>:"|?*]/u.test(basename) ||
      [...basename].some(char => char.charCodeAt(0) < 32) ||
      basename.endsWith(".") || basename.endsWith(" ")) {
    throw new Error("ファイル名に使用できない文字が含まれています");
  }
  const folder = file.path.slice(0, file.path.length - previous.length);
  const destination = folder + basename + extension;
  if (destination !== file.path && vault.getAbstractFileByPath(destination)) {
    throw new Error("同じ名前のファイルが既にあります。別の名前を選んでください");
  }
  return destination;
}

export function fileBaseName(file) {
  const name = file.name || file.path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileExtension(file) {
  const name = file.name || file.path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
