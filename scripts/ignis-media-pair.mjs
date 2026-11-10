#!/usr/bin/env node

// A local operator console for the Syncthing server-side sidecar. It does not
// expose a remote administration endpoint and never reads or prints API keys.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SidecarProcess } = require("../apps/ignis-server/server/plugin-system/sidecar-process");
const { decodePairingCard } = require("../packages/syncthing-control/src/pairing-card");
const { inspectStorageCapacity } =
  require("../packages/syncthing-control/src/storage-capacity");
const { probeRunningSyncthing, enrollPrivateSidecar } =
  require("../packages/syncthing-control/src/enrollment");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerEntry = path.join(repoRoot, "apps/ignis-server/server/plugins/syncthing/worker.js");

const HELP = `IGNIS Media — Mac/server setup

Usage:
  node scripts/ignis-media-pair.mjs init --home SYNCTHING_HOME [--port 8386] [--yes]
  node scripts/ignis-media-pair.mjs status [--data-root PATH]
  node scripts/ignis-media-pair.mjs offer [--name LABEL] [--address TCP] [--folder ID] [--copy]
  node scripts/ignis-media-pair.mjs enroll [--yes]
  node scripts/ignis-media-pair.mjs pilot [--peer DEVICE_ID] [--folder ID] [--yes] [--allow-low-space]

init registers a running Syncthing instance with the IGNIS Server Sidecar.
It does not install or launch Syncthing, and never overwrites an enrollment.
The server DATA_ROOT (or --data-root) must contain a previously enrolled
plugins/syncthing/syncthing-connection.json with private file permissions.
offer prints a 24-hour contact card; enroll reads a card on stdin or prompts
for paste. A card is not authentication: verify the other device ID before
confirming. pilot adds ONLY a new empty folder under the server plugin's
private pilot-media directory, never a Vault. Syncthing must be running.
With less than 2 GiB available, pilot refuses to create a new share unless
you explicitly add --allow-low-space. This reserve does not guarantee enough
space for large files.

Normal IGNIS/Yjs editing does not require this optional tool.
`;

function parseArgs(argv, env = process.env) {
  const [action = "help", ...args] = argv;
  if (!["help", "init", "status", "offer", "enroll", "pilot"].includes(action)) {
    throw new Error("Unknown command; use help for available actions");
  }
  const parsed = { action, yes: false, copy: false, allowLowSpace: false, address: undefined,
    folder: undefined, name: undefined, peer: undefined, dataRoot: undefined,
    home: undefined, port: "8386" };
  const stringFlags = new Map([
    ["--address", "address"], ["--folder", "folder"],
    ["--name", "name"], ["--peer", "peer"],
    ["--data-root", "dataRoot"], ["--home", "home"], ["--port", "port"],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--yes" || flag === "--copy") {
      parsed[flag === "--yes" ? "yes" : "copy"] = true;
      continue;
    }
    if (flag === "--allow-low-space") {
      parsed.allowLowSpace = true;
      continue;
    }
    const property = stringFlags.get(flag);
    if (!property || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Invalid option; run help to view supported flags");
    }
    parsed[property] = args[++i];
  }
  if (parsed.dataRoot && !path.isAbsolute(parsed.dataRoot)) {
    throw new Error("--data-root must be an absolute path");
  }
  if (action === "init" && (!parsed.home || !path.isAbsolute(parsed.home))) {
    throw new Error("init requires an absolute --home path");
  }
  if (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1024 ||
      Number(parsed.port) > 65535) {
    throw new Error("--port must be a local port between 1024 and 65535");
  }
  parsed.dataRoot ||= env.DATA_ROOT || path.join(repoRoot, "data");
  return parsed;
}

function formatDevice(card) {
  return `端末名: ${card.name}
Device ID: ${card.deviceId}
接続先: ${card.address}
検証用の共有ID: ${card.folderId}
有効期限: ${new Date(card.expiresAt).toLocaleString("ja-JP")}`;
}

