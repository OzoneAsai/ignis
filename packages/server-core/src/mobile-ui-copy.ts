// Obsidian stores its selected language under "language", independently of
// the browser's system locale. Both clients resolve the same preference.
export function mobileUiLanguage(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
  systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language
): "ja" | "en" {
  let configured: string | null = null;
  try { configured = storage?.getItem("language") || null; }
  catch { /* Safari can deny storage in private contexts. */ }
  return /^ja(?:-|$)/i.test(configured || systemLanguage || "en") ? "ja" : "en";
}

const strings = {
  ja: {
    status: "接続・同期",
    upload: "ファイル追加",
    chooseFile: "ファイルを選ぶ",
    people: "参加者・表示名",
    openPeople: "詳細を開く",
    rename: "ファイル名を変更",
    noNote: "現在ノートは開いていません",
    openActions: "接続状態・ファイル追加・参加者を開く",
    connecting: "接続中…",
    joining: "同期接続中…",
    offline: "オフライン",
    unconfigured: "未接続",
    syncing: "同期中…",
    synced: "同期済み",
    serverConnected: "サーバー接続",
    attention: "要確認",
  },
  en: {
    status: "Connection & sync",
    upload: "Add files",
    chooseFile: "Choose files",
    people: "Participants & display name",
    openPeople: "View details",
    rename: "Rename file",
    noNote: "No note open",
    openActions: "Open connection, files & participants",
    connecting: "Connecting…",
    joining: "Connecting to note…",
    offline: "Offline",
    unconfigured: "Not connected",
    syncing: "Syncing…",
    synced: "Synced",
    serverConnected: "Server connected",
    attention: "Needs attention",
  },
} as const;

export type MobileStrings = typeof strings["ja"] | typeof strings["en"];

export function mobileUiCopy(language: "ja" | "en" = mobileUiLanguage()): MobileStrings {
  return strings[language] || strings.en;
}
