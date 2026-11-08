import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLaunchAgent } = require("./launchd");
const { SyncthingLaunchdManager } = require("./launchd-manager");
let root;

function agent() {
  return createLaunchAgent({
    instanceId: "fixed-a",
    executable: "/opt/homebrew/bin/syncthing",
    homeDir: path.join(root, "syncthing"),
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-launchd-"));
});

afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

describe("explicit launchd manager", () => {
  it("installs an isolated user plist without starting launchctl", async () => {
    const run = vi.fn(async () => ({ stdout: "" }));
    const manager = new SyncthingLaunchdManager({ userHome: root, uid: 501, run });
    const spec = agent();
    expect(await manager.install(spec)).toMatchObject({ created: true });
    expect(await manager.install(spec)).toMatchObject({ created: false });
    expect(await manager.assertInstalled(spec)).toContain("dev.ignis.syncthing.fixed-a.plist");
    expect(run).not.toHaveBeenCalled();
  });

  it("starts and stops only the exact managed launchd label", async () => {
    const run = vi.fn(async () => ({ stdout: "" }));
    const manager = new SyncthingLaunchdManager({ userHome: root, uid: 501, run });
    const spec = agent();
    await manager.install(spec);
    await manager.activate(spec);
    await manager.deactivate(spec);
    expect(run.mock.calls).toEqual([
      ["launchctl", ["bootstrap", "gui/501", manager.fileFor(spec)]],
      ["launchctl", ["bootout", "gui/501/dev.ignis.syncthing.fixed-a"]],
    ]);
    expect(await manager.remove(spec)).toMatchObject({ removed: true });
  });

  it("refuses to overwrite, launch or delete a modified foreign agent", async () => {
    const run = vi.fn(async () => ({ stdout: "" }));
    const manager = new SyncthingLaunchdManager({ userHome: root, uid: 501, run });
    const spec = agent();
    await manager.install(spec);
    await fs.writeFile(manager.fileFor(spec), "<plist>foreign</plist>");
    await expect(manager.install(spec)).rejects.toThrow("differs");
    await expect(manager.activate(spec)).rejects.toThrow("differs");
    await expect(manager.deactivate(spec)).rejects.toThrow("differs");
    await expect(manager.remove(spec)).rejects.toThrow("differs");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not adopt a symlinked plist", async () => {
    const manager = new SyncthingLaunchdManager({ userHome: root, uid: 501 });
    const spec = agent();
    const filename = manager.fileFor(spec);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const foreign = path.join(root, "foreign.plist");
    await fs.writeFile(foreign, spec.xml);
    await fs.symlink(foreign, filename);
    await expect(manager.install(spec)).rejects.toThrow("regular file");
  });
});
