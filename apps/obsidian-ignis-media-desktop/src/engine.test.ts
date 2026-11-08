import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  MobileSyncthingController, defaultSettings, launchArguments,
  validateSettings, pathInside, privateHomeInsideVault, type MobileSettings,
} from "./engine";
import { encodePairingCard } from "../../../packages/syncthing-control/src/pairing-card";

const DEVICE_ID = "ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG";
let root: string;
let server: http.Server | undefined;

function settings(port = 8386): MobileSettings {
  return {
    ...defaultSettings(),
    executablePath: path.join(root, "syncthing"),
    homeDir: path.join(root, "private-home"),
    guiPort: port,
  };
}

const OTHER_DEVICE = "ZYXWVUT-ZYXWVUT-ZYXWVUT-ZYXWVUT-ZYXWVUT-ZYXWVUT-ZYXWVUT-ZYXWVUT";

async function startMock(home: string, deviceId = DEVICE_ID, options: {
  remoteNeedBytes?: number; localNeedBytes?: number; connected?: boolean;
  remoteState?: string; dropShutdownAck?: boolean;
  denyWrites?: boolean; noFolders?: boolean;
} = {}): Promise<{
  port: number; actions: string[];
  postedDevices: Array<Record<string, unknown>>;
  postedFolders: Array<Record<string, unknown>>;
}> {
  const actions: string[] = [];
  const postedDevices: Array<Record<string, unknown>> = [];
  const postedFolders: Array<Record<string, unknown>> = [];
  const initialDevices = [
    { deviceID: deviceId, paused: false },
    { deviceID: OTHER_DEVICE, paused: false },
  ];
  const initialFolders = [{
    id: "test-media", paused: false,
    devices: [{ deviceID: deviceId }, { deviceID: OTHER_DEVICE }],
  }];
  server = http.createServer((req, res) => {
    actions.push(`${req.method} ${req.url}`);
    if (req.url === "/rest/system/shutdown" && options.dropShutdownAck) {
      res.destroy();
      server?.close();
      return;
    }
    if (req.headers["x-api-key"] !== "this-is-a-local-test-api-key") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/rest/config/")) {
      if (options.denyWrites) {
        res.writeHead(500);
        res.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (req.url === "/rest/config/devices") postedDevices.push(body);
        if (req.url === "/rest/config/folders") postedFolders.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      return;
    }
    let body: Record<string, unknown> = {};
    if (req.url === "/rest/system/status") {
      body = { myID: deviceId, uptime: 120 };
    } else if (req.url === "/rest/system/paths") {
      body = { "baseDir-config": home, "baseDir-data": home };
    } else if (req.url === "/rest/config") {
      body = {
        devices: initialDevices, folders: options.noFolders ? [] : initialFolders,
      };
    } else if (req.url?.startsWith("/rest/svc/deviceid")) {
      const input = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
      body = input === "INVALID" ? { error: "invalid ID" } : { id: input };
    } else if (req.url === "/rest/config/defaults/device") {
      body = { addresses: ["dynamic"], autoAcceptFolders: false, introducer: false };
    } else if (req.url === "/rest/config/defaults/folder") {
      body = { id: "", label: "", path: "", devices: [{ deviceID: deviceId }],
        type: "sendreceive" };
    } else if (req.url === "/rest/system/connections") {
      body = { connections: {
        [OTHER_DEVICE]: { connected: options.connected !== false, paused: false },
      } };
    } else if (req.url?.startsWith("/rest/db/completion")) {
      const remote = req.url.includes("?device=");
      body = {
        completion: remote ? 100 : (options.localNeedBytes ? 50 : 100),
        remoteState: remote ? (options.remoteState ?? "valid") : "unknown",
        needBytes: remote ? (options.remoteNeedBytes ?? 0) :
          (options.localNeedBytes ?? 0),
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    actions, postedDevices, postedFolders,
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ignis-mobile-engine-")));
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await fs.rm(root, { force: true, recursive: true });
});

describe("desktop Syncthing engine", () => {
  it("does not auto-start or require Syncthing by default", async () => {
    const config = defaultSettings();
    expect(config.autoStart).toBe(false);
    expect(config.stopOnUnload).toBe(false);
    expect(config.executablePath).toBe("");
    const controller = new MobileSyncthingController({
      ...config, homeDir: root, guiPort: await freePort(),
    });
    expect((await controller.refresh()).state).toBe("not-configured");
    await expect(controller.start()).rejects.toThrow("Set an absolute");
  });

  it("constructs an isolated loopback process invocation without shell", () => {
    const args = launchArguments(settings());
    expect(args).toEqual([
      "serve", `--home=${path.join(root, "private-home")}`,
      "--gui-address=127.0.0.1:8386", "--no-browser", "--no-restart", "--no-upgrade",
    ]);
    expect(args.join(" ")).not.toMatch(/0\.0\.0\.0/);
    expect(() => validateSettings({ ...settings(), homeDir: "/" })).toThrow();
    expect(() => validateSettings({ ...settings(), guiPort: 80 })).toThrow();
  });

  it("recognizes Vault containment using path boundaries", () => {
    const vault = path.join(root, "Vault");
    expect(pathInside(vault, vault)).toBe(true);
    expect(pathInside(vault, path.join(vault, "private-syncthing"))).toBe(true);
    expect(pathInside(vault, path.join(root, "Vault-media"))).toBe(false);
    expect(pathInside(vault, path.join(root, "Other"))).toBe(false);
  });

  it("resolves an existing symlink before trusting the private state location", async () => {
    const vault = path.join(root, "Vault");
    await fs.mkdir(vault);
    const outside = path.join(root, "external-alias");
    await fs.symlink(vault, outside, process.platform === "win32" ? "junction" : "dir");
    expect(privateHomeInsideVault(vault, path.join(outside, "Syncthing"))).toBe(true);
    expect(privateHomeInsideVault(vault, path.join(root, "other", "Syncthing")))
      .toBe(false);
  });

  it("reads private credentials and attests before control operations", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<configuration><gui><apikey>this-is-a-local-test-api-key</apikey></gui></configuration>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);

    expect(await controller.refresh()).toMatchObject({
      state: "running", deviceId: DEVICE_ID, managedByPlugin: false,
    });
    await controller.pause();
    await controller.resume();
    expect(mock.actions).toContain("POST /rest/system/pause");
    expect(mock.actions).toContain("POST /rest/system/resume");
  });

  it("refuses to adopt an un-enrolled process on the same port", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    expect((await controller.refresh()).state).toBe("unmanaged");
    await expect(controller.start()).rejects.toThrow("not enrolled");
    await expect(controller.pause()).rejects.toThrow("not enrolled");
  });

  it("rejects an enrolled identity mismatch rather than controlling another device", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID.replace("ABCDEFG", "BADBADB"));
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    expect((await controller.refresh()).state).toBe("unmanaged");
    await expect(controller.resume()).rejects.toThrow("identity changed");
  });

  it("shows outgoing pending bytes even when the local device is already complete", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID, { remoteNeedBytes: 8192 });
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const overview = await controller.overview();
    expect(overview.status.state).toBe("running");
    expect(overview.health.kind).toBe("syncing");
    expect(overview.health.needBytes).toBe(8192);
    expect(mock.actions).toContain("GET /rest/db/completion?device=" +
      encodeURIComponent(OTHER_DEVICE) + "&folder=test-media");
  });

  it("checks the peer before claiming the data is fully synchronized", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const overview = await controller.overview();
    expect(overview.health.kind).toBe("synced");
    expect(overview.health.connectedPeers).toBe(1);
    expect(overview.health.folderCount).toBe(1);
    expect(overview.peers).toEqual([{
      deviceId: OTHER_DEVICE, name: "名前未設定", connected: true, paused: false,
    }]);
    expect(overview.folders).toEqual([{
      id: "test-media", label: "test-media", paused: false,
    }]);
  });

  it("does not show synchronized when the real peer connection is offline", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID, { connected: false });
    config.guiPort = mock.port;
    const overview = await new MobileSyncthingController(config).overview();
    expect(overview.health.kind).toBe("offline");
    expect(overview.health.connectedPeers).toBe(0);
  });

  it("rejects a false 100% when the remote peer has not accepted the shared folder", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID, { remoteState: "notSharing" });
    config.guiPort = mock.port;
    const overview = await new MobileSyncthingController(config).overview();
    expect(overview.health.kind).toBe("attention");
    expect(overview.health.completion).toBe(100);
    expect(overview.health.needBytes).toBeNull();
  });

  it("does not switch the identity of a running, reattached Syncthing", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    expect((await controller.refresh()).managedByPlugin).toBe(false);
    expect(() => controller.configure({ ...config, guiPort: 8387 }))
      .toThrow("Stop or disconnect");
    expect(() => controller.configure({ ...config, autoStart: true })).not.toThrow();
    await controller.unload();
    await expect(controller.start()).rejects.toThrow("disposed");
  });

  it("refuses an API-key configuration redirected through a symlink", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    const outside = path.join(root, "foreign-config.xml");
    await fs.writeFile(outside, "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.symlink(outside, path.join(config.homeDir, "config.xml"));
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    expect((await controller.refresh()).state).toBe("unmanaged");
    await expect(controller.pause()).rejects.toThrow("regular file");
  });

  it("recognizes a completed shutdown even when the daemon closes before HTTP ack", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID, { dropShutdownAck: true });
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    expect((await controller.refresh()).state).toBe("running");
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(controller.getStatus().state).toBe("stopped");
    expect(mock.actions).toContain("POST /rest/system/shutdown");
  });

  it("registers a new peer through the local authenticated API without sharing a folder", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const extraPeer = "QRSTUV2-QRSTUV2-QRSTUV2-QRSTUV2-QRSTUV2-QRSTUV2-QRSTUV2-QRSTUV2";
    const result = await controller.registerPeer({
      deviceId: extraPeer, name: " Mac ", address: "100.75.232.0",
    });
    expect(result).toEqual({ deviceId: extraPeer, alreadyPresent: false });
    expect(mock.postedDevices).toHaveLength(1);
    expect(mock.postedDevices[0]).toMatchObject({
      deviceID: extraPeer, name: "Mac", addresses: ["tcp://100.75.232.0:22020"],
      introducer: false, autoAcceptFolders: false,
    });
    expect(mock.postedFolders).toHaveLength(0);
    expect(await controller.registerPeer({
      deviceId: OTHER_DEVICE, name: "Mac", address: "100.75.232.0",
    })).toEqual({ deviceId: OTHER_DEVICE, alreadyPresent: true });
    expect(mock.postedDevices).toHaveLength(1);
  });

  it("exchanges a pairing card without allowing it to change the share list", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const card = await controller.makeLocalPairingCard({
      address: "100.75.232.0", name: "SLS",
      folderId: "ignis-media-pilot",
    });
    const preview = controller.previewPairingCard(card);
    expect(preview).toMatchObject({
      deviceId: DEVICE_ID, name: "SLS", address: "tcp://100.75.232.0:22020",
      folderId: "ignis-media-pilot",
    });
    expect(mock.postedDevices).toHaveLength(0);
    expect(mock.postedFolders).toHaveLength(0);
    await expect(controller.importPairingCard(card)).rejects.toThrow("自身");
    const macCard = encodePairingCard({
      deviceId: OTHER_DEVICE, name: "Mac", address: "tcp://100.75.232.0:22020",
      folderId: "ignis-media-pilot",
    });
    const result = await controller.importPairingCard(macCard);
    expect(result).toMatchObject({
      peer: { deviceId: OTHER_DEVICE, name: "Mac" },
      alreadyPresent: true,
    });
    expect(mock.postedDevices).toHaveLength(0);
    expect(mock.postedFolders).toHaveLength(0);
  });

  it("offers a registered Mac as a pairing choice before any folder is shared", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir, DEVICE_ID, { noFolders: true });
    config.guiPort = mock.port;
    const result = await new MobileSyncthingController(config).overview();
    expect(result.folders).toEqual([]);
    expect(result.health.kind).toBe("setup");
    expect(result.peers).toEqual([{
      deviceId: OTHER_DEVICE, name: "名前未設定", connected: true, paused: false,
    }]);
  });

  it("shares only a new empty, outside-Vault pilot folder with the chosen peer", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const vault = path.join(root, "Vault");
    await fs.mkdir(vault);
    const folderPath = path.join(root, "pilot");
    const result = await controller.createPilotShare({
      folderId: "ignis-media-pilot",
      folderPath,
      peerDeviceId: OTHER_DEVICE,
      vaultPath: vault,
    });
    expect(result.id).toBe("ignis-media-pilot");
    expect((await fs.readdir(folderPath))).toEqual([]);
    expect(mock.postedFolders).toHaveLength(1);
    expect(mock.postedFolders[0]).toMatchObject({
      id: "ignis-media-pilot", label: "IGNIS Media Pilot",
      path: folderPath, type: "sendreceive",
      devices: [{ deviceID: DEVICE_ID }, { deviceID: OTHER_DEVICE }],
    });
    await fs.writeFile(path.join(folderPath, "important.mp4"), "user data");
    await expect(controller.createPilotShare({
      folderId: "second-pilot", folderPath, peerDeviceId: OTHER_DEVICE, vaultPath: vault,
    })).rejects.toThrow("空でない");
    await expect(controller.createPilotShare({
      folderId: "third-pilot", folderPath: path.join(vault, "Media"),
      peerDeviceId: OTHER_DEVICE, vaultPath: vault,
    })).rejects.toThrow("Vault");
    expect(mock.postedFolders).toHaveLength(1);
  });

  it("refuses to share data with a peer not registered locally", async () => {
    const config = settings();
    await fs.mkdir(config.homeDir);
    await fs.writeFile(path.join(config.homeDir, "config.xml"),
      "<apikey>this-is-a-local-test-api-key</apikey>");
    await fs.writeFile(path.join(config.homeDir, "ignis-mobile-instance.json"),
      JSON.stringify({ deviceId: DEVICE_ID, homeDir: config.homeDir }));
    const mock = await startMock(config.homeDir);
    config.guiPort = mock.port;
    const controller = new MobileSyncthingController(config);
    const folderPath = path.join(root, "pilot");
    await expect(controller.createPilotShare({
      folderId: "ignis-media-pilot", folderPath,
      peerDeviceId: "NOT-REGISTERED", vaultPath: path.join(root, "Vault"),
    })).rejects.toThrow("先にMac側");
    await expect(fs.stat(folderPath)).rejects.toThrow();
    expect(mock.postedFolders).toHaveLength(0);
  });
});
