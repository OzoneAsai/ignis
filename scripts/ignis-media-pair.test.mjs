import { describe, expect, it, vi } from "vitest";
import { runMediaPair } from "./ignis-media-pair.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { encodePairingCard } = require("../packages/syncthing-control/src/pairing-card");

const MAC_ID = "ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG";
const SLS_ID = "VHRCSES-MPW4QO5-OKXSVDU-P2ZVNVE-K4T6WUS-3HCULBP-SYEQ4AG-KEIOXAR";
const macCard = encodePairingCard({
  deviceId: MAC_ID, name: "Mac-IGNIS",
  address: "tcp://100.75.232.0:22020",
});
const slsCard = encodePairingCard({
  deviceId: SLS_ID, name: "SLS-mobile",
  address: "tcp://100.113.211.42:22020",
});

function harness(answers = []) {
  const sent = [];
  const output = { write: vi.fn((text) => { sent.push(String(text)); }) };
  const error = { write: vi.fn() };
  const driver = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    request: vi.fn(async (method, params) => {
      if (method === "status") return {
        configured: true, connected: true, deviceId: MAC_ID,
      };
      if (method === "listPeers") return {
        peers: [{ deviceId: SLS_ID, name: "SLS-mobile", paused: false }],
        folderIds: [],
      };
      if (method === "pairingCard") return { available: true, card: macCard };
      if (method === "importPairingCard") return {
        deviceId: SLS_ID, folderId: "ignis-media-pilot",
        alreadyPresent: true,
      };
      if (method === "createPilotShare") return {
        folderId: params.folderId, folderPath: "/isolated/pilot-media/ignis-media-pilot",
        alreadyPresent: false,
      };
      throw new Error("Unexpected sidecar operation");
    }),
  };
  const input = { isTTY: true };
  const ask = vi.fn(async () => answers.shift() || "no");
  return {
    driver,
    output,
    error,
    input,
    ask,
    sent,
    run: (args) => runMediaPair(args, {
      driverFactory: () => driver, input, output, error,
      ask, env: {}, capacityProbe: async () => ({
        availableBytes: 8 * 1024 ** 3, reserveBytes: 2 * 1024 ** 3,
        constrained: false,
      }),
    }),
  };
}

