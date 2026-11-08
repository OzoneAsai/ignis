import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { probeRunningSyncthing, enrollPrivateSidecar } =
  require("./enrollment");

const DEVICE_ID = "ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG-ABCDEFG";
const KEY = "private-syncthing-test-api-key";
let root;
let home;
let server;
let port;
let invalid = "";

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ignis-enroll-")));
  home = path.join(root, "syncthing-home");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.writeFile(path.join(home, "config.xml"),
    `<configuration><gui><apikey>${KEY}</apikey></gui></configuration>`,
    { mode: 0o600 });
  server = http.createServer((req, res) => {
    if (req.headers["x-api-key"] !== KEY) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (invalid === "redirect") {
      res.writeHead(302, { Location: "https://example.invalid/steal" });
      res.end();
      return;
    }
    if (invalid === "oversized") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "x".repeat(1024 * 1024 + 40) }));
      return;
    }
    let value;
    if (req.url === "/rest/system/status") {
      value = { myID: invalid === "wrong-device" ? "not-an-id" : DEVICE_ID };
    } else if (req.url === "/rest/system/paths") {
      value = {
        "baseDir-config": invalid === "wrong-home" ? root : home,
        "baseDir-data": home,
      };
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { force: true, recursive: true });
  invalid = "";
});

describe("Mac Sidecar bootstrap enrollment", () => {
  it("probes the private home, then creates an atomic 0600 registration", async () => {
    const { connection, preview } = await probeRunningSyncthing({ homeDir: home, port });
    expect(preview).toMatchObject({
      deviceId: DEVICE_ID, configDir: home, dataDir: home,
    });
    expect(preview).not.toHaveProperty("apiKey");
    const dir = path.join(root, "server", "plugins", "syncthing");
    const result = await enrollPrivateSidecar({ sidecarDir: dir, connection });
    const file = await fs.readFile(result.path, "utf8");
    expect(JSON.parse(file)).toMatchObject({
      deviceId: DEVICE_ID, apiKey: KEY,
    });
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    await expect(enrollPrivateSidecar({ sidecarDir: dir, connection }))
      .rejects.toThrow();
    expect(await fs.readFile(result.path, "utf8")).toBe(file);
    expect((await fs.readdir(dir)).sort()).toEqual(["syncthing-connection.json"]);
  });

  it("rejects secrets in world-readable files and linked configuration", async () => {
    await fs.chmod(path.join(home, "config.xml"), 0o644);
    await expect(probeRunningSyncthing({ homeDir: home, port }))
      .rejects.toThrow("private regular file");
    await fs.chmod(path.join(home, "config.xml"), 0o600);
    await fs.rename(path.join(home, "config.xml"), path.join(home, "original.xml"));
    await fs.symlink(path.join(home, "original.xml"), path.join(home, "config.xml"));
    await expect(probeRunningSyncthing({ homeDir: home, port }))
      .rejects.toThrow("private regular file");
  });

  it("rejects a mismatching API identity or state directory", async () => {
    invalid = "wrong-device";
    await expect(probeRunningSyncthing({ homeDir: home, port }))
      .rejects.toThrow("identity");
    invalid = "wrong-home";
    await expect(probeRunningSyncthing({ homeDir: home, port }))
      .rejects.toThrow("identity");
  });

  it("will not follow local API redirects or accept oversized responses", async () => {
    invalid = "redirect";
    await expect(probeRunningSyncthing({ homeDir: home, port })).rejects.toThrow();
    invalid = "oversized";
    await expect(probeRunningSyncthing({ homeDir: home, port }))
      .rejects.toThrow("too large");
  });

  it("refuses to put an IGNIS enrollment inside the Syncthing private home", async () => {
    const { connection } = await probeRunningSyncthing({ homeDir: home, port });
    await expect(enrollPrivateSidecar({
      sidecarDir: path.join(home, "plugins", "syncthing"), connection,
    })).rejects.toThrow("separate");
  });
});
