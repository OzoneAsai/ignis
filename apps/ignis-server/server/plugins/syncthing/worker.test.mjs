import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SidecarProcess } = require("../../plugin-system/sidecar-process");
const { encodePairingCard, decodePairingCard } =
  require("../../../../../packages/syncthing-control/src/pairing-card");
const DEVICE_ID = "ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG";
const ENTRY = fileURLToPath(new URL("./worker.js", import.meta.url));
let root;
let driver;
let mockServer;

function connection(origin) {
  return {
    origin,
    apiKey: "only-the-worker-may-read-this-key",
    deviceId: DEVICE_ID,
    configDir: path.join(root, "syncthing-config"),
    dataDir: path.join(root, "syncthing-data"),
  };
}

async function launch() {
  driver = new SidecarProcess({
    id: "syncthing", entry: ENTRY, dataDir: root,
    readyTimeoutMs: 2500, stopTimeoutMs: 200,
  });
  await driver.start();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-syncthing-sidecar-"));
});

afterEach(async () => {
  await driver?.stop();
  driver = null;
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  mockServer = null;
  await fs.rm(root, { force: true, recursive: true });
});

describe("optional Syncthing backend sidecar", () => {
  it("works without Syncthing installed or configured", async () => {
    await launch();
    expect((await driver.health()).state).toBe("running");
    await expect(driver.request("status")).resolves.toEqual({
      configured: false, connected: false, reason: "not-configured",
    });
    await expect(driver.request("pause")).rejects.toThrow("not been enrolled");
    await expect(driver.request("shutdown")).rejects.toThrow("Unsupported");
  });

  it("attests an isolated local API and permits only expected controls", async () => {
    const actions = [];
    const saved = [];
    const savedFolders = [];
    const remoteId = "VHRCSES-MPW4QO5-OKXSVDU-P2ZVNVE-K4T6WUS-3HCULBP-SYEQ4AG-KEIOXAR";
    mockServer = http.createServer((req, res) => {
      actions.push({ path: req.url, method: req.method,
        apiKey: req.headers["x-api-key"] });
      if (req.headers["x-api-key"] !== "only-the-worker-may-read-this-key") {
        res.writeHead(401); res.end(); return;
      }
      if (req.url === "/rest/config/devices" && req.method === "POST") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          saved.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
        return;
      }
      if (req.url === "/rest/config/folders" && req.method === "POST") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const folder = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          savedFolders.push(folder);
          if (folder.id === "pilot-ack-loss") {
            // The API applied the mutation, but the network acknowledgment
            // vanished. The client must discover the existing folder on retry.
            res.destroy();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
        return;
      }
      let body = null;
      if (req.url === "/rest/system/status") {
        body = { myID: DEVICE_ID, uptime: 15 };
      } else if (req.url === "/rest/system/paths") {
        body = { "baseDir-config": path.join(root, "syncthing-config"),
          "baseDir-data": path.join(root, "syncthing-data") };
      } else if (req.url === "/rest/config") {
        body = { options: { listenAddresses: ["tcp://0.0.0.0:22020"] },
          devices: [{ deviceID: DEVICE_ID }, ...saved],
          folders: savedFolders };
      } else if (req.url === "/rest/config/defaults/device") {
        body = { addresses: ["dynamic"], autoAcceptFolders: false };
      } else if (req.url === "/rest/config/defaults/folder") {
        body = { id: "", label: "", path: "", type: "sendreceive",
          devices: [] };
      } else if (req.url?.startsWith("/rest/svc/deviceid?id=")) {
        body = { id: new URL(req.url, "http://localhost").searchParams.get("id") };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body ? JSON.stringify(body) : "");
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${mockServer.address().port}`;
    await fs.writeFile(path.join(root, "syncthing-connection.json"),
      JSON.stringify(connection(origin)), { mode: 0o600 });
    await launch();
    await expect(driver.request("status")).resolves.toMatchObject({
      configured: true, connected: true, deviceId: DEVICE_ID, uptime: 15,
    });
    const invitation = await driver.request("pairingCard", {
      address: "tcp://100.75.232.0:22020", name: "Mac-Test",
      folderId: "ignis-pilot",
    });
    expect(invitation.available).toBe(true);
    expect(decodePairingCard(invitation.card)).toMatchObject({
      deviceId: DEVICE_ID, name: "Mac-Test",
      address: "tcp://100.75.232.0:22020",
      folderId: "ignis-pilot",
    });
    const remoteCard = encodePairingCard({
      deviceId: remoteId, name: "SLS",
      address: "tcp://100.113.211.42:22020", folderId: "ignis-pilot",
    });
    const imported = await driver.request("importPairingCard", { card: remoteCard });
    expect(imported).toMatchObject({
      deviceId: remoteId, folderId: "ignis-pilot", alreadyPresent: false,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      deviceID: remoteId, name: "SLS",
      addresses: ["tcp://100.113.211.42:22020"],
      autoAcceptFolders: false, introducer: false,
    });
    const importedAgain = await driver.request("importPairingCard", { card: remoteCard });
    expect(importedAgain.alreadyPresent).toBe(true);
    expect(saved).toHaveLength(1);
    await expect(driver.request("importPairingCard", { card: invitation.card }))
      .rejects.toThrow("Syncthing control unavailable");
    expect(saved).toHaveLength(1);

    await fs.mkdir(path.join(root, "syncthing-config"));
    await fs.mkdir(path.join(root, "syncthing-data"));
    const [firstShare, secondShare] = await Promise.all([
      driver.request("createPilotShare", { folderId: "ignis-pilot",
        peerDeviceId: remoteId, allowLowSpace: true }),
      driver.request("createPilotShare", { folderId: "ignis-pilot",
        peerDeviceId: remoteId, allowLowSpace: true }),
    ]);
    const location = path.join(await fs.realpath(root), "pilot-media", "ignis-pilot");
    expect(firstShare).toEqual({
      folderId: "ignis-pilot", folderPath: location, alreadyPresent: false,
    });
    expect(secondShare.alreadyPresent).toBe(true);
    expect(await fs.readdir(location)).toEqual([]);
    expect(savedFolders).toHaveLength(1);
    expect(savedFolders[0]).toMatchObject({
      id: "ignis-pilot", path: location, type: "sendreceive",
      devices: [{ deviceID: DEVICE_ID }, { deviceID: remoteId }],
    });
    await expect(driver.request("createPilotShare", {
      folderId: "new-pilot", peerDeviceId: "unknown-device",
    })).rejects.toThrow("Syncthing control unavailable");
    expect(savedFolders).toHaveLength(1);
    await expect(driver.request("createPilotShare", {
      folderId: "ignis-pilot", peerDeviceId: "unknown-device",
    })).rejects.toThrow("Syncthing control unavailable");
    expect(savedFolders).toHaveLength(1);

    const lostAck = { folderId: "pilot-ack-loss",
      peerDeviceId: remoteId, allowLowSpace: true };
    await expect(driver.request("createPilotShare", lostAck))
      .rejects.toThrow("Syncthing control unavailable");
    expect(savedFolders).toHaveLength(2);
    const recovered = await driver.request("createPilotShare", lostAck);
    expect(recovered).toMatchObject({
      folderId: "pilot-ack-loss", alreadyPresent: true,
    });
    expect(savedFolders).toHaveLength(2);
    await expect(driver.request("pause")).resolves.toMatchObject({ paused: true });
    await expect(driver.request("resume")).resolves.toMatchObject({ paused: false });
    expect(actions.map((action) => action.path)).toContain("/rest/system/pause");
    expect(actions.map((action) => action.path)).toContain("/rest/system/resume");
    expect(actions.every((action) => action.apiKey ===
      "only-the-worker-may-read-this-key")).toBe(true);
  });

  it("rejects a world-readable credential file", async () => {
    await fs.writeFile(path.join(root, "syncthing-connection.json"),
      JSON.stringify(connection("http://127.0.0.1:8386")), { mode: 0o644 });
    await launch();
    await expect(driver.request("pause")).rejects.toThrow("private regular file");
  });
});
