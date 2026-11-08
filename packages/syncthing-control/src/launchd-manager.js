const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// This is a user-session LaunchAgent controller. The service persists across
// Ignis restarts, but not across user logout; system-wide LaunchDaemons are a
// separate deployment mode and require explicit administrator provisioning.
class SyncthingLaunchdManager {
  constructor({ userHome = os.homedir(), uid = process.getuid?.(),
    run = execFileAsync, filesystem = fs } = {}) {
    if (!Number.isInteger(uid) || uid < 1 || !path.isAbsolute(userHome)) {
      throw new Error("A valid user session and home directory are required");
    }
    this.userHome = path.resolve(userHome);
    this.uid = uid;
    this.run = run;
    this.fs = filesystem;
  }

  fileFor(spec) {
    if (!spec?.label || !/^dev\.ignis\.syncthing\.[a-z0-9-]{1,64}$/.test(spec.label) ||
        typeof spec.xml !== "string") {
      throw new Error("Invalid managed Syncthing LaunchAgent");
    }
    return path.join(this.userHome, "Library", "LaunchAgents", spec.label + ".plist");
  }

  async assertInstalled(spec) {
    const filename = this.fileFor(spec);
    const stat = await this.fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Managed LaunchAgent must be a regular file");
    }
    if (await this.fs.readFile(filename, "utf8") !== spec.xml) {
      throw new Error("Existing LaunchAgent differs from the expected Ignis definition");
    }
    return filename;
  }

  async install(spec) {
    const filename = this.fileFor(spec);
    await this.fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      await this.assertInstalled(spec);
      return { filename, created: false };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.fs.writeFile(filename, spec.xml, { flag: "wx", mode: 0o600 });
    return { filename, created: true };
  }

  async activate(spec) {
    // Verification is mandatory: never bootstrap an unrelated user's plist.
    const filename = await this.assertInstalled(spec);
    await this.run("launchctl", ["bootstrap", `gui/${this.uid}`, filename]);
    return { label: spec.label, domain: `gui/${this.uid}` };
  }

  async deactivate(spec) {
    await this.assertInstalled(spec);
    await this.run("launchctl", ["bootout", `gui/${this.uid}/${spec.label}`]);
    return { label: spec.label, stopped: true };
  }

  async remove(spec) {
    const filename = await this.assertInstalled(spec);
    await this.fs.unlink(filename);
    return { filename, removed: true };
  }
}

module.exports = { SyncthingLaunchdManager };