async function copyMacClipboard(text) {
  if (process.platform !== "darwin") return false;
  return new Promise((resolve) => {
    const child = spawn("pbcopy", [], {
      stdio: ["pipe", "ignore", "ignore"], shell: false,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

async function readCard(input, ask) {
  if (input.isTTY) return (await ask("相手の接続カードを貼り付けてEnter: ")).trim();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4096) throw new Error("Card input is too long");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function runMediaPair(argv, {
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  driverFactory,
  ask: askOverride,
  clipboardCopy = copyMacClipboard,
  capacityProbe = inspectStorageCapacity,
  enrollmentProbe = probeRunningSyncthing,
  enrollmentSave = enrollPrivateSidecar,
} = {}) {
  const opts = parseArgs(argv, env);
  if (opts.action === "help") {
    output.write(HELP);
    return 0;
  }
  const sidecarDir = path.join(path.resolve(opts.dataRoot), "plugins", "syncthing");
  const driver = driverFactory
    ? driverFactory(sidecarDir)
    : new SidecarProcess({
        id: "syncthing", entry: workerEntry, dataDir: sidecarDir,
        readyTimeoutMs: 5_000,
      });
  let rl = null;
  const ask = askOverride || ((question) => {
    rl ||= createInterface({ input, output, terminal: !!input.isTTY });
    return rl.question(question);
  });
  let started = false;
  try {
    if (opts.action === "init") {
      const info = await enrollmentProbe({
        homeDir: opts.home, port: Number(opts.port),
      });
      output.write("実行中のローカルSyncthingが見つかりました。\n");
      output.write(`Device ID: ${info.preview.deviceId}\n`);
      output.write(`Syncthing設定先: ${info.preview.configDir}\n`);
      output.write(`Syncthingデータ先: ${info.preview.dataDir}\n`);
      output.write(`IGNIS側登録先: ${sidecarDir}\n`);
      output.write("Syncthing本体の設定・プロセスは変更しません。\n");
      if (!opts.yes && (await ask("このSyncthingをIGNIS Serverへ登録しますか？ yes / no: "))
        .trim().toLowerCase() !== "yes") {
        output.write("登録を取りやめました。\n");
        return 0;
      }
      try {
        await enrollmentSave({ sidecarDir, connection: info.connection });
      } catch (cause) {
        if (cause?.code === "EEXIST") {
          output.write("このSidecarには既存の登録があります。設定は上書きしませんでした。" +
            " status コマンドで現在の接続先を確認してください。\n");
          return 2;
        }
        throw cause;
      }
      output.write("IGNIS ServerのSidecarへ登録しました。秘密のAPIキーは画面に出力していません。\n");
      return 0;
    }
    // Never create a server enrollment just because the operator asked for
    // status or help. A missing or inaccessible config must be fixed first.
    if (!driverFactory) {
      const enrollment = path.join(sidecarDir, "syncthing-connection.json");
      const info = await lstat(enrollment);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error("Enrollment file is not a private regular file");
      }
    }
    await driver.start();
    started = true;
    const status = await driver.request("status");
    if (!status.configured || !status.connected) {
      error.write("Mac側Syncthingに接続できません。IGNIS Server側の登録と稼働状態を確認してください。\n");
      return 2;
    }
    if (opts.action === "status") {
      const list = await driver.request("listPeers");
      output.write(`接続中のMac Device ID: ${status.deviceId}\n`);
      output.write(`登録済み相手: ${list.peers.length}台、共有: ${list.folderIds.length}件\n`);
      return 0;
    }
    if (opts.action === "offer") {
      const response = await driver.request("pairingCard", {
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.address ? { address: opts.address } : {}),
        ...(opts.folder ? { folderId: opts.folder } : {}),
      });
      if (!response?.available) {
        error.write("接続先を自動検出できません。--address tcp://TAILNET_IP:22020 を指定してください。\n");
        return 2;
      }
      const card = decodePairingCard(response.card);
      output.write(`このMacの接続情報:\n${formatDevice(card)}\n\n`);
      output.write(`接続カード:\n${response.card}\n`);
      if (opts.copy) {
        output.write(await clipboardCopy(response.card)
          ? "カードをクリップボードにコピーしました。\n"
          : "自動コピーできませんでした。上のカードを手動でコピーしてください。\n");
      }
      return 0;
    }
    if (opts.action === "enroll") {
      if (!input.isTTY && !opts.yes && !askOverride) {
        error.write("パイプからカードを渡す場合は、確認のため --yes を明示してください。\n");
        return 2;
      }
      const raw = await readCard(input, ask);
      const card = decodePairingCard(raw);
      if (card.deviceId === status.deviceId) {
        throw new Error("同じ端末自身のカードは登録できません");
      }
      output.write(`相手から受け取ったカード:\n${formatDevice(card)}\n`);
      output.write("カード末尾は入力破損の検査だけです。相手のDevice IDを別経路で確認してください。\n");
      if (!opts.yes && (await ask("この相手を登録しますか？ yes / no: ")).trim().toLowerCase() !== "yes") {
        output.write("登録を取りやめました。\n");
        return 0;
      }
      const result = await driver.request("importPairingCard", { card: raw });
      output.write(result.alreadyPresent
        ? "既に登録済みです。既存設定は変更していません。\n"
        : "新規登録しました。フォルダの共有は別操作です。\n");
      output.write(`検証フォルダ共有ID候補: ${result.folderId}\n`);
      return 0;
    }
    if (opts.action === "pilot") {
      const list = await driver.request("listPeers");
      if (!Array.isArray(list.peers) || !list.peers.length) {
        error.write("登録済みの相手がいません。先にenrollを実行してください。\n");
        return 2;
      }
      let peer = opts.peer;
      if (!peer && list.peers.length === 1) peer = list.peers[0].deviceId;
      if (!peer || !list.peers.some((item) => item.deviceId === peer)) {
        error.write("共有先が一意に決まりません。--peer に登録済みDevice IDを指定してください。\n");
        return 2;
      }
      const folderId = opts.folder || "ignis-media-pilot";
      output.write(`共有先: ${list.peers.find((item) => item.deviceId === peer).name || peer}\n`);
      output.write(`相手のDevice ID: ${peer}\n`);
      output.write(`共有ID: ${folderId}\n`);
      output.write("Vaultではなく、Mac側IGNISサーバープラグインの空の検証用ディレクトリだけを共有します。\n");
      const capacity = await capacityProbe(sidecarDir);
      const freeGiB = (capacity.availableBytes / (1024 ** 3)).toFixed(2);
      output.write(`Mac側のディスク空き容量: ${freeGiB} GiB\n`);
      if (capacity.constrained && !opts.allowLowSpace) {
        error.write("空き容量が2 GiB未満のため、新規共有を開始しません。" +
          "テスト専用の空フォルダに限り、確認のうえ--allow-low-spaceで明示的に許可できます。\n");
        return 2;
      }
      if (capacity.constrained) {
        output.write("容量が少ない状態です。大容量ファイルを転送しないでください。\n");
      }
      if (!opts.yes && (await ask("本当に新しい検証フォルダを登録しますか？ yes / no: "))
        .trim().toLowerCase() !== "yes") {
        output.write("共有登録を取りやめました。\n");
        return 0;
      }
      const result = await driver.request("createPilotShare", {
        folderId, peerDeviceId: peer,
        allowLowSpace: opts.allowLowSpace,
      });
      output.write(result.alreadyPresent
        ? "同じ共有が登録済みです。変更しませんでした。\n"
        : "検証専用の空フォルダを新規共有しました。\n");
      output.write(`保存先: ${result.folderPath}\n`);
      return 0;
    }
    return 2;
  } finally {
    rl?.close();
    if (started) await driver.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMediaPair(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((cause) => {
    // Never echo the raw Syncthing config, API key or user-pasted card.
    const explanation = cause?.code === "ENOENT"
      ? "登録ファイルが見つかりません。DATA_ROOT/plugins/syncthing の設定を確認してください。"
      : "セットアップ操作に失敗しました。Sidecarの接続、Device ID、共有ID、空き容量を確認してください。";
    process.stderr.write(explanation + "\n");
    process.exitCode = 1;
  });
}
