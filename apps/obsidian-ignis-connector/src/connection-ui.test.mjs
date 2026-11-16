// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  // Node 25 may expose an incomplete localStorage object without jsdom's
  // Storage methods. Provide the Obsidian preference as a deterministic stub.
  vi.stubGlobal("localStorage", { getItem: key => key === "language" ? "ja" : null });
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
    constructor(parent) {
      this.el = parent.ownerDocument.createElement("button");
      this.el.type = "button";
      this.el.setAttribute("role", "switch");
      this.el.setAttribute("aria-label", "Keep attachments on this device");
      parent.append(this.el);
      this.el.addEventListener("click", () => {
        this.setValue(!this.value);
        this.change?.(this.value);
      });
    }
    setValue(value) {
      this.value = value;
      this.el.setAttribute("aria-checked", String(value));
      return this;
    }
    onChange(fn) { this.change = fn; return this; }
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
    addToggle(fn) { fn(new Toggle(this.el)); return this; }
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
      constructor(app) {
        this.app = app;
        this.containerEl = document.createElement("div");
      }
    },
    Setting, Modal: MockModal, Notice: class {}, TFile: class {},
    setIcon: (element, icon) => { element.dataset.icon = icon; },
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
  ConnectorSettings, DisplayNameModal, CollaboratorsModal, UndoReviewModal
} from "./main.ts";
import { TFile } from "obsidian";

