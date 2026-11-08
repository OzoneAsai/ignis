// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mockRequest = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  Setting: class {},
  Notice: class {},
  TFile: class {},
  editorInfoField: null,
  requestUrl: mockRequest
}));
vi.mock("./live", () => ({
  NativeYjs: class {}
}));
import IgnisConnector from "./main.ts";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances = [];
  readyState = FakeSocket.CONNECTING;
  sent = [];
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(frame) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
    this.sent.push(JSON.parse(frame));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close(code = 1000) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
}
const sockets = () => FakeSocket.instances;

function connector() {
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl: "https://ignis.example/",
    authMode: "device",
    scope: "https://ignis.example|lab",
    vaultId: "lab",
    deviceId: "device-a",
    baselines: {},
    pending: [],
    yjsIds: {}
  };
  plugin.token = "ignis_dev_" + "a".repeat(43);
  plugin.status = { setText: vi.fn() };
  plugin.schedule = vi.fn();
  plugin.live = {
    connected: vi.fn(),
    disconnected: vi.fn(),
    handle: vi.fn()
  };
  return plugin;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockRequest.mockReset();
  FakeSocket.instances = [];
});

describe("one HTTPS/WSS connector lifecycle on mobile and desktop", () => {
  it("guards old sockets from leaking a newly entered token across origins", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    const old = sockets()[0];
    plugin.token = "ignis_dev_" + "b".repeat(43);
    plugin.connectSocket();
    const current = sockets()[1];
    // Simulate an asynchronous onopen after closing the obsolete socket.
    old.open();
    expect(old.sent).toEqual([]);
    current.open();
    expect(current.sent).toEqual([{
      channel: "sync", type: "auth", token: plugin.token
    }]);
  });

  it("connects via a one-link Tailnet session without storing or sending a token", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.app = { secretStorage: null };
    plugin.saveData = vi.fn().mockResolvedValue(undefined);
    plugin.live.resetForConnection = vi.fn().mockResolvedValue(undefined);
    plugin.settings.pendingWrites = [];
    plugin.settings.syncIssues = [];
    plugin.settings.archivedScopes = [];
    plugin.settings.cursor = 0;
    plugin.settings.discoveryUrl = "";
    plugin.settings.serverDeviceId = "";
    plugin.settings.applyRemoteDeletes = false;
    mockRequest.mockResolvedValueOnce({
      status: 200, json: {
        auth: "tailnet", vaultId: "IOSLab", deviceId: "tailnet-user-a",
        label: "Tailnet user"
      }
    });
    const result = await plugin.connectToServer({
      serverUrl: "https://mac.example:8452/join/IOSLab",
      vaultId: "", token: ""
    });
    expect(result).toMatchObject({ ok: true, memoryOnly: false });
    expect(plugin.settings).toMatchObject({
      authMode: "tailnet", vaultId: "IOSLab",
      serverUrl: "https://mac.example:8452", deviceId: "tailnet-user-a"
    });
    expect(plugin.token).toBe("");
    expect(mockRequest.mock.calls[0][0].headers).toEqual({});
    const socket = sockets()[0];
    socket.open();
    expect(socket.sent).toEqual([{ channel: "sync", type: "auth" }]);
  });

  it("adopts the server's Markdown-only scope without requiring Syncthing", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.app = { secretStorage: null };
    plugin.saveData = vi.fn().mockResolvedValue(undefined);
    plugin.live.resetForConnection = vi.fn().mockResolvedValue(undefined);
    plugin.settings.pendingWrites = [];
    plugin.settings.syncIssues = [];
    plugin.settings.archivedScopes = [];
    plugin.settings.cursor = 0;
    plugin.settings.contentScope = "all";
    mockRequest.mockResolvedValueOnce({
      status: 200, json: {
        auth: "tailnet", vaultId: "MarkdownTest", deviceId: "sls-test",
        contentScope: "markdown-only",
      },
    });
    const response = await plugin.connectToServer({
      serverUrl: "https://mac.example:8452/join/MarkdownTest",
      vaultId: "", token: "",
    });
    expect(response.ok).toBe(true);
    expect(response.message).toContain("Markdown-only sharing");
    expect(plugin.settings.contentScope).toBe("markdown-only");
    expect(plugin.fileScope.allowsPath("Notes/sls.md")).toBe(true);
    expect(plugin.fileScope.allowsPath("Media/photo.jpg")).toBe(false);
  });

  it("does not forward stale collaboration frames after replacing a socket", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    const old = sockets()[0];
    old.open();
    old.receive({ channel: "sync", type: "ready", vaultId: "lab", deviceId: "device-a" });
    expect(plugin.live.connected).toHaveBeenCalledTimes(1);
    plugin.recoverConnection();
    const current = sockets()[1];
    old.receive({ channel: "collab", type: "update", path: "test.md" });
    expect(plugin.live.handle).not.toHaveBeenCalled();
    current.open();
    current.receive({ channel: "sync", type: "ready", vaultId: "lab", deviceId: "device-a" });
    current.receive({ channel: "collab", type: "update", path: "test.md" });
    expect(plugin.live.handle).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting when the server explicitly rejects authorization", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    const old = sockets()[0];
    old.open();
    old.receive({ channel: "sync", type: "auth-error" });
    expect(plugin.authBlocked).toBe(true);
    expect(plugin.socket).toBe(null);
    vi.advanceTimersByTime(120000);
    expect(sockets()).toHaveLength(1);
  });

  it("retries transport failures with a bounded delay", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    sockets()[0].close();
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);
    sockets()[1].close();
    vi.advanceTimersByTime(1999);
    expect(sockets()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(3);
  });

  it("fails closed when the server announces a different Vault", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    sockets()[0].open();
    sockets()[0].receive({ channel: "sync", type: "ready", vaultId: "other" });
    expect(plugin.live.connected).not.toHaveBeenCalled();
    expect(plugin.socket).toBe(null);
    expect(plugin.authBlocked).toBe(true);
    expect(plugin.status.setText).toHaveBeenCalledWith(
      "Ignis: Server returned the wrong Vault"
    );
    vi.advanceTimersByTime(60000);
    expect(sockets()).toHaveLength(1);
  });

  it("does not restart a live editor when advanced preferences change", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.app = {};
    plugin.saveData = vi.fn(async () => {});
    plugin.connectSocket();
    const originalToken = plugin.token;
    plugin.settings.discoveryUrl = "https://disco.example/v2/";
    await plugin.saveSettings();
    expect(plugin.token).toBe(originalToken);
    expect(sockets()).toHaveLength(1);
    expect(plugin.socket).toBe(sockets()[0]);
  });

  it("verifies a Vault-scoped token over HTTPS before storing any secret", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    const secrets = { setSecret: vi.fn(), getSecret: vi.fn(() => null) };
    plugin.app = { secretStorage: secrets };
    plugin.saveData = vi.fn(async () => {});
    const good = "ignis_dev_" + "c".repeat(43);
    mockRequest.mockResolvedValueOnce({
      status: 200, json: {
        deviceId: "11111111-1111-4111-8111-111111111111",
        vaultId: "lab", label: "iPhone"
      }
    });
    const result = await plugin.connectToServer({
      serverUrl: "https://ignis.example/",
      vaultId: "lab", token: good
    });
    expect(result.ok).toBe(true);
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://ignis.example/api/sync/v1/vaults/lab/session",
      headers: { Authorization: "Bearer " + good }
    }));
    expect(secrets.setSecret).toHaveBeenCalledWith(
      "ignis-connector-vault-https://ignis.example|lab", good
    );
    expect(plugin.settings.deviceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(plugin.token).toBe(good);
    expect(sockets()).toHaveLength(1);
    expect(plugin.saveData).toHaveBeenCalledOnce();
  });

  it("rejects an administrator token and a device enrolled to another Vault", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.app = { secretStorage: { setSecret: vi.fn() } };
    plugin.saveData = vi.fn(async () => {});
    const invalid = await plugin.connectToServer({
      serverUrl: "https://ignis.example", vaultId: "lab",
      token: "an-administrator-secret-that-must-never-be-saved"
    });
    expect(invalid.ok).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
    const token = "ignis_dev_" + "d".repeat(43);
    mockRequest.mockResolvedValueOnce({
      status: 200, json: { deviceId: "device", vaultId: "other", label: "Wrong" }
    });
    const mismatch = await plugin.connectToServer({
      serverUrl: "https://ignis.example", vaultId: "lab", token
    });
    expect(mismatch).toMatchObject({ ok: false });
    expect(plugin.app.secretStorage.setSecret).not.toHaveBeenCalled();
    expect(plugin.token).toBe("ignis_dev_" + "a".repeat(43));
    expect(sockets()).toHaveLength(0);
  });

  it("does not send credentials when Vault ID is empty, nor clear the old session", async () => {
    const plugin = connector();
    plugin.app = { secretStorage: { setSecret: vi.fn() } };
    plugin.saveData = vi.fn(async () => {});
    const existing = plugin.token;
    const result = await plugin.connectToServer({
      serverUrl: "https://ignis.example", vaultId: "",
      token: "ignis_dev_" + "b".repeat(43)
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/Vault could be detected/);
    expect(mockRequest).toHaveBeenCalledOnce();
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      url: "https://ignis.example/api/sync/v1/link", method: "GET"
    });
    expect(mockRequest.mock.calls[0][0].headers?.Authorization).toBeUndefined();
    expect(plugin.token).toBe(existing);
    expect(plugin.settings.vaultId).toBe("lab");
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("distinguishes a 404 gateway route from an unauthorized device", async () => {
    const plugin = connector();
    plugin.app = {};
    plugin.saveData = vi.fn(async () => {});
    mockRequest.mockResolvedValueOnce({ status: 404, json: { code: "NOT_FOUND" } });
    const result = await plugin.connectToServer({
      serverUrl: "https://ignis.example", vaultId: "lab",
      token: "ignis_dev_" + "b".repeat(43)
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/API not found/);
    expect(plugin.settings.deviceId).toBe("device-a");
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("verifies the new server before resetting any old Yjs Vault", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.app = { secretStorage: { setSecret: vi.fn(), getSecret: vi.fn() } };
    plugin.saveData = vi.fn(async () => {});
    plugin.settings.pendingWrites = [];
    plugin.settings.syncIssues = [];
    plugin.settings.archivedScopes = [];
    plugin.live.resetForConnection = vi.fn(async () => {});
    mockRequest.mockResolvedValueOnce({
      status: 200,
      json: { deviceId: "new-device", vaultId: "IOSLab", label: "Phone" }
    });
    const result = await plugin.connectToServer({
      serverUrl: "https://mac.example:8451", vaultId: "IOSLab",
      token: "ignis_dev_" + "c".repeat(43)
    });
    expect(result.ok).toBe(true);
    expect(plugin.live.resetForConnection).toHaveBeenCalledOnce();
    expect(plugin.settings.archivedScopes).toHaveLength(1);
    expect(plugin.settings.scope).toBe("https://mac.example:8451|IOSLab");
    expect(plugin.settings.vaultId).toBe("IOSLab");
    expect(sockets()).toHaveLength(1);
  });

  it("stops reconnecting a revoked socket without retrying the credential", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    const first = sockets()[0];
    first.open();
    first.receive({ channel: "sync", type: "ready", vaultId: "lab", deviceId: "device-a" });
    first.close(4003);
    expect(plugin.authBlocked).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(sockets()).toHaveLength(1);
  });

  it("blocks HTTP sync after revocation and retains local work", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    mockRequest.mockResolvedValueOnce({ status: 401, json: { code: "UNAUTHORIZED" } });
    await expect(plugin.api("/vaults/lab/manifest"))
      .rejects.toThrow(/authorization rejected/i);
    expect(plugin.authBlocked).toBe(true);
    expect(plugin.ready()).toBe(false);
  });

  it("rejects a wrong device ID in the authenticated WSS handshake", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const plugin = connector();
    plugin.connectSocket();
    const first = sockets()[0];
    first.open();
    first.receive({ channel: "sync", type: "ready", vaultId: "lab", deviceId: "device-b" });
    expect(plugin.authBlocked).toBe(true);
    expect(plugin.live.connected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(sockets()).toHaveLength(1);
  });
});
