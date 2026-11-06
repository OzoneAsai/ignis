// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
    return this;
  };
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
  HTMLElement.prototype.setAttr = function (key, value) {
    this.setAttribute(key, value);
    return this;
  };
});

vi.mock("obsidian", () => {
  class TextInput {
    constructor(parent) {
      this.inputEl = parent.ownerDocument.createElement("input");
      parent.append(this.inputEl);
    }
    setPlaceholder(text) { this.inputEl.placeholder = text; return this; }
    setValue(value) { this.inputEl.value = value; return this; }
    onChange(fn) {
      this.inputEl.addEventListener("input", () => fn(this.inputEl.value));
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
    setDisabled(value) { this.el.disabled = value; return this; }
    onClick(fn) { this.el.addEventListener("click", fn); return this; }
  }
  class Toggle {
    setValue() { return this; }
    onChange() { return this; }
  }
  class Setting {
    constructor(parent) {
      this.el = parent.ownerDocument.createElement("div");
      parent.append(this.el);
    }
    setName(value) {
      const label = this.el.ownerDocument.createElement("strong");
      label.textContent = value;
      this.el.append(label);
      return this;
    }
    setDesc(value) {
      const desc = this.el.ownerDocument.createElement("small");
      desc.textContent = value;
      this.el.append(desc);
      return this;
    }
    addText(fn) { fn(new TextInput(this.el)); return this; }
    addButton(fn) { fn(new Button(this.el)); return this; }
    addToggle(fn) { fn(new Toggle()); return this; }
  }
  class MockModal {
    constructor() { this.contentEl = document.createElement("div"); }
    open() { this.onOpen(); }
    close() { this.closed = true; }
  }
  class MockPlugin {
    constructor() {
      this.app = {
        vault: { on: () => ({}) },
        workspace: {
          on: () => ({}), getActiveFile: () => null
        }
      };
      this.manifest = { id: "ignis-connector" };
      this.commands = [];
      this.ribbon = [];
      this.statusBarCalls = 0;
    }
    async loadData() { return null; }
    registerEditorExtension() {}
    addSettingTab() {}
    registerObsidianProtocolHandler() {}
    registerEvent() {}
    addRibbonIcon(icon, title, callback) {
      this.ribbon.push({icon, title, callback});
      return document.createElement("button");
    }
    addCommand(command) { this.commands.push(command); return command; }
    addStatusBarItem() {
      this.statusBarCalls++;
      return document.createElement("span");
    }
    registerInterval(id) { clearInterval(id); }
    registerDomEvent() {}
  }
  return {
    Plugin: MockPlugin,
    PluginSettingTab: class {
      constructor() { this.containerEl = document.createElement("div"); }
    },
    Setting, Modal: MockModal, Notice: class {}, TFile: class {},
    Platform: { isMobile: true },
    editorInfoField: null, requestUrl: vi.fn()
  };
});
vi.mock("./live", () => ({
  NativeYjs: class {
    extension() { return []; }
    participants() { return []; }
    updateDisplayName() {}
  }
}));
import IgnisConnector, {
  ConnectorSettings, DisplayNameModal, CollaboratorsModal
} from "./main.ts";

const validToken = "ignis_dev_" + "a".repeat(43);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};
function setup() {
  const plugin = {
    settings: {
      serverUrl: "https://mac.example:8451",
      vaultId: "", displayName: "",
      deviceId: ""
    },
    getDisplayName: () => "Obsidian Native",
    openDisplayName: vi.fn(),
    getCurrentStatus: () => "Offline · local Vault retained",
    openSyncIssues: vi.fn(),
    currentParticipants: () => ({path: "demo.md", peers: []}),
    takeIncomingLink: () => "",
    connectionSummary: () => ({ ready: false, vaultId: "", deviceId: "" }),
    connectToServer: vi.fn(),
    saveSettings: vi.fn(),
    syncNow: vi.fn()
  };
  const ui = new ConnectorSettings({}, plugin);
  ui.display();
  const inputs = [...ui.containerEl.querySelectorAll("input")];
  const buttons = [...ui.containerEl.querySelectorAll("button")];
  const connect = buttons.find(b => b.textContent === "Connect and verify");
  const sync = buttons.find(b => b.textContent === "Sync");
  const feedback = ui.containerEl.querySelector(".ignis-connection-feedback");
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { plugin, inputs, connect, sync, feedback, type, containerEl: ui.containerEl };
}

