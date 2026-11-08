import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

const VERSION = "2.1.7";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 96 * 1024 * 1024;
const ASSETS = {
  "win32-x64": {
    asset: `syncthing-windows-amd64-v${VERSION}.zip`,
    sha256: "3ce7da770f546a8d02b65b2e7ee31f2a3b8b7c3f990ede045590cca4172ecfe1",
    executableSha256: "cd9aea20afda2b9bdba5aff2e6ac964ed5c2e741ed4ceb48ad9e1be096ca7891",
    member: `syncthing-windows-amd64-v${VERSION}/syncthing.exe`,
    binary: "syncthing.exe",
  },
  "darwin-arm64": {
    asset: `syncthing-macos-arm64-v${VERSION}.zip`,
    sha256: "2df075b463231a307c91da657157beaed06383a941ba7ea04d33d536e3c4af38",
    executableSha256: "38aab77073e47a717ec59eab082670b4fccf28c256fa0f7935aebb3f4665bb01",
    member: `syncthing-macos-arm64-v${VERSION}/syncthing`,
    binary: "syncthing",
  },
} as const;

type AssetSpec = typeof ASSETS[keyof typeof ASSETS];

export type InstallProgress = { bytes: number; total: number | null };
export type InstallOptions = {
  homeDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
  // Test-only boundary to exercise the installer without network access.
  download?: (url: string) => Promise<Buffer>;
};

function artifact(platform: string, arch: string): AssetSpec {
  const key = platform + "-" + arch;
  if (!(key in ASSETS)) {
    throw new Error("このOSとCPUには自動導入の検証済み配布物がありません。手動で指定してください。");
  }
  return ASSETS[key as keyof typeof ASSETS];
}

export function officialSyncthingVersion(): string {
  return VERSION;
}

export function supportedOfficialInstall(platform = process.platform,
  arch = process.arch): boolean {
  return (platform + "-" + arch) in ASSETS;
}

export function officialInstallDirectory(homeDir: string): string {
  if (!path.isAbsolute(homeDir)) throw new Error("Syncthingホームは絶対パスにしてください。");
  return path.join(path.dirname(path.resolve(homeDir)), "Tools", "Syncthing", `v${VERSION}`);
}

export function extractExecutableFromZip(archive: Buffer, expected: string): Buffer {
  if (archive.length > MAX_ARCHIVE_BYTES || archive.length < 22) {
    throw new Error("Syncthingの配布アーカイブが不正です。");
  }
  let eocd = -1;
  for (let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || archive.readUInt16LE(eocd + 4) !== 0 ||
      archive.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("SyncthingのZIP索引を確認できません。");
  }
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count > 400 || centralOffset + centralSize > eocd) {
    throw new Error("SyncthingのZIP索引が不正です。");
  }
  let cursor = centralOffset;
  let target: { method: number; compressed: number; uncompressed: number; offset: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > archive.length ||
        archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("SyncthingのZIP索引が破損しています。");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20);
    const uncompressed = archive.readUInt32LE(cursor + 24);
    const nameSize = archive.readUInt16LE(cursor + 28);
    const extraSize = archive.readUInt16LE(cursor + 30);
    const commentSize = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > archive.length || next > centralOffset + centralSize) {
      throw new Error("SyncthingのZIP項目が破損しています。");
    }
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
    if (name === expected) {
      if (target || (flags & 1) || ![0, 8].includes(method) ||
          compressed > MAX_ARCHIVE_BYTES || uncompressed > MAX_EXECUTABLE_BYTES) {
        throw new Error("Syncthingの実行ファイル項目が不正です。");
      }
      target = { method, compressed, uncompressed, offset };
    }
    cursor = next;
  }
  if (!target) throw new Error("公式ZIPに想定したSyncthing実行ファイルがありません。");
  const pos = target.offset;
  if (pos + 30 > archive.length || archive.readUInt32LE(pos) !== 0x04034b50) {
    throw new Error("Syncthing実行ファイルのZIPヘッダーが不正です。");
  }
  const payload = pos + 30 + archive.readUInt16LE(pos + 26) +
    archive.readUInt16LE(pos + 28);
  if (payload + target.compressed > archive.length) {
    throw new Error("Syncthing実行ファイルのZIPデータが不正です。");
  }
  const bytes = archive.subarray(payload, payload + target.compressed);
  const result = target.method === 8
    ? inflateRawSync(bytes, { maxOutputLength: MAX_EXECUTABLE_BYTES })
    : Buffer.from(bytes);
  if (result.length !== target.uncompressed || result.length < 1024 * 1024) {
    throw new Error("Syncthing実行ファイルのサイズが一致しません。");
  }
  return result;
}

function safeRedirect(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" ||
      !(parsed.hostname === "github.com" ||
        parsed.hostname.endsWith(".githubusercontent.com")) ||
      parsed.username || parsed.password) {
    throw new Error("公式以外のダウンロード先への移動を拒否しました。");
  }
  return parsed;
}

