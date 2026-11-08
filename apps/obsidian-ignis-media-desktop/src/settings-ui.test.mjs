// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deriveMediaHealth } from "./health.ts";
import { FileSystemAdapter } from "obsidian";
import { inspectStorageCapacity } from "../../../packages/syncthing-control/src/storage-capacity";

vi.mock("../../../packages/syncthing-control/src/storage-capacity", () => ({
  inspectStorageCapacity: vi.fn(async () => ({
    availableBytes: 8 * 1024 ** 3,
    reserveBytes: 2 * 1024 ** 3,
    constrained: false,
  })),
}));

beforeAll(() => {
  HTMLElement.prototype.empty = function () { this.replaceChildren(); return this; };
  HTMLElement.prototype.createEl = function (tag, attrs = {}) {
    const node = this.ownerDocument.createElement(tag);
    if ("text" in attrs) node.textContent = attrs.text;
    if ("cls" in attrs) node.className = attrs.cls;
    this.append(node);
    return node;
  };
  HTMLElement.prototype.createDiv = function (attrs = {}) {
    return this.createEl("div", attrs);
  };
  HTMLElement.prototype.setText = function (value) {
    this.textContent = value;
    return this;
  };
});

vi.mock("obsidian", () => {
  class TextInput {
    constructor(parent) {
      this.inputEl = parent.ownerDocument.createElement("input");
      parent.append(this.inputEl);
    }
    setPlaceholder(value) { this.inputEl.placeholder = value; return this; }
    setValue(value) { this.inputEl.value = value; return this; }
    onChange(callback) {
      this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
      return this;
    }
  }
  class Button {
    constructor(parent) {
      this.el = parent.ownerDocument.createElement("button");
      parent.append(this.el);
    }
    setButtonText(text) { this.el.textContent = text; return this; }
    setCta() { return this; }
    setWarning() { return this; }
    setDisabled(value) { this.el.disabled = value; return this; }
    onClick(callback) { this.el.addEventListener("click", callback); return this; }
  }
  class Toggle {
    constructor(parent) {
      this.el = parent.ownerDocument.createElement("input");
      this.el.type = "checkbox";
      parent.append(this.el);
    }
    setValue(value) { this.el.checked = value; return this; }
    onChange(callback) {
      this.el.addEventListener("change", () => callback(this.el.checked));
      return this;
    }
  }
  class Setting {
    constructor(parent) {
      this.el = parent.ownerDocument.createElement("div");
      parent.append(this.el);
    }
    setName(text) {
      const label = this.el.ownerDocument.createElement("strong");
      label.textContent = text;
      this.el.append(label);
      return this;
    }
    setDesc(text) {
      const detail = this.el.ownerDocument.createElement("small");
      detail.textContent = text;
      this.el.append(detail);
      return this;
    }
    addButton(callback) { callback(new Button(this.el)); return this; }
    addText(callback) { callback(new TextInput(this.el)); return this; }
    addToggle(callback) { callback(new Toggle(this.el)); return this; }
  }
  class Modal {
    constructor(app) { this.app = app; this.contentEl = document.createElement("div"); }
    open() { this.onOpen(); }
    close() { this.onClose(); }
  }
  class PluginSettingTab {
    constructor(app) {
      this.app = app;
      this.containerEl = document.createElement("div");
    }
    hide() {}
  }
  return {
    App: class {},
    FileSystemAdapter: class {},
    Modal,
    Notice: class {},
    Platform: { isDesktopApp: true },
    Plugin: class {},
    PluginSettingTab,
    Setting,
  };
});

import { IgnisMediaSettings, ConfirmStopModal } from "./main.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function example(status = "running") {
  const raw = status === "running"
    ? {
        state: "running", peers: [{ connected: true, paused: false }],
        folders: [{ paused: false }], completion: 100, needBytes: 0,
        remoteNeedBytes: 0, remoteVerified: true,
      }
    : { state: status };
  return {
    status: { state: status === "running" ? "running" : "unmanaged",
      deviceId: status === "running" ? "TEST-DEVICE-ID" : undefined },
    health: deriveMediaHealth(raw),
    peers: status === "running" ? [{
      deviceId: "TEST-PEER", name: "Mac-IGNIS-Test",
      connected: true, paused: false,
    }] : [],
    folders: status === "running" ? [{
      id: "test-folder", label: "Media Test", paused: false,
    }] : [],
  };
}