describe("server-side Syncthing pairing operator CLI", () => {
  it("previews an already-running Syncthing instance before creating a private enrollment", async () => {
    const h = harness(["no"]);
    const candidate = {
      connection: {
        deviceId: MAC_ID, origin: "http://127.0.0.1:8386",
        configDir: "/test/syncthing-home", dataDir: "/test/syncthing-home",
        apiKey: "must-never-be-written-to-the-terminal",
      },
      preview: {
        deviceId: MAC_ID, configDir: "/test/syncthing-home",
        dataDir: "/test/syncthing-home",
      },
    };
    const enrollmentProbe = vi.fn(async () => candidate);
    const enrollmentSave = vi.fn(async () => ({ created: true }));
    const options = {
      driverFactory: () => h.driver, input: h.input,
      output: h.output, error: h.error, ask: h.ask, env: {},
      enrollmentProbe, enrollmentSave,
    };
    const args = ["init", "--home", "/test/syncthing-home",
      "--data-root", "/test/ignis-data"];
    expect(await runMediaPair(args, options)).toBe(0);
    expect(enrollmentProbe).toHaveBeenCalledWith({
      homeDir: "/test/syncthing-home", port: 8386,
    });
    expect(enrollmentSave).not.toHaveBeenCalled();
    expect(h.sent.join("")).not.toContain(candidate.connection.apiKey);

    h.ask.mockResolvedValue("yes");
    expect(await runMediaPair(args, options)).toBe(0);
    expect(enrollmentSave).toHaveBeenCalledWith({
      sidecarDir: "/test/ignis-data/plugins/syncthing",
      connection: candidate.connection,
    });
    expect(h.driver.start).not.toHaveBeenCalled();
    expect(h.sent.join("")).toContain("Sidecarへ登録しました");

    enrollmentSave.mockRejectedValueOnce(Object.assign(new Error("existing"), {
      code: "EEXIST",
    }));
    expect(await runMediaPair(args, options)).toBe(2);
    expect(h.sent.join("")).toContain("既存の登録があります");
  });

  it("never probes an unspecified or relative Syncthing home", async () => {
    const h = harness();
    await expect(h.run(["init"])).rejects.toThrow("absolute --home");
    await expect(h.run(["init", "--home", "relative/path"])).rejects.toThrow("absolute --home");
  });

  it("offers a readable card without exposing an API key", async () => {
    const h = harness();
    expect(await h.run(["offer", "--address", "tcp://100.75.232.0:22020"])).toBe(0);
    expect(h.driver.request).toHaveBeenCalledWith("pairingCard", {
      address: "tcp://100.75.232.0:22020",
    });
    const output = h.sent.join("");
    expect(output).toContain(macCard);
    expect(output).toContain("Mac-IGNIS");
    expect(output).not.toContain("apiKey");
    expect(h.driver.stop).toHaveBeenCalledOnce();
  });

  it("allows preview without registering if the user cancels", async () => {
    const h = harness([slsCard, "no"]);
    expect(await h.run(["enroll"])).toBe(0);
    expect(h.driver.request).not.toHaveBeenCalledWith("importPairingCard", expect.anything());
    expect(h.sent.join("")).toContain("登録を取りやめました");
  });

  it("imports a verified card only after explicit confirmation", async () => {
    const h = harness([slsCard, "yes"]);
    expect(await h.run(["enroll"])).toBe(0);
    expect(h.driver.request).toHaveBeenCalledWith("importPairingCard", { card: slsCard });
    expect(h.sent.join("")).toContain("既に登録済み");
  });

  it("does not share without confirmation and chooses only a registered peer", async () => {
    const h = harness(["no"]);
    expect(await h.run(["pilot"])).toBe(0);
    expect(h.driver.request).not.toHaveBeenCalledWith("createPilotShare", expect.anything());
    const again = harness();
    expect(await again.run(["pilot", "--folder", "ignis-media-pilot", "--yes"])).toBe(0);
    expect(again.driver.request).toHaveBeenCalledWith("createPilotShare", {
      folderId: "ignis-media-pilot", peerDeviceId: SLS_ID, allowLowSpace: false,
    });
    expect(again.sent.join("")).toContain("空フォルダを新規共有");
  });

  it("refuses new shares on an almost-full Mac without a separate operator override", async () => {
    const h = harness();
    const context = {
      driverFactory: () => h.driver,
      input: h.input, output: h.output, error: h.error, ask: h.ask, env: {},
      capacityProbe: async () => ({
        availableBytes: 400 * 1024 ** 2,
        reserveBytes: 2 * 1024 ** 3,
        constrained: true,
      }),
    };
    expect(await runMediaPair(["pilot", "--yes"], context)).toBe(2);
    expect(h.driver.request).not.toHaveBeenCalledWith("createPilotShare", expect.anything());
    expect(await runMediaPair(["pilot", "--yes", "--allow-low-space"], context)).toBe(0);
    expect(h.driver.request).toHaveBeenCalledWith("createPilotShare", {
      folderId: "ignis-media-pilot", peerDeviceId: SLS_ID, allowLowSpace: true,
    });
  });

  it("rejects mismatched peer names and unknown flags without modifying config", async () => {
    const h = harness();
    expect(await h.run(["pilot", "--peer", "UNKNOWN", "--yes"])).toBe(2);
    expect(h.driver.request).not.toHaveBeenCalledWith("createPilotShare", expect.anything());
    await expect(h.run(["status", "--unexpected-flag"])).rejects.toThrow("Invalid option");
  });

  it("shows a safe status and cleanly stops the sidecar", async () => {
    const h = harness();
    expect(await h.run(["status"])).toBe(0);
    expect(h.sent.join("")).toContain("登録済み相手: 1台");
    expect(h.driver.start).toHaveBeenCalledOnce();
    expect(h.driver.stop).toHaveBeenCalledOnce();
  });
});