describe("native Obsidian one-button onboarding UI", () => {
  it("registers an iOS ribbon entry and commands without relying on unsupported status bar", async () => {
    const plugin = new IgnisConnector();
    await plugin.onload();
    expect(plugin.statusBarCalls).toBe(0);
    expect(plugin.ribbon).toHaveLength(1);
    expect(plugin.ribbon[0].icon).toBe("users");
    expect(plugin.commands.map(x => x.id)).toContain("show-collaborators");
    expect(plugin.commands.map(x => x.id)).toContain("change-display-name");
    expect(plugin.collaborationRibbon.getAttribute("aria-label"))
      .toContain("Not connected");
    plugin.showStatus("Offline · local Vault retained");
    expect(plugin.collaborationRibbon.getAttribute("aria-label"))
      .toContain("Offline · local Vault retained");
    expect(plugin.getCurrentStatus()).toBe("Offline · local Vault retained");
    plugin.commands.find(x => x.id === "change-display-name").callback();
    // Obsidian's modal is available even when no collaborative note is open.
    expect(plugin.getDisplayName()).toMatch(/^Obsidian /);
  });
  it("keeps a mobile-accessible display-name entry above connection setup", () => {
    const { plugin, containerEl } = setup();
    expect(containerEl.firstElementChild.textContent).toContain("Your display name");
    const button = [...containerEl.querySelectorAll("button")]
      .find(el => el.textContent === "Change name");
    expect(button).not.toBeNull();
    button.click();
    expect(plugin.openDisplayName).toHaveBeenCalledTimes(1);
  });

  it("edits a name in a standalone touch-friendly modal and saves only on request", async () => {
    const { plugin } = setup();
    plugin.setDisplayName = vi.fn(async () => {});
    const modal = new DisplayNameModal({}, plugin);
    modal.open();
    const input = modal.contentEl.querySelector("input");
    expect(input.maxLength).toBe(40);
    expect(input.getAttribute("aria-label")).toBe("Your Ignis display name");
    input.value = "Yui";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(plugin.setDisplayName).not.toHaveBeenCalled();
    const save = [...modal.contentEl.querySelectorAll("button")]
      .find(element => element.textContent === "Save name");
    save.click();
    await flush();
    expect(plugin.setDisplayName).toHaveBeenCalledWith("Yui");
    expect(modal.closed).toBe(true);
  });

  it("provides a collaborators modal with an always-available name editor", () => {
    const { plugin } = setup();
    plugin.currentParticipants = () => ({ path: "demo.md", peers: [
      { id: "peer-a", name: "Alice", color: "#59baf2" }
    ] });
    plugin.jumpToParticipant = vi.fn(() => true);
    const modal = new CollaboratorsModal({}, plugin);
    modal.open();
    expect(modal.contentEl.textContent).toContain("Offline · local Vault retained");
    const review = [...modal.contentEl.querySelectorAll("button")]
      .find(element => element.textContent === "Review issues");
    review.click();
    expect(plugin.openSyncIssues).toHaveBeenCalledOnce();
    const change = [...modal.contentEl.querySelectorAll("button")]
      .find(element => element.textContent === "Change name");
    change.click();
    expect(plugin.openDisplayName).toHaveBeenCalledOnce();
    expect(modal.closed).toBe(true);
  });

  it("persists sanitized names and broadcasts a live identity without reconnecting", async () => {
    const plugin = new IgnisConnector();
    plugin.settings = { displayName: "", deviceId: "abc123456" };
    plugin.persistSettings = vi.fn(async () => {});
    plugin.live = { updateDisplayName: vi.fn() };
    expect(plugin.getDisplayName()).toBe("Obsidian abc123");
    await plugin.setDisplayName("  Yui\u202e 👋  ");
    expect(plugin.settings.displayName).toBe("Yui 👋");
    expect(plugin.getDisplayName()).toBe("Yui 👋");
    expect(plugin.persistSettings).toHaveBeenCalledOnce();
    expect(plugin.live.updateDisplayName).toHaveBeenCalledOnce();
    await plugin.setDisplayName("Yui 👋");
    expect(plugin.persistSettings).toHaveBeenCalledOnce();
  });
  it("accepts a single pasted invite without requiring token or Vault typing", async () => {
    const { plugin, inputs, type, connect, sync } = setup();
    type(inputs[0], "https://mac.example:8451/join/IOSLab");
    expect(inputs[1].value).toBe("IOSLab");
    plugin.connectToServer.mockResolvedValueOnce({
      ok: true, message: "Connected through Tailscale to IOSLab."
    });
    connect.click();
    await flush();
    expect(plugin.connectToServer).toHaveBeenCalledWith({
      serverUrl: "https://mac.example:8451/join/IOSLab",
      vaultId: "IOSLab", token: ""
    });
    expect(sync.disabled).toBe(false);
  });
  it("offers a Vault chooser rather than requiring users to copy internal IDs", async () => {
    const { plugin, inputs, type, connect, feedback, containerEl } = setup();
    type(inputs[0], "https://mac.example:8451");
    plugin.connectToServer.mockResolvedValueOnce({
      ok: false, message: "Choose the Vault you want to connect to.",
      availableVaults: ["Personal", "Team"]
    });
    connect.click();
    await flush();
    expect(feedback.textContent).toMatch(/Choose the Vault/);
    const picker = containerEl.querySelector(".ignis-vault-picker select");
    expect(picker).not.toBeNull();
    expect(picker.options).toHaveLength(2);
    picker.value = "Team";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    plugin.connectToServer.mockResolvedValueOnce({
      ok: true, message: "Connected through Tailscale to Team."
    });
    connect.click();
    await flush();
    expect(plugin.connectToServer).toHaveBeenLastCalledWith({
      serverUrl: "https://mac.example:8451",
      vaultId: "Team", token: ""
    });
  });
  it("does not send anything or blank a pasted token before Connect is tapped", async () => {
    const { plugin, inputs, type, connect } = setup();
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(inputs[2].type).toBe("password");
    type(inputs[2], validToken);
    await flush();
    expect(inputs[2].value).toBe(validToken);
    expect(plugin.connectToServer).not.toHaveBeenCalled();
    expect(connect.disabled).toBe(false);
  });

  it("keeps all values after failure and enables Sync only after success", async () => {
    const { plugin, inputs, type, connect, sync, feedback } = setup();
    type(inputs[0], "https://mac.example:8451");
    type(inputs[1], "IOSLab");
    type(inputs[2], validToken);
    expect(sync.disabled).toBe(true);
    plugin.connectToServer.mockResolvedValueOnce({
      ok: false, message: "Sync API not found. Check the server address."
    });
    connect.click();
    await flush();
    expect(inputs[0].value).toBe("https://mac.example:8451");
    expect(inputs[1].value).toBe("IOSLab");
    expect(inputs[2].value).toBe(validToken);
    expect(feedback.textContent).toMatch(/API not found/);
    expect(sync.disabled).toBe(true);
    expect(plugin.connectToServer).toHaveBeenNthCalledWith(1, {
      serverUrl: "https://mac.example:8451",
      vaultId: "IOSLab",
      token: validToken
    });
    plugin.connectToServer.mockResolvedValueOnce({
      ok: true, message: "Connected to IOSLab as iPhone."
    });
    connect.click();
    await flush();
    expect(inputs[2].value).toBe("");
    expect(inputs[1].value).toBe("IOSLab");
    expect(sync.disabled).toBe(false);
    expect(feedback.textContent).toMatch(/Connected to IOSLab/);
  });

  it("never triggers network requests while changing server or Vault", async () => {
    const { plugin, inputs, type } = setup();
    for (const value of ["I", "IO", "IOSLab"]) type(inputs[1], value);
    type(inputs[0], "https://another.example:9443");
    await flush();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.connectToServer).not.toHaveBeenCalled();
    expect(plugin.settings.vaultId).toBe("");
  });
});
