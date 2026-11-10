import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractExecutableFromZip, installOfficialSyncthing,
  officialInstallDirectory, officialSyncthingVersion, supportedOfficialInstall,
} from "./onboarding-installer";

function makeZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    parts.push(local, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, index, end]);
}

const macMember = "syncthing-macos-arm64-v2.1.7/syncthing";

describe("pinned official Syncthing install", () => {
  it("enables only explicitly validated OS/CPU release assets", () => {
    expect(officialSyncthingVersion()).toBe("2.1.7");
    expect(supportedOfficialInstall("darwin", "arm64")).toBe(true);
    expect(supportedOfficialInstall("win32", "x64")).toBe(true);
    expect(supportedOfficialInstall("linux", "s390x")).toBe(false);
    expect(officialInstallDirectory("/Users/test/.local/share/Ignis/Syncthing-Mobile"))
      .toBe(path.join("/Users/test/.local/share/Ignis", "Tools", "Syncthing", "v2.1.7"));
  });

  it("extracts only the exact expected executable, not similarly named scripts", () => {
    const bytes = Buffer.alloc(1024 * 1024, 42);
    const zip = makeZip([
      { name: "syncthing-macos-arm64-v2.1.7/etc/syncthing", bytes: Buffer.from("unsafe") },
      { name: macMember, bytes },
    ]);
    expect(createHash("sha256").update(extractExecutableFromZip(zip, macMember)).digest("hex"))
      .toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(() => extractExecutableFromZip(zip, "../syncthing")).toThrow("想定した");
  });

  it("rejects duplicate executable entries and truncated central directory", () => {
    const bytes = Buffer.alloc(1024 * 1024, 42);
    const zip = makeZip([{ name: macMember, bytes }, { name: macMember, bytes }]);
    expect(() => extractExecutableFromZip(zip, macMember)).toThrow("項目が不正");
    expect(() => extractExecutableFromZip(zip.subarray(0, zip.length - 11), macMember))
      .toThrow();
  });

  it("rejects an archive that has not passed the pinned SHA-256 check", async () => {
    const bytes = Buffer.alloc(1024 * 1024, 42);
    await expect(installOfficialSyncthing({
      platform: "darwin", arch: "arm64",
      homeDir: "/Users/test/.local/share/Ignis/Syncthing-Mobile",
      download: async () => makeZip([{ name: macMember, bytes }]),
    })).rejects.toThrow("SHA-256");
  });

  it("rejects unsupported platforms without attempting a download", async () => {
    let called = false;
    await expect(installOfficialSyncthing({
      platform: "linux", arch: "s390x",
      homeDir: "/tmp/ignis-unsupported",
      download: async () => {
        called = true;
        return Buffer.alloc(0);
      },
    })).rejects.toThrow("このOS");
    expect(called).toBe(false);
  });

  it("does not trust a locally forged install manifest with an unrelated executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-signed-installer-"));
    try {
      const homeDir = path.join(root, "Ignis", "Syncthing-Mobile");
      const target = officialInstallDirectory(homeDir);
      await fs.mkdir(target, { recursive: true });
      const executable = Buffer.alloc(1024 * 1024, 51);
      const forgedDigest = createHash("sha256").update(executable).digest("hex");
      await fs.writeFile(path.join(target, "syncthing"), executable);
      await fs.writeFile(path.join(target, "ignis-install-manifest.json"),
        JSON.stringify({
          version: "2.1.7",
          archiveSha256: "2df075b463231a307c91da657157beaed06383a941ba7ea04d33d536e3c4af38",
          executableSha256: forgedDigest,
        }));
      let downloaded = false;
      await expect(installOfficialSyncthing({
        homeDir, platform: "darwin", arch: "arm64",
        download: async () => {
          downloaded = true;
          return Buffer.alloc(0);
        },
      })).rejects.toThrow("検証できない");
      expect(downloaded).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
