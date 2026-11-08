import { constants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export { prepareEmptyPilotFolder } from "../../../packages/syncthing-control/src/pilot-folder";

export type DetectedSyncthing = {
  executablePath: string;
  origin: "environment" | "installed" | "downloads" | "custom";
};

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  candidates?: string[];
};

/**
 * Discovery is deliberately read-only: finding a binary does not execute,
 * install, replace or start it. A user must confirm the result before launch.
 */
export async function discoverSyncthing(
  { env = process.env, platform = process.platform, home = os.homedir(),
    candidates = [] }: DiscoveryOptions = {},
): Promise<DetectedSyncthing[]> {
  const binary = platform === "win32" ? "syncthing.exe" : "syncthing";
  const pathEntries = (env.PATH || env.Path || env.path || "").split(path.delimiter)
    .filter(Boolean).slice(0, 120);
  const extracted: string[] = [];
  for (const directory of [path.join(home, "Downloads"), path.join(home, "Desktop")]) {
    let entries: import("node:fs").Dirent[];
    try { entries = (await fs.readdir(directory, { withFileTypes: true })).slice(0, 180); }
    catch { continue; }
    extracted.push(path.join(directory, binary));
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^syncthing(?:[-_.]|$)/i.test(entry.name)) continue;
      const folder = path.join(directory, entry.name);
      extracted.push(path.join(folder, binary));
      // The official Windows release can unpack to an identically named
      // inner directory. Never recursively scan the user's Downloads tree.
      let nested: import("node:fs").Dirent[];
      try { nested = (await fs.readdir(folder, { withFileTypes: true })).slice(0, 30); }
      catch { continue; }
      for (const child of nested) {
        if (child.isDirectory() && /^syncthing(?:[-_.]|$)/i.test(child.name)) {
          extracted.push(path.join(folder, child.name, binary));
        }
      }
    }
  }
  const installed = platform === "win32" ? [
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Syncthing", binary),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Syncthing", binary),
    path.join(home, "scoop", "apps", "syncthing", "current", binary),
  ] : [
    "/opt/homebrew/bin/syncthing",
    "/opt/homebrew/opt/syncthing/bin/syncthing",
    "/usr/local/bin/syncthing",
    "/usr/bin/syncthing",
  ];
  const choices: Array<{ file: string; origin: DetectedSyncthing["origin"] }> = [
    ...candidates.map((file) => ({ file, origin: "custom" as const })),
    ...installed.filter((file): file is string => !!file)
      .map((file) => ({ file, origin: "installed" as const })),
    ...extracted.map((file) => ({ file, origin: "downloads" as const })),
    ...pathEntries.map((folder) =>
      ({ file: path.join(folder, binary), origin: "environment" as const })),
  ];
  const seen = new Set<string>();
  const found: DetectedSyncthing[] = [];
  for (const choice of choices.slice(0, 260)) {
    if (!path.isAbsolute(choice.file)) continue;
    try {
      const real = await fs.realpath(choice.file);
      const stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      if (platform !== "win32") await fs.access(real, constants.X_OK);
      if (platform === "win32" && path.extname(real).toLowerCase() !== ".exe") continue;
      const key = platform === "win32" ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ executablePath: real, origin: choice.origin });
    } catch {
      // Missing installations are expected. No commands are executed.
    }
  }
  return found;
}

export function defaultPilotFolder(home = os.homedir()): string {
  return path.join(home, "IGNIS-Media-Pilot");
}

export function normalizePeerAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("接続先のTailnetアドレスが必要です。");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    return normalizePeerAddress("tcp://" + trimmed + ":22020");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(trimmed)) {
    return normalizePeerAddress("tcp://" + trimmed);
  }
  // A MagicDNS name can be pasted directly without knowing tcp:// syntax.
  // Keep the grammar strict: arbitrary URLs and paths are not accepted.
  if (!trimmed.includes("://") &&
      trimmed.length <= 253 &&
      /^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d{1,5})?$/.test(trimmed) &&
      !trimmed.includes("..")) {
    const explicitPort = /:\d{1,5}$/.test(trimmed);
    return normalizePeerAddress("tcp://" + trimmed + (explicitPort ? "" : ":22020"));
  }
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { throw new Error("接続先は tcp://IP:22020 の形式で入力してください。"); }
  if (parsed.protocol !== "tcp:" || !parsed.hostname ||
      !parsed.port || !/^\d+$/.test(parsed.port) ||
      Number(parsed.port) < 1 || Number(parsed.port) > 65535 ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Tailnet IP、MagicDNS名、または tcp://IP:22020 を入力してください。");
  }
  if (/^\d+(?:\.\d+){3}$/.test(parsed.hostname) &&
      parsed.hostname.split(".").some((part) => Number(part) > 255)) {
    throw new Error("IPアドレスの範囲が正しくありません。");
  }
  return "tcp://" + parsed.host;
}

export function normalizeFolderId(raw: string): string {
  const id = raw.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(id)) {
    throw new Error("共有IDは3～64文字の英数字、-、_で指定してください。");
  }
  return id;
}

export function cleanPeerName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 80 || /[\r\n\t]/.test(name)) {
    throw new Error("接続先の名前は1～80文字の一行テキストにしてください。");
  }
  return name;
}