function createTab(status = "running") {
  const report = example(status);
  const plugin = {
    mediaSettings: {
      executablePath: "C:\\tools\\syncthing.exe",
      homeDir: "C:\\Users\\Test\\AppData\\Local\\Ignis\\Syncthing-Mobile",
      guiPort: 8386, autoStart: false, stopOnUnload: false,
    },
    refresh: vi.fn(async () => report),
    perform: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
    controller: {
      registerPeer: vi.fn(async () => ({ deviceId: "TEST-PEER", alreadyPresent: false })),
      createPilotShare: vi.fn(async () => ({ id: "ignis-media-pilot", path: "/tmp/IGNIS-Media-Pilot" })),
      previewPairingCard: vi.fn((card) => {
        if (card !== "TEST-VALID-PAIRING-CARD") throw new Error("Invalid card");
        return {
          version: 1,
          deviceId: "TEST-PEER", name: "Mac-IGNIS-Test",
          address: "tcp://100.75.232.0:22020",
          folderId: "ignis-pilot-card", expiresAt: Date.now() + 1800000,
        };
      }),
      importPairingCard: vi.fn(async () => ({
        peer: {
          deviceId: "TEST-PEER", name: "Mac-IGNIS-Test",
          address: "tcp://100.75.232.0:22020", folderId: "ignis-pilot-card",
        },
        alreadyPresent: false,
      })),
      makeLocalPairingCard: vi.fn(async () => "TEST-LOCAL-PAIRING-CARD"),
    },
  };
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => "/tmp/IGNIS-Test-Vault";
  const tab = new IgnisMediaSettings({ vault: { adapter } }, plugin);
  tab.display();
  const findButton = (text) => [...tab.containerEl.querySelectorAll("button")]
    .find((button) => button.textContent === text);
  return { tab, plugin, findButton };
}

