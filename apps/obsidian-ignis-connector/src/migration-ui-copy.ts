import { mobileUiLanguage } from "../../../packages/server-core/src/mobile-ui-copy";

const strings = {
  ja: {
    eyebrow: "IGNIS / バージョンの保護と移行",
    title: "すべて残して、あとから選ぶ",
    intro: "同じ名前でも、別々に作った文書は別物です。先にすべての版を別名で保存し、" +
      "内容を比べてから移行できます。元のファイルは自動で上書きしません。",
    stages: ["01 · 全版を保存", "02 · 比較", "03 · 決定"],
    count: (issues: number, saved: number) =>
      `${issues}件の確認待ち · ${saved}件を保護済み`,
    saveAll: "すべての版を保存",
    saving: "保存中…",
    initialStatus: "元の文書は変更しません。",
    saveProgress: "別名で保存し、サーバーの確認を待っています…",
    verified: "保存を確認しました。元の文書はそのままです。",
    missingCopies: (count: number) =>
      `${count}件はまだ保存できていません。保存済みの版は保持しています。`,
    noIssues: "確認が必要な文書はありません。",
    listLabel: "確認が必要な文書",
    savedEarlier: "別名の保護コピーがあります",
    preservedPair: "両方の版をサーバーに保存済み",
    preservedLocal: "端末側の版をサーバーに保存済み",
    savingItem: "保存・検証中…",
    needsAttention: "未完了：",
    savedHeading: "別々の名前で保存しました",
    openCopy: "開く",
    saveSelected: "この2つの版を保存",
    verifying: "両方の保存結果を検証しています…",
    original: "元の文書を開く",
    comparisonLabel: "文書のバージョン比較",
    localLabel: "この端末の原稿",
    remoteLabel: "サーバーの原稿",
    loading: "内容を読み込んでいます…",
    localUnavailable: "原稿のプレビューはありません。",
    serverUnavailable: "サーバー側の原稿がありません（またはバイナリファイルです）。",
    previewTruncated: "…プレビューはここまで。全文は保存済みファイルで確認できます。",
    previewFailure: "プレビューに失敗しましたが、元の原稿は保持されています。",
    finishNote: "両方の版を確認したら、元の名前をサーバー版へ切り替えられます。" +
      "端末側の原稿は別名で残ります。切り替える前に元のノートを閉じてください。",
    finish: "両方残して移行する",
    confirm: "確認：元の名前をサーバー版へ切り替える",
    back: "戻る",
    finishProgress: "保存内容と文書世代を再確認しています…",
    finished: "移行完了。両方の保護コピーは残しています。",
    historyTitle: "サーバーの同期履歴を確認できません",
    recheckHistory: "履歴を再確認して同期を再開",
    recheckingHistory: "接続先の同期履歴を照合中…",
    historyRestored: "元の同期履歴を確認しました。同期を再開します。",
  },
  en: {
    eyebrow: "IGNIS / VERSION MIGRATION",
    title: "Keep every version. Decide when ready.",
    intro: "The same filename does not prove the same document. Save every version " +
      "under a distinct name before comparing. Originals are never overwritten automatically.",
    stages: ["01 · Preserve", "02 · Compare", "03 · Decide"],
    count: (issues: number, saved: number) =>
      `${issues} items to review · ${saved} saved version pairs`,
    saveAll: "Save all versions",
    saving: "Saving versions…",
    initialStatus: "Original files are unchanged.",
    saveProgress: "Saving separate copies and verifying server receipts…",
    verified: "Copies verified. Originals remain untouched.",
    missingCopies: (count: number) =>
      `${count} versions still need attention. Completed copies were kept.`,
    noIssues: "No unresolved migrations.",
    listLabel: "Files needing review",
    savedEarlier: "Saved copies available",
    preservedPair: "Both versions saved on server",
    preservedLocal: "Device version saved on server",
    savingItem: "Saving and verifying…",
    needsAttention: "Needs attention: ",
    savedHeading: "Saved as independent files",
    openCopy: "Open",
    saveSelected: "Save separate copies",
    verifying: "Verifying both server copies…",
    original: "Open original",
    comparisonLabel: "Version comparison",
    localLabel: "This device",
    remoteLabel: "Server original",
    loading: "Loading a read-only preview…",
    localUnavailable: "No local text preview available.",
    serverUnavailable: "No server text preview available (missing or binary).",
    previewTruncated: "…Preview truncated; complete versions are preserved.",
    previewFailure: "Preview unavailable. The original draft is still retained.",
    finishNote: "After comparing both copies, use the server version at the original " +
      "filename. The device version remains saved separately. Close the original note first.",
    finish: "Finish with both versions kept",
    confirm: "Confirm: use server version at original name",
    back: "Go back",
    finishProgress: "Rechecking saved bytes and document generation…",
    finished: "Migration completed. Both copies retained.",
    historyTitle: "Server sync history is not verified",
    recheckHistory: "Recheck history and resume sync",
    recheckingHistory: "Comparing the original server history…",
    historyRestored: "Original server history verified. Sync is resuming.",
  }
} as const;

export function migrationUiCopy(language: "ja" | "en" = mobileUiLanguage()) {
  return strings[language];
}

export function migrationReason(reason: string, language: "ja" | "en" = mobileUiLanguage()): string {
  if (language === "en") return reason;
  if (/Existing on both devices/i.test(reason)) return "同じ名前の別文書があります";
  if (/Replaced document generation/i.test(reason)) return "文書の世代が変わっています";
  if (/Live editor blocked/i.test(reason)) return "編集中の履歴が異なるため、原稿を保護中";
  if (/Concurrent edit/i.test(reason)) return "変更が競合しています";
  if (/Server journal identity requires review/i.test(reason)) {
    return "接続先の同期履歴が以前の履歴と一致するか確認できません。端末の原稿は保持中です";
  }
  if (/Open editor has uncommitted or unverified text/i.test(reason)) {
    return "開いているノートに未保存の内容があります。保存後に再同期できます";
  }
  if (/Attachment exceeds preview size limit|Size limit/i.test(reason)) {
    return "ファイルが現在の転送上限（1件4MiB）を超えています。端末側のファイルは保持中です";
  }
  if (/Unsent (?:create|modify|rename|delete)/i.test(reason)) {
    return "サーバーの保存確認がまだありません。端末に変更を保持しています";
  }
  if (/Remote missing|Remote deleted/i.test(reason)) return "サーバー側で削除された可能性があります";
  return reason;
}