async function downloadOfficialZip(url: string, signal?: AbortSignal,
  onProgress?: (progress: InstallProgress) => void,
  depth = 0): Promise<Buffer> {
  if (depth > 5) throw new Error("ダウンロードのリダイレクトが多すぎます。");
  const uri = safeRedirect(url);
  if (signal?.aborted) throw new Error("ダウンロードを中止しました。");
  return new Promise<Buffer>((resolve, reject) => {
    const req = https.get(uri, { timeout: 30000 }, (response) => {
      const code = response.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(code) && response.headers.location) {
        response.resume();
        void downloadOfficialZip(new URL(response.headers.location, uri).toString(),
          signal, onProgress, depth + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`配布元からHTTP ${code}が返されました。`));
        return;
      }
      const expected = Number(response.headers["content-length"]);
      if (Number.isFinite(expected) && expected > MAX_ARCHIVE_BYTES) {
        response.destroy(new Error("配布アーカイブがサイズ上限を超えています。"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_ARCHIVE_BYTES) {
          response.destroy(new Error("配布アーカイブがサイズ上限を超えています。"));
          return;
        }
        chunks.push(chunk);
        onProgress?.({ bytes: length,
          total: Number.isFinite(expected) && expected > 0 ? expected : null });
      });
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("ダウンロードが中断されました。")));
      response.once("end", () => resolve(Buffer.concat(chunks)));
    });
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("ダウンロードがタイムアウトしました。")));
    const deadline = setTimeout(() =>
      req.destroy(new Error("ダウンロードに時間がかかりすぎています。")), 180000);
    deadline.unref?.();
    const abort = () => req.destroy(new Error("ダウンロードを中止しました。"));
    signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
    });
  });
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function installOfficialSyncthing({
  homeDir, platform = process.platform, arch = process.arch,
  signal, onProgress, download,
}: InstallOptions): Promise<string> {
  const selected = artifact(platform, arch);
  const installDir = officialInstallDirectory(homeDir);
  const binary = path.join(installDir, selected.binary);
  const manifestFile = path.join(installDir, "ignis-install-manifest.json");
  const existing = await fs.lstat(installDir).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("既存のインストール先を上書きできません。");
    }
    try {
      const [fileStat, manifestStat] = await Promise.all([
        fs.lstat(binary), fs.lstat(manifestFile),
      ]);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
          !manifestStat.isFile() || manifestStat.isSymbolicLink() ||
          manifestStat.size > 4096) throw new Error("not verified");
      const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
      if (manifest.version !== VERSION || manifest.archiveSha256 !== selected.sha256 ||
          manifest.executableSha256 !== selected.executableSha256 ||
          digest(await fs.readFile(binary)) !== selected.executableSha256) {
        throw new Error("not verified");
      }
      return binary;
    } catch {
      throw new Error("既存の配置に検証できないファイルがあります。自動上書きせず停止しました。");
    }
  }
  const url = `https://github.com/syncthing/syncthing/releases/download/v${VERSION}/${selected.asset}`;
  const archive = download ? await download(url) :
    await downloadOfficialZip(url, signal, onProgress);
  if (signal?.aborted) throw new Error("ダウンロードを中止しました。");
  if (digest(archive) !== selected.sha256) {
    throw new Error("ダウンロードのSHA-256が公式配布物と一致しません。");
  }
  const exe = extractExecutableFromZip(archive, selected.member);
  if (digest(exe) !== selected.executableSha256) {
    throw new Error("Syncthing実行ファイルのSHA-256が一致しません。");
  }
  if (signal?.aborted) throw new Error("ダウンロードを中止しました。");
  await fs.mkdir(path.dirname(installDir), { recursive: true, mode: 0o700 });
  // Serialize this install path across plugin windows, without granting
  // another process permission to replace already installed binaries.
  const lockPath = installDir + ".installing";
  let lock: import("node:fs/promises").FileHandle;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("この場所へのSyncthing導入が既に進行中です。");
    }
    throw error;
  }
  const staging = installDir + ".pending-" + randomBytes(7).toString("hex");
  try {
    const occupied = await fs.lstat(installDir).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (occupied) throw new Error("導入先が別の操作で変更されました。上書きしません。");
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(path.join(staging, selected.binary), exe, { flag: "wx", mode: 0o700 });
    await fs.writeFile(path.join(staging, "ignis-install-manifest.json"),
      JSON.stringify({
        version: VERSION, asset: selected.asset, source: url,
        archiveSha256: selected.sha256, executableSha256: digest(exe),
      }), { flag: "wx", mode: 0o600 });
    if (signal?.aborted) throw new Error("ダウンロードを中止しました。");
    await fs.rename(staging, installDir);
    return binary;
  } finally {
    // The temporary path was just created using cryptographic randomness and
    // is always a strict child of this install parent, never the user's Vault.
    await fs.rm(staging, { recursive: true, force: true });
    await lock.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}
