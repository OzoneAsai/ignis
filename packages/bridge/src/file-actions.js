import { Modal, Notice } from "obsidian";
import { uniqueUploadPath } from "../../server-core/src/vault-upload-path.ts";
import { fileBaseName, fileExtension, renameDestination } from "./file-rename-path.js";
import { showPdfPreview } from "./pdf-preview.js";
export { uniqueUploadPath };

function getVaultId() {
  return window.__currentVaultId || "";
}

function triggerDownload(endpoint, filePath, downloadName) {
  const vaultId = getVaultId();
  const url =
    `/api/fs/${endpoint}` +
    `?vault=${encodeURIComponent(vaultId)}` +
    `&path=${encodeURIComponent(filePath)}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  a.click();
}

async function copyIgnisUrl(file) {
  const url =
    `${window.location.origin}/?vault=${encodeURIComponent(getVaultId())}` +
    `&file=${encodeURIComponent(file.path)}`;

  const copied = await writeToClipboard(url);

  new Notice(copied ? "Ignis URL copied" : `Ignis URL: ${url}`);
}

// navigator.clipboard needs a secure context; the execCommand path also copies on plain HTTP.
async function writeToClipboard(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A rejected write (no focus, denied permission) falls through to execCommand.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  let ok = false;

  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  textarea.remove();
  return ok;
}

function showFilePicker(app, targetFolder = null, options = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.className = "ignis-upload-file-input";
  input.setAttribute("aria-label", "Vaultに追加するファイルを選ぶ");
  // Safari iOS can reject a click on an input with display:none. Keep it
  // rendered but visually off-screen, invoking click synchronously while the
  // actual Upload button is handling a user gesture.
  input.style.position = "fixed";
  input.style.width = "1px";
  input.style.height = "1px";
  input.style.opacity = "0";
  input.style.left = "-100px";
  input.style.top = "0";
  const cleanup = () => input.remove();
  input.addEventListener("cancel", cleanup, { once: true });

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) {
      cleanup();
      return;
    }

    const folder = targetFolder || app.vault.getRoot();
    const folderPath = folder.path;

    new Notice(`Uploading ${files.length} file(s)...`);
    options.onProgress?.({ phase: "uploading", total: files.length });

    let successCount = 0;
    let errorCount = 0;

    try {
      for (const file of files) {
        let targetPath = null;
        try {
          targetPath = uniqueUploadPath(app.vault, folderPath, file.name);
          const arrayBuffer = await file.arrayBuffer();

          await app.vault.createBinary(targetPath, arrayBuffer);
          successCount++;
        } catch (e) {
          console.error("[ignis-bridge] Upload failed:", file.name, targetPath, e);
          errorCount++;
        }
      }

      if (successCount > 0) {
        new Notice(`Uploaded ${successCount} file(s) successfully`);
      }

      if (errorCount > 0) {
        new Notice(`Failed to upload ${errorCount} file(s)`, 5000);
      }
    } finally {
      options.onProgress?.({
        phase: "complete", total: files.length, successCount, errorCount
      });
      cleanup();
    }
  });

  document.body.appendChild(input);
  input.click();
  return input;
}

// The native Obsidian file explorer hides file actions behind a long press on
// mobile. Give every Vault file (images included) a searchable, explicit way
// to rename via the existing Ignis navbar menu and desktop command palette.
class FileRenameModal extends Modal {
  constructor(app, selectedFile = null) {
    super(app);
    this.selectedFile = selectedFile;
  }

  onOpen() {
    this.contentEl.addClass("ignis-file-rename-modal");
    if (this.selectedFile) this.showEditor(this.selectedFile);
    else this.showPicker();
  }

  showPicker() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "ファイル名を変更" });
    root.createEl("p", { text: "変更するファイルを選択してください（画像・PDF・ノートに対応）" });

    const search = root.createEl("input", { type: "search" });
    search.className = "ignis-rename-file-search";
    search.placeholder = "ファイル名やフォルダー名で検索";
    search.setAttribute("aria-label", "変更するファイルを検索");
    search.autocomplete = "off";
    const results = root.createDiv({ cls: "ignis-rename-file-results" });
    results.setAttribute("role", "list");

    const files = [...(this.app.vault.getFiles?.() || [])].sort((a, b) =>
      (b.stat?.mtime || 0) - (a.stat?.mtime || 0) ||
      a.path.localeCompare(b.path));
    const renderResults = () => {
      results.empty();
      const query = search.value.trim().toLocaleLowerCase();
      let shown = 0;
      for (const file of files) {
        if (query && !file.path.toLocaleLowerCase().includes(query)) continue;
        if (shown++ >= 60) break;
        const choice = results.createEl("button", { text: file.path });
        choice.type = "button";
        choice.className = "ignis-rename-file-select";
        choice.setAttribute("aria-label", `名前を変更: ${file.path}`);
        choice.addEventListener("click", () => this.showEditor(file));
      }
      if (shown === 0) {
        results.createEl("p", { text: "該当するファイルはありません" });
      } else if (shown > 60) {
        results.createEl("p", { text: "結果が多いため、検索で絞り込んでください" });
      }
    };
    search.addEventListener("input", renderResults);
    renderResults();
  }

  showEditor(file) {
    this.selectedFile = file;
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "ファイル名を変更" });
    root.createEl("p", { text: `現在: ${file.path}` });
    const back = root.createEl("button", { text: "ほかのファイルを選ぶ" });
    back.type = "button";
    back.className = "ignis-rename-back";
    back.addEventListener("click", () => this.showPicker());

    const form = root.createEl("form", { cls: "ignis-rename-form" });
    const label = form.createEl("label", { text: "新しいファイル名" });
    const name = label.createEl("input", { type: "text" });
    name.value = fileBaseName(file);
    name.setAttribute("aria-label", "新しいファイル名（拡張子を除く）");
    name.autocomplete = "off";
    name.required = true;
    form.createEl("p", { text: `拡張子 ${fileExtension(file) || "（なし）"} は変更しません` });
    const feedback = form.createEl("p", { cls: "ignis-rename-feedback" });
    feedback.setAttribute("role", "alert");
    const submit = form.createEl("button", { text: "名前を変更", type: "submit" });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      feedback.setText("");
      let destination;
      try {
        if (!this.app.vault.getAbstractFileByPath(file.path)) {
          throw new Error("ファイルが移動・削除されています。もう一度選択してください");
        }
        destination = renameDestination(this.app.vault, file, name.value);
        if (destination === file.path) {
          this.close();
          return;
        }
        submit.disabled = true;
        if (typeof this.app.fileManager?.renameFile === "function") {
          await this.app.fileManager.renameFile(file, destination);
        } else {
          await this.app.vault.rename(file, destination);
        }
        new Notice(`ファイル名を変更しました: ${destination}`);
        this.close();
      } catch (error) {
        feedback.setText(error?.message || "名前を変更できませんでした");
      } finally {
        submit.disabled = false;
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function showFileRename(app, file = null) {
  const modal = new FileRenameModal(app, file);
  modal.open();
  return modal;
}

function addFileMenuItems(menu, file, app) {
  if (file.path?.toLowerCase().endsWith(".pdf")) {
    menu.addItem((item) => {
      item
        .setTitle("PDFを表示")
        .setIcon("file-text")
        .onClick(() => showPdfPreview(app, file));
    });
  }
  menu.addItem((item) => {
    item
      .setTitle("ファイル名を変更")
      .setIcon("pencil")
      .onClick(() => showFileRename(app, file));
  });
  menu.addItem((item) => {
    item
      .setTitle("Download")
      .setIcon("download")
      .onClick(() => triggerDownload("download", file.path, file.name));
  });

  // add to "Copy path" submenu
  menu.addItem((item) => {
    item
      .setSection("info.copy")
      .setTitle("as Ignis URL")
      .setIcon("link")
      .onClick(() => copyIgnisUrl(file));
  });
}

function addFolderMenuItems(menu, folder, app) {
  menu.addItem((item) => {
    item
      .setTitle("Download as ZIP")
      .setIcon("download")
      .onClick(() =>
        triggerDownload("download-zip", folder.path, `${folder.name}.zip`),
      );
  });

  menu.addItem((item) => {
    item
      .setTitle("Upload file")
      .setIcon("upload")
      .onClick(() => showFilePicker(app, folder));
  });
}

export { showFilePicker, showFileRename, addFileMenuItems, addFolderMenuItems };