const validToken = "ignis_dev_" + "a".repeat(43);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};
function setup({ ready = false } = {}) {
  const plugin = {
    settings: {
      serverUrl: "https://mac.example:8451",
      vaultId: "", displayName: "",
      deviceId: "", contentScope: "all",
      deviceContentScope: "follow-server",
      serverMediaBypassExtensions: [], deviceMediaBypassExtensions: [],
    },
    getDisplayName: () => "Obsidian Native",
    openDisplayName: vi.fn(),
    getCurrentStatus: () => "Offline · local Vault retained",
    openSyncIssues: vi.fn(),
    journalRecoveryInfo: () => null,
    recheckJournal: vi.fn(async()=>({ok:true,
      message:"Server history verified. Synchronization is resuming."})),
    getUndoReviews: () => [],
    openUndoReview: vi.fn(),
    dismissUndoReview: vi.fn(() => true),
    currentParticipants: () => ({path: "demo.md", peers: []}),
    takeIncomingLink: () => "",
    connectionSummary: () => ({ ready, vaultId: ready ? "MarkdownLab" : "",
      deviceId: ready ? "device-sls" : "" }),
    connectToServer: vi.fn(),
    saveSettings: vi.fn(),
    syncNow: vi.fn(),
    getSharingDetails: vi.fn(() => ({
      sharedFiles: 3, localOnlyFiles: 2, pendingOperations: 0,
      localOnlyBytes: 5120, blockedQueued: 0, oversizedFiles: 0,
    })),
    getServerMediaBypassExtensions: () => plugin.settings.serverMediaBypassExtensions,
    getDeviceMediaBypassExtensions: () => plugin.settings.deviceMediaBypassExtensions,
    setDeviceMediaBypassExtensions: vi.fn(async (value) => {
      plugin.settings.deviceMediaBypassExtensions = [...value];
      return { ok: true, message: "Media bypass selection saved" };
    }),
    setDeviceContentScope: vi.fn(async (value) => {
      plugin.settings.deviceContentScope = value;
      return { ok: true, message: "Device preference saved" };
    }),
    recheckSharingScope: vi.fn(async () => ({
      ok: true, message: "Server: Markdown only.",
    })),
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
  it("schedules a newly created note immediately without waiting for another modify event", async () => {
    const plugin = new IgnisConnector();
    const listeners = new Map();
    plugin.app.vault.on = (name, callback) => {
      listeners.set(name, callback);
      return { name };
    };
    await plugin.onload();
    plugin.schedule = vi.fn();
    const note = new TFile();
    note.path = "Notes/from-other-site.md";
    listeners.get("create")(note);
    expect(plugin.schedule).toHaveBeenCalledOnce();
    plugin.quiet.add(note.path);
    listeners.get("create")(note);
    expect(plugin.schedule).toHaveBeenCalledOnce();
  });
  it("updates live file eligibility on Vault events and detaches after settings close", async () => {
    const { plugin } = setup();
    plugin.getSharingDetails.mockClear();
    const listeners = new Map();
    const vault = {
      on: vi.fn((event, callback) => {
        const ref = { event, callback };
        listeners.set(event, ref);
        return ref;
      }),
      offref: vi.fn((ref) => {
        if (listeners.get(ref.event) === ref) listeners.delete(ref.event);
      }),
    };
    const tab = new ConnectorSettings({ vault }, plugin);
    tab.display();
    expect(listeners.size).toBe(4);
    const summary = tab.containerEl.querySelector(".ignis-sharing-summary");
    expect(summary.textContent).toContain("3 file(s) eligible");
    plugin.getSharingDetails.mockReturnValue({
      sharedFiles: 4, localOnlyFiles: 1, pendingOperations: 0,
      localOnlyBytes: 4096, blockedQueued: 0, oversizedFiles: 1,
    });
    for (const event of ["create", "modify", "rename"]) {
      listeners.get(event).callback();
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(plugin.getSharingDetails).toHaveBeenCalledTimes(2);
    expect(summary.textContent).toContain("4 file(s) eligible");
    expect(summary.textContent).toContain("exceed the 4 MiB");
    tab.hide();
    expect(vault.offref).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
    plugin.getSharingDetails.mockReturnValue({
      sharedFiles: 5, localOnlyFiles: 0, pendingOperations: 0,
      localOnlyBytes: 0, blockedQueued: 0, oversizedFiles: 0,
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(summary.textContent).toContain("4 file(s) eligible");
  });

  it("offers PDF/media bypass in the same mobile-compatible Connector UI", () => {
    const { containerEl } = setup();
    const region = containerEl.querySelector(".ignis-media-bypass-details");
    expect(region.querySelector("summary").textContent)
      .toBe("PDFs and media Bypass");
    expect(region.textContent).toContain("PowerPoint");
    expect(region.textContent).toContain("4 MiB");
  });
  it("explains how to recover an existing device-token connection after a restart", () => {
    const { plugin, containerEl } = setup();
    plugin.settings.vaultId = "SLS-TextClone";
    plugin.settings.serverUrl = "http://127.0.0.1:3196";
    plugin.settings.authMode = "device";
    plugin.connectionSummary = () => ({
      ready: false, vaultId: "SLS-TextClone", deviceId: "test-device",
    });
    const tab = new ConnectorSettings({}, plugin);
    tab.display();
    const message = tab.containerEl.querySelector(".ignis-connection-feedback").textContent;
    expect(message).toContain("needs its verified token again");
    expect(message).toContain("local notes are retained");
    expect(containerEl).toBeTruthy();
  });
  it("shows a meaningful local media switch with file counts and accessible feedback", async () => {
    const { containerEl, plugin } = setup();
    expect(containerEl.querySelector(".ignis-sharing-summary").textContent)
      .toContain("3 file(s) eligible");
    expect(containerEl.querySelector(".ignis-sharing-summary").textContent)
      .toContain("5.0 KiB");
    expect(containerEl.textContent).toContain("Keep attachments on this device");
    const switchEl = containerEl.querySelector('[role="switch"]');
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    switchEl.click();
    await flush();
    expect(plugin.setDeviceContentScope)
      .toHaveBeenCalledWith("markdown-only");
    expect(switchEl.getAttribute("aria-checked")).toBe("true");
    expect(containerEl.querySelector(".ignis-sharing-feedback").textContent)
      .toContain("Device preference saved");
    const review = [...containerEl.querySelectorAll("button")]
      .find((button) => button.textContent === "Review");
    review.click();
    expect(plugin.openSyncIssues).toHaveBeenCalledOnce();
  });

  it("reverts a rejected local preference without silently changing its UI state", async () => {
    const { containerEl, plugin } = setup();
    plugin.setDeviceContentScope.mockResolvedValueOnce({
      ok: false, message: "2 unsent media operations require review",
    });
    const switchEl = containerEl.querySelector('[role="switch"]');
    switchEl.click();
    await flush();
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    expect(containerEl.querySelector(".ignis-sharing-feedback").textContent)
      .toContain("unsent media");
  });

  it("rechecks server scope after a verified connection without asking for a token", async () => {
    const { containerEl, plugin } = setup({ ready: true });
    const check = [...containerEl.querySelectorAll("button")]
      .find((button) => button.textContent === "Recheck");
    expect(check).toBeTruthy();
    expect(check.disabled).toBe(false);
    check.click();
    await flush();
    expect(plugin.recheckSharingScope).toHaveBeenCalledOnce();
    expect(containerEl.querySelector(".ignis-sharing-feedback").textContent)
      .toContain("Server: Markdown only");
    expect(check.disabled).toBe(false);
  });
  it("registers an iOS ribbon entry and commands without relying on unsupported status bar", async () => {
    document.body.innerHTML = '<nav class="mobile-navbar"><div class="mobile-navbar-actions"><button>戻る</button></div></nav>';
    const plugin = new IgnisConnector();
    await plugin.onload();
    expect(plugin.statusBarCalls).toBe(0);
    expect(plugin.ribbon).toHaveLength(2);
    expect(plugin.ribbon[0].icon).toBe("users");
    expect(plugin.ribbon[1].icon).toBe("upload");
    expect(plugin.commands.map(x => x.id)).toContain("show-collaborators");
    expect(plugin.commands.map(x => x.id)).toContain("change-display-name");
    expect(plugin.commands.map(x => x.id)).toContain("import-files-to-vault");
    expect(plugin.collaborationRibbon.getAttribute("aria-label"))
      .toContain("Not connected");
    plugin.showStatus("Offline · local Vault retained");
    expect(plugin.collaborationRibbon.getAttribute("aria-label"))
      .toContain("Offline · local Vault retained");
    expect(plugin.getCurrentStatus()).toBe("Offline · local Vault retained");
    const action = plugin.mobileActions;
    expect(action.closest(".mobile-navbar-actions")).not.toBeNull();
    expect(action.querySelectorAll("button")).toHaveLength(1);
    expect(document.querySelectorAll(".ignis-native-mobile-actions")).toHaveLength(0);
    expect(action.dataset.connection).toBe("offline");
    expect(action.querySelector("button").dataset.icon).toBe("flame");
    expect(document.querySelector(".mobile-navbar-actions").textContent).toContain("戻る");
    action.querySelector("button").click();
    expect(plugin.mobileMenu.contentEl.textContent).toContain("ファイル追加");
    expect(plugin.mobileMenu.contentEl.textContent).toContain("参加者・表示名");
    plugin.commands.find(x => x.id === "change-display-name").callback();
    // Obsidian's modal is available even when no collaborative note is open.
    expect(plugin.getDisplayName()).toMatch(/^Obsidian /);
  });
  it("imports a native iOS File selection without clobbering existing Vault data", async () => {
    const plugin = new IgnisConnector();
    await plugin.onload();
    const paths = new Set(["photo.heic"]);
    plugin.app.vault.getRoot = () => ({ path: "/" });
    plugin.app.vault.getAbstractFileByPath = path => paths.has(path) ? {} : null;
    plugin.app.vault.createBinary = vi.fn(async path => {
      paths.add(path);
      return { path };
    });
    plugin.mobileConnection.click();
    const upload = [...plugin.mobileMenu.contentEl.querySelectorAll("button")]
      .find(button => button.textContent === "ファイルを選ぶ");
    upload.click();
    const input = document.querySelector(".ignis-native-upload-input");
    expect(input?.type).toBe("file");
    expect(input?.multiple).toBe(true);
    expect(input.style.display).not.toBe("none");
    const bytes = new Uint8Array([4, 2, 1]);
    const picked = { name: "photo.heic", size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer };
    Object.defineProperty(input, "files", { configurable: true, value: [picked] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(plugin.app.vault.createBinary).toHaveBeenCalledWith(
      "photo (1).heic", bytes.buffer
    );
    expect(document.querySelector(".ignis-native-upload-input")).toBeNull();
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
  it("provides a non-destructive Undo review with the exact invisible newlines", async () => {
    const { plugin } = setup();
    const entry = {
      path: "FAQ/Questions.md", documentId: "a-generation", operation: "undo",
      deleted: "\n\n", reason: "boundary-removed", context: "Q: changed?A: answer"
    };
    plugin.getUndoReviews = vi.fn(() => [entry]);
    const collaborators = new CollaboratorsModal({}, plugin);
    collaborators.open();
    const reviewButton = [...collaborators.contentEl.querySelectorAll("button")]
      .find(button => button.textContent === "内容を確認");
    expect(reviewButton).toBeDefined();
    reviewButton.click();
    expect(plugin.openUndoReview).toHaveBeenCalledOnce();
    const modal = new UndoReviewModal({}, plugin);
    modal.open();
    const original = modal.contentEl.querySelector("textarea");
    expect(original.value).toBe("\n\n");
    expect(original.readOnly).toBe(true);
    expect(modal.contentEl.textContent).toContain("改行 2 個");
    expect(modal.contentEl.textContent).toContain("FAQ/Questions.md");
    expect(modal.contentEl.textContent).toContain("Q: changed?A: answer");
    // Merely opening the review must not alter a native editor.
    expect(plugin.dismissUndoReview).not.toHaveBeenCalled();
    const dismiss = [...modal.contentEl.querySelectorAll("button")]
      .find(button => button.textContent === "確認済みにする");
    dismiss.click();
    expect(plugin.dismissUndoReview).toHaveBeenCalledWith(entry);
  });
  it("persists review details locally, keeps them out of a different Vault, and allows explicit dismissal", async () => {
    const entry = {
      path:"FAQ/Collaboration.md",documentId:"first-generation",
      operation:"undo",deleted:"\n\n",reason:"boundary-removed",
      context:"Question?Answer"
    };
    const connector = new IgnisConnector();
    connector.settings = {scope:"https://one.example|VaultA",undoReviews:[]};
    connector.live = {
      pendingUndoReviews:vi.fn(() => [entry]),
      dismissUndoReview:vi.fn(() => true)
    };
    const write = vi.fn(async () => {});
    connector.saveData = write;
    connector.rememberUndoReviews();
    await flush();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0].undoReviews).toMatchObject([
      { ...entry, scope:"https://one.example|VaultA" }
    ]);
    connector.live.pendingUndoReviews = () => [];
    expect(connector.getUndoReviews()).toMatchObject([entry]);
    connector.settings.scope = "https://two.example|VaultB";
    expect(connector.getUndoReviews()).toEqual([]);
    connector.settings.scope = "https://one.example|VaultA";
    expect(connector.dismissUndoReview(entry)).toBe(true);
    await flush();
    expect(connector.getUndoReviews()).toEqual([]);
    expect(connector.live.dismissUndoReview).toHaveBeenCalledWith(
      entry.path,entry.documentId);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("shows a held Undo review without falsely replacing the last confirmed Sync status", () => {
    const connector = new IgnisConnector();
    connector.settings = {scope:"v|lab",undoReviews:[{
      path:"a.md",documentId:"G",operation:"undo",
      deleted:"\n\n",reason:"boundary-removed",context:"A",scope:"v|lab",
      capturedAt:Date.now()
    }]};
    connector.live = {pendingUndoReviews:()=>[],dismissUndoReview:()=>false};
    connector.status = document.createElement("span");
    connector.showStatus("Synced · server acknowledged");
    expect(connector.getCurrentStatus()).toContain("Undo/Redo 1件を確認");
    expect(connector.status.textContent).toContain("Synced · server acknowledged");
    connector.persistSettings = vi.fn(async()=>{});
    expect(connector.dismissUndoReview(connector.getUndoReviews()[0])).toBe(true);
    expect(connector.getCurrentStatus()).toBe("Synced · server acknowledged");
  });
  it("shows a short native IME warning without lying about server durability",()=>{
    const plugin=new IgnisConnector();
    const current={composing:true,peerEditWaiting:false};
    plugin.app.workspace.getActiveFile=()=>({path:"IME.md"});
    plugin.settings={scope:"lab",undoReviews:[]};
    plugin.live={compositionState:()=>current,pendingUndoReviews:()=>[]};
    plugin.status=document.createElement("span");
    plugin.showStatus("Synced · server acknowledged");
    expect(plugin.status.textContent).toBe("Ignis: IME変換中 · 未確定");
    expect(plugin.status.getAttribute("aria-label"))
      .toMatch(/Server has received provisional text.*IME not confirmed/);
    expect(plugin.getCurrentStatus()).not.toContain("Synced · server acknowledged");
    current.peerEditWaiting=true;
    plugin.renderStatus();
    expect(plugin.status.textContent).toContain("競合保留中");
    current.composing=false;
    plugin.renderStatus();
    expect(plugin.status.textContent).toBe("Ignis: Synced · server acknowledged");
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
