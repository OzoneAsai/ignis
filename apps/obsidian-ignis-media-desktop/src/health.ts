export type MediaHealthKind =
  | "setup" | "stopped" | "blocked" | "connecting"
  | "offline" | "paused" | "syncing" | "attention" | "synced";

export type MediaHealth = {
  kind: MediaHealthKind;
  label: string;
  explanation: string;
  connectedPeers: number;
  peerCount: number;
  folderCount: number;
  completion: number | null;
  needBytes: number | null;
  checkedAt: number | null;
};

export type MediaRawHealth = {
  state: "not-configured" | "stopped" | "running" | "starting" | "unmanaged" | "error" | "degraded";
  peers?: Array<{ connected: boolean; paused: boolean }>;
  folders?: Array<{ paused: boolean }>;
  completion?: number | null;
  needBytes?: number | null;
  remoteNeedBytes?: number | null;
  remoteVerified?: boolean;
  checkedAt?: number | null;
  detail?: string;
};

function finiteNonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : null;
}

export function formatByteCount(bytes: number | null): string {
  if (bytes === null) return "不明";
  if (!Number.isFinite(bytes) || bytes < 0) return "不明";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  const rank = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / (1024 ** (rank + 1))).toFixed(1)} ${units[rank]}`;
}

export function deriveMediaHealth(raw: MediaRawHealth): MediaHealth {
  const peers = raw.peers ?? [];
  const folders = raw.folders ?? [];
  const peerCount = peers.length;
  const connectedPeers = peers.filter((peer) => peer.connected).length;
  const folderCount = folders.length;
  const needBytes = finiteNonnegative(raw.needBytes);
  const completion = finiteNonnegative(raw.completion);
  const remoteNeed = finiteNonnegative(raw.remoteNeedBytes);
  // "Total pending bytes" is only a total when both directions are verified.
  // Never present the local 0 B as a complete total while the peer is unknown.
  const aggregateNeed = raw.remoteVerified === true && needBytes !== null &&
    remoteNeed !== null ? needBytes + remoteNeed : null;
  const common = {
    connectedPeers, peerCount, folderCount,
    needBytes: aggregateNeed,
    completion: completion === null ? null : Math.min(100, completion),
    checkedAt: raw.checkedAt ?? null,
  };
  const result = (kind: MediaHealthKind, label: string, explanation: string): MediaHealth =>
    ({ ...common, kind, label, explanation });

  if (raw.state === "not-configured") {
    return result("setup", "未設定", "Syncthingを導入し、実行ファイルを指定してください。IGNISの編集機能は引き続き利用できます。");
  }
  if (raw.state === "unmanaged") {
    return result("blocked", "確認できないサービス", "ローカルAPIが別のプロセスを指しているか、資格情報が一致しません。安全のため操作しません。");
  }
  if (raw.state === "starting") {
    return result("connecting", "起動中", "Syncthingの初期化と本人確認を行っています。");
  }
  if (raw.state === "stopped") {
    return result("stopped", "停止中", "ローカルのファイルは残っています。再開するまで転送は進みません。");
  }
  if (raw.state === "error") {
    return result("attention", "確認が必要", "Syncthingの起動または制御に失敗しました。設定とローカルログを確認してください。");
  }
  if (raw.state === "degraded") {
    return result("attention", "状態を取得できません", "Syncthingは起動中ですが、同期の進捗を確認できません。完了とは表示しません。");
  }
  if (!folderCount) {
    return result("setup", "同期フォルダ未設定", "Syncthingは起動中ですが、共有フォルダはまだありません。");
  }
  if (!peerCount) {
    return result("setup", "接続先未登録", "共有する相手のデバイスを登録してください。");
  }
  if (peers.some((peer) => peer.paused) || folders.some((folder) => folder.paused)) {
    return result("paused", "一時停止中", "一時停止中のデバイスまたはフォルダがあります。ローカルファイルは保持されます。");
  }
  if (!connectedPeers) {
    return result("offline", "相手はオフライン", "ローカルのファイルは利用可能です。接続が復旧すれば転送が再開します。");
  }
  if ((needBytes !== null && needBytes > 0) ||
      (remoteNeed !== null && remoteNeed > 0)) {
    const explanation = needBytes !== null && needBytes > 0
      ? `このPCで取得待ちのデータが ${formatByteCount(needBytes)} あります。`
      : `相手側で取得待ちのデータが ${formatByteCount(remoteNeed)} あります。`;
    return result("syncing", "同期中", explanation);
  }
  if (connectedPeers < peerCount) {
    return result("attention", "一部の相手がオフライン", `${peerCount}台中${connectedPeers}台に接続中。全デバイスとの同期完了は確認できません。`);
  }
  if (needBytes === 0 && remoteNeed === 0 && raw.remoteVerified === true &&
      completion !== null && completion >= 99.999) {
    return result("synced", "ローカル同期済み", "接続中の相手とのローカルデータ収束を確認しました。別途バックアップは必要です。");
  }
  return result("attention", "同期状態を確認中", "接続されていますが、ファイルの整合性をまだ確認できません。");
}
