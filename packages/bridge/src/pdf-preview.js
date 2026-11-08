import { Modal, Notice } from "obsidian";

function pdfVaultResourceUrl(vaultId, relative) {
  if (typeof vaultId !== "string" || !vaultId ||
      typeof relative !== "string" || !relative.toLowerCase().endsWith(".pdf") ||
      relative.startsWith("/") || relative.includes("\\") ||
      relative.includes("\0")) return null;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." ||
      part.toLowerCase() === ".obsidian")) return null;
  // This is the same-origin resource endpoint used by the Obsidian WebUI for
  // images. It advertises application/pdf and supports HTTP Range requests.
  return "/vault-files/" + encodeURIComponent(vaultId) + "/" +
    parts.map(encodeURIComponent).join("/");
}

class PdfPreviewModal extends Modal {
  constructor(app, file, vaultId) {
    super(app);
    this.file = file;
    this.url = pdfVaultResourceUrl(vaultId, file?.path);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ignis-pdf-preview");
    contentEl.createEl("h3", { text: "PDF · " + this.file.name });
    if (!this.url) {
      contentEl.createEl("p", { text: "PDFのパスを確認してください。" });
      return;
    }
    contentEl.createEl("p", {
      text: "ブラウザー内でPDFを表示します。表示できない場合は下のリンクから直接開いてください。",
      cls: "setting-item-description",
    });
    const frame = contentEl.createEl("iframe", {
      cls: "ignis-pdf-preview-frame",
    });
    frame.src = this.url;
    frame.title = "PDF preview: " + this.file.name;
    frame.setAttribute("loading", "eager");
    frame.style.width = "100%";
    frame.style.height = "72vh";
    frame.style.maxHeight = "850px";
    frame.style.border = "1px solid var(--background-modifier-border)";
    frame.style.borderRadius = "8px";
    const link = contentEl.createEl("a", {
      text: "PDFをブラウザーで開く",
    });
    link.href = this.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "PDFを新しいタブで開く: " + this.file.name);
  }
  onClose() {
    const frame = this.contentEl.querySelector("iframe");
    if (frame) frame.removeAttribute("src");
    this.contentEl.empty();
  }
}

function showPdfPreview(app, file, vaultId = window.__currentVaultId || "") {
  if (!file || !pdfVaultResourceUrl(vaultId, file.path)) {
    new Notice("PDFファイルを選択してください。");
    return null;
  }
  const modal = new PdfPreviewModal(app, file, vaultId);
  modal.open();
  return modal;
}

export { pdfVaultResourceUrl, showPdfPreview };
