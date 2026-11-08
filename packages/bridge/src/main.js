import { Plugin, TFile, TFolder } from "obsidian";
import {
  showFilePicker,
  showFileRename,
  addFileMenuItems,
  addFolderMenuItems,
} from "./file-actions.js";
import {
  patchSettingsModal,
  unpatchSettingsModal,
  refreshIgnisSettings,
  reconcilePluginTabs,
} from "./settings/inject.js";
import { watchPluginToggles } from "./settings/plugin-list.js";
import * as pluginRegistry from "./plugin-registry.js";
import { initStatusBar } from "./status-bar.js";
import { initSaveNotice } from "./notices/save-notice.js";
import { installLoadingGate } from "./loading-gate.js";
import { registerCommands } from "./commands/index.js";
import { initInsecureApiNotice } from "./notices/insecure-api-notice.js";
import { initProxyBlockNotice } from "./notices/proxy-block-notice.js";
import { initWriteGiveupNotice } from "./notices/write-giveup-notice.js";
import { initImageRetry } from "./image-retry.js";
import { installReadingLock } from "./reading-lock.js";
import { initCollaboration } from "./collaboration.js";
import { installMobileToolbarPlacement } from "../../server-core/src/mobile-toolbar-preference.js";
import { showPdfPreview } from "./pdf-preview.js";

class IgnisBridgePlugin extends Plugin {
  async onload() {
    console.log("[ignis-bridge] Plugin loaded");

    await pluginRegistry.refresh();
    patchSettingsModal(this);
    this._toolbarPlacementUnsub = installMobileToolbarPlacement(this.app);
    refreshIgnisSettings();
    this._pluginTogglesUnsub = watchPluginToggles();

    this.registerDomEvent(window, "ignis:virtual-plugin-loaded", () => {
      reconcilePluginTabs(this.app.setting);
    });

    this._statusBarUnsub = initStatusBar(this);
    this._saveNoticeUnsub = initSaveNotice();
    this._loadingGateUnsub = installLoadingGate();
    this._insecureApiUnsub = initInsecureApiNotice();
    this._proxyBlockUnsub = initProxyBlockNotice(this.app);
    this._imageRetryUnsub = initImageRetry();
    this._collaborationUnsub = initCollaboration(this);

    const flags = window.__ignis.flags || {};

    if (!flags.suppressWriteFailures) {
      this._writeGiveupUnsub = initWriteGiveupNotice();
    }

    if (flags.forceReadingView) {
      installReadingLock(this);
    }

    this.addRibbonIcon("upload", "Upload file", () => {
      showFilePicker(this.app);
    });
    this.addCommand({
      id: "upload-files-to-vault",
      name: "ファイルをVaultに追加",
      callback: () => showFilePicker(this.app),
    });
    this.addCommand({
      id: "rename-vault-file",
      name: "ファイル名を変更（画像・PDF・ノート）",
      callback: () => showFileRename(this.app, this.app.workspace.getActiveFile?.() || null),
    });
    this.addCommand({
      id: "open-pdf-preview",
      name: "PDFをブラウザー内で表示",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile?.();
        if (!file?.path?.toLowerCase().endsWith(".pdf")) return false;
        if (!checking) showPdfPreview(this.app, file);
        return true;
      },
    });

    registerCommands(this);

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile) {
          addFileMenuItems(menu, file, this.app);
        } else if (file instanceof TFolder) {
          addFolderMenuItems(menu, file, this.app);
        }
      }),
    );
  }

  onunload() {
    if (this._statusBarUnsub) {
      this._statusBarUnsub();
    }

    if (this._saveNoticeUnsub) {
      this._saveNoticeUnsub();
    }

    if (this._loadingGateUnsub) {
      this._loadingGateUnsub();
    }

    if (this._insecureApiUnsub) {
      this._insecureApiUnsub();
    }

    if (this._proxyBlockUnsub) {
      this._proxyBlockUnsub();
    }

    if (this._writeGiveupUnsub) {
      this._writeGiveupUnsub();
    }

    if (this._imageRetryUnsub) {
      this._imageRetryUnsub();
    }

    if (this._collaborationUnsub) {
      this._collaborationUnsub();
    }

    if (this._pluginTogglesUnsub) {
      this._pluginTogglesUnsub();
    }

    unpatchSettingsModal(this);
    this._toolbarPlacementUnsub?.();
    console.log("[ignis-bridge] Plugin unloaded");
  }
}

export default IgnisBridgePlugin;