describe("IGNIS Media Desktop accessible settings", () => {
  it("delegates PDF bypass choices to the common Connector without starting Syncthing", async () => {
    const { tab, plugin } = createTab();
    const connector = {
      settings: { deviceContentScope: "markdown-only" },
      getServerMediaBypassExtensions: vi.fn(() => ["pdf", "docx"]),
      getDeviceMediaBypassExtensions: vi.fn(() => []),
      setDeviceMediaBypassExtensions: vi.fn(async () =>
        ({ ok: true, message: "IGNIS Sync bypass saved" })),
      recheckSharingScope: vi.fn(async () => ({
        ok: true, message: "Server permits PDF",
      })),
    };
    tab.app.plugins = { plugins: { "ignis-connector": connector } };
    tab.display();
    try {
      const bypass = tab.containerEl.querySelector(".ignis-media-bypass-settings");
      expect(bypass.querySelector("summary").textContent)
        .toBe("PDFs and media Bypass");
      const pdf = bypass.querySelector("input[type=checkbox]");
      pdf.checked = true;
      pdf.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      expect(connector.setDeviceMediaBypassExtensions).toHaveBeenCalledWith(["pdf"]);
      expect(plugin.perform).not.toHaveBeenCalled();
      expect(bypass.textContent).toContain("IGNIS Sync bypass saved");
    } finally { tab.hide(); }
  });
  it("shows peer, folder and verified transfer status without exposing an API key", async () => {
    const { tab, findButton } = createTab();
    try {
      await flush();
      const content = tab.containerEl.textContent;
      expect(content).toContain("ローカル同期済み");
      expect(content).toContain("Mac-IGNIS-Test（接続中）");
      expect(content).toContain("Media Test（共有中）");
      expect(content).toContain("未転送: 0 B");
      expect(findButton("IDをコピー")).toBeDefined();
      expect(findButton("起動・再接続").disabled).toBe(true);
      expect(findButton("停止").disabled).toBe(false);
      expect(content).not.toContain("<apikey>");
    } finally {
      tab.hide();
    }
  });

  it("keeps invalid intermediate text in a draft until explicit Save", async () => {
    const { tab, plugin, findButton } = createTab();
    try {
      await flush();
      const input = tab.containerEl.querySelector(".ignis-media-advanced input[type=text], .ignis-media-advanced input:not([type])");
      input.value = "C:\\a-not-yet-finished-path";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(plugin.saveSettings).not.toHaveBeenCalled();
      expect(tab.containerEl.textContent).toContain("未保存の変更があります");
      findButton("保存").click();
      await flush();
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
      expect(plugin.saveSettings.mock.calls[0][0].executablePath)
        .toBe("C:\\a-not-yet-finished-path");
    } finally {
      tab.hide();
    }
  });

  it("provides a guided onboarding path with an optional advanced settings drawer", async () => {
    const { tab, findButton } = createTab();
    try {
      await flush();
      expect(tab.containerEl.textContent).toContain("初回セットアップ");
      expect(findButton("自動検出")).toBeDefined();
      expect(findButton("公式ダウンロード")).toBeDefined();
      expect(findButton("設定を保存して起動")).toBeDefined();
      expect(findButton("Macを追加")).toBeDefined();
      expect(findButton("空のフォルダを共有")).toBeDefined();
      const advanced = tab.containerEl.querySelector("details.ignis-media-advanced");
      expect(advanced.open).toBe(false);
      expect(tab.containerEl.querySelector(".ignis-media-onboarding")).toBeTruthy();
      expect(tab.containerEl.querySelector(".ignis-media-onboarding").open).toBe(false);
    } finally { tab.hide(); }
  });

  it("registers the Mac only after an explicit onboarding action", async () => {
    const { tab, plugin, findButton } = createTab();
    try {
      await flush();
      const fields = [...tab.containerEl.querySelectorAll(".ignis-media-manual-pairing input")];
      expect(fields).toHaveLength(3);
      for (const [input, value] of fields.map((input, index) => [input, [
        "Mac on Tailnet", "VHRCSES-MPW4QO5-OKXSVDU-P2ZVNVE-K4T6WUS-3HCULBP-SYEQ4AG-KEIOXAR",
        "100.75.232.0",
      ][index]])) {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      expect(plugin.controller.registerPeer).not.toHaveBeenCalled();
      findButton("Macを追加").click();
      await flush();
      expect(plugin.controller.registerPeer).toHaveBeenCalledWith({
        name: "Mac on Tailnet",
        deviceId: "VHRCSES-MPW4QO5-OKXSVDU-P2ZVNVE-K4T6WUS-3HCULBP-SYEQ4AG-KEIOXAR",
        address: "100.75.232.0",
      });
      expect(tab.containerEl.textContent).toContain("Macを登録しました");
    } finally { tab.hide(); }
  });

  it("previews a connection card before explicitly registering and copying its folder ID", async () => {
    const { tab, plugin, findButton } = createTab();
    try {
      await flush();
      const textarea = tab.containerEl.querySelector("textarea[aria-label='Macから受け取った接続カード']");
      textarea.value = "TEST-VALID-PAIRING-CARD";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      expect(findButton("確認してMacを追加").disabled).toBe(true);
      findButton("内容を確認").click();
      await flush();
      expect(tab.containerEl.textContent).toContain("tcp://100.75.232.0:22020");
      expect(plugin.controller.importPairingCard).not.toHaveBeenCalled();
      expect(findButton("確認してMacを追加").disabled).toBe(false);
      findButton("確認してMacを追加").click();
      await flush();
      expect(plugin.controller.importPairingCard).toHaveBeenCalledWith("TEST-VALID-PAIRING-CARD");
      const folderIdInput = tab.containerEl.querySelector(".ignis-media-share-step input");
      expect(folderIdInput.value).toBe("ignis-pilot-card");
      expect(tab.containerEl.textContent).toContain("Macを登録しました");
    } finally { tab.hide(); }
  });

  it("rejects a changed card between preview and confirmation", async () => {
    const { tab, plugin, findButton } = createTab();
    try {
      await flush();
      const textarea = tab.containerEl.querySelector("textarea[aria-label='Macから受け取った接続カード']");
      textarea.value = "TEST-VALID-PAIRING-CARD";
      findButton("内容を確認").click();
      await flush();
      textarea.value = "CHANGED-CARD";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      expect(findButton("確認してMacを追加").disabled).toBe(true);
      findButton("内容を確認").click();
      await flush();
      expect(tab.containerEl.textContent).toContain("壊れているか期限切れ");
      expect(plugin.controller.importPairingCard).not.toHaveBeenCalled();
    } finally { tab.hide(); }
  });

  it("offers a local pairing card that can be copied without starting any share", async () => {
    const { tab, plugin, findButton } = createTab();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText },
    });
    try {
      await flush();
      findButton("カードをコピー").click();
      await flush();
      expect(plugin.controller.makeLocalPairingCard).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("TEST-LOCAL-PAIRING-CARD");
      expect(plugin.controller.createPilotShare).not.toHaveBeenCalled();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete navigator.clipboard;
      tab.hide();
    }
  });

  it("creates a pilot folder only with explicit confirmation and a selected peer", async () => {
    const { tab, plugin, findButton } = createTab();
    try {
      await flush();
      const button = findButton("空のフォルダを共有");
      expect(button.disabled).toBe(false);
      button.click();
      await flush();
      expect(plugin.controller.createPilotShare).toHaveBeenCalledTimes(1);
      const request = plugin.controller.createPilotShare.mock.calls[0][0];
      expect(request).toMatchObject({
        folderId: "ignis-media-pilot", peerDeviceId: "TEST-PEER",
        vaultPath: "/tmp/IGNIS-Test-Vault",
      });
      expect(request.folderPath).toContain("IGNIS-Media-Pilot");
      expect(tab.containerEl.textContent).toContain("検証フォルダを登録しました");
    } finally { tab.hide(); }
  });

  it("prevents sharing an empty pilot folder when this device has insufficient free space", async () => {
    const { tab, plugin, findButton } = createTab();
    vi.mocked(inspectStorageCapacity).mockResolvedValueOnce({
      availableBytes: 440 * 1024 ** 2,
      reserveBytes: 2 * 1024 ** 3,
      constrained: true,
    });
    try {
      await flush();
      findButton("空のフォルダを共有").click();
      await flush();
      expect(plugin.controller.createPilotShare).not.toHaveBeenCalled();
      expect(tab.containerEl.textContent).toContain("2 GiB");
      expect(tab.containerEl.textContent).toContain("同期は開始しません");
    } finally { tab.hide(); }
  });

  it("disables unsafe service operations when the local API cannot be identified", async () => {
    const { tab, findButton } = createTab("unmanaged");
    try {
      await flush();
      expect(tab.containerEl.textContent).toContain("確認できないサービス");
      expect(findButton("起動・再接続").disabled).toBe(true);
      expect(findButton("停止").disabled).toBe(true);
      expect(tab.containerEl.querySelector(".ignis-media-pairing").hidden).toBe(true);
      expect(tab.containerEl.querySelector(".ignis-media-share-step").hidden).toBe(true);
    } finally {
      tab.hide();
    }
  });
});

describe("Syncthing stop confirmation", () => {
  it("displays real pending volume and does not stop on cancel", async () => {
    const report = example();
    report.health.needBytes = 2 * 1024 * 1024;
    const modal = new ConfirmStopModal({}, report);
    const decision = modal.confirm();
    expect(modal.contentEl.textContent).toContain("2.0 MiB");
    const cancel = [...modal.contentEl.querySelectorAll("button")]
      .find((button) => button.textContent === "キャンセル");
    cancel.click();
    expect(await decision).toBe(false);
  });

  it("requires an affirmative stop action", async () => {
    const modal = new ConfirmStopModal({}, example());
    const decision = modal.confirm();
    const accept = [...modal.contentEl.querySelectorAll("button")]
      .find((button) => button.textContent === "停止する");
    accept.click();
    expect(await decision).toBe(true);
  });
});
