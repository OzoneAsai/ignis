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
  return {
    Plugin: class {},
    PluginSettingTab: class {
      constructor() { this.containerEl = document.createElement("div"); }
    },
    Setting, Modal: class {}, Notice: class {}, TFile: class {},
    editorInfoField: null, requestUrl: vi.fn()
  };
});
vi.mock("./live", () => ({ NativeYjs: class {} }));
import { ConnectorSettings } from "./main.ts";

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
      vaultId: "",
      deviceId: ""
    },
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
  return { plugin, inputs, connect, sync, feedback, type };
}

describe("native Obsidian one-button onboarding UI", () => {
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
