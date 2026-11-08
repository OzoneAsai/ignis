import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverSyncthing, normalizePeerAddress, normalizeFolderId,
  cleanPeerName, prepareEmptyPilotFolder,
} from "./onboarding";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ignis-onboarding-")));
});
afterEach(async () => { await fs.rm(root, { force: true, recursive: true }); });

describe("read-only Syncthing discovery", () => {
  it("returns resolved regular executable paths and ignores duplicates", async () => {
    const binary = path.join(root, "syncthing");
    await fs.writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const alias = path.join(root, "alias");
    await fs.symlink(binary, alias);
    const found = await discoverSyncthing({
      platform: "linux", home: root, env: { PATH: root },
      candidates: [alias, binary, path.join(root, "missing")],
    });
    expect(found).toEqual([{ executablePath: await fs.realpath(binary), origin: "custom" }]);
  });

  it("rejects nonexecutables and never runs a candidate during discovery", async () => {
    const binary = path.join(root, "syncthing");
    const marker = path.join(root, "executed.txt");
    await fs.writeFile(binary, '#!/bin/sh\ntouch "' + marker + '"\n');
    expect(await discoverSyncthing({
      platform: "linux", home: root, env: { PATH: root },
    })).toEqual([]);
    await fs.chmod(binary, 0o700);
    expect((await discoverSyncthing({
      platform: "linux", home: root, env: { PATH: root },
    })).length).toBe(1);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("locates extracted official-style binary layouts without traversing unrelated files", async () => {
    const release = path.join(root, "Downloads", "syncthing-linux-amd64-v2.1.7");
    const inner = path.join(release, "syncthing-linux-amd64-v2.1.7");
    await fs.mkdir(inner, { recursive: true });
    const binary = path.join(inner, "syncthing");
    await fs.writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const found = await discoverSyncthing({
      home: root, env: { PATH: "" }, platform: "linux",
    });
    expect(found).toEqual([{ executablePath: await fs.realpath(binary), origin: "downloads" }]);
  });
});

describe("pairing input validation", () => {
  it("supports a bare IPv4 Tailnet address without making up a public address", () => {
    expect(normalizePeerAddress("100.75.232.0")).toBe("tcp://100.75.232.0:22020");
    expect(normalizePeerAddress("tcp://100.75.232.0:22022")).toBe("tcp://100.75.232.0:22022");
    expect(normalizePeerAddress("mac-ignis.example.ts.net"))
      .toBe("tcp://mac-ignis.example.ts.net:22020");
    expect(normalizePeerAddress("mac-ignis.example.ts.net:22022"))
      .toBe("tcp://mac-ignis.example.ts.net:22022");
    expect(() => normalizePeerAddress("mac..example.ts.net")).toThrow();
    expect(() => normalizePeerAddress("http://example.com:80")).toThrow();
    expect(() => normalizePeerAddress("tcp://256.10.10.10:22020")).toThrow();
    expect(() => normalizePeerAddress("tcp://host:22020?key=x")).toThrow();
  });
  it("rejects invalid folder IDs and multiline names", () => {
    expect(normalizeFolderId("ignis-media-pilot")).toBe("ignis-media-pilot");
    expect(() => normalizeFolderId("../Media")).toThrow();
    expect(cleanPeerName(" 固定Mac ")).toBe("固定Mac");
    expect(() => cleanPeerName("a\nb")).toThrow();
  });
});

describe("empty pilot-folder safety", () => {
  it("creates only a new isolated path or accepts an existing empty folder", async () => {
    const folder = path.join(root, "pilot", "media");
    expect(await prepareEmptyPilotFolder(folder)).toBe(true);
    expect(await prepareEmptyPilotFolder(folder)).toBe(false);
    await fs.writeFile(path.join(folder, "original.mp4"), "data");
    await expect(prepareEmptyPilotFolder(folder)).rejects.toThrow("空でない");
  });

  it("does not follow symbolic links into existing user data", async () => {
    const real = path.join(root, "normal");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(root, "alias"));
    await expect(prepareEmptyPilotFolder(path.join(root, "alias", "Pilot")))
      .rejects.toThrow("リンク");
  });
});
