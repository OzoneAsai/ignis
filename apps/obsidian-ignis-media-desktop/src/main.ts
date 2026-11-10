import {
  App, FileSystemAdapter, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting,
} from "obsidian";
import * as path from "node:path";
import {
  MobileSyncthingController,
  defaultSettings, privateHomeInsideVault, type MediaOverview, type MobileSettings,
} from "./engine";
import { formatByteCount } from "./health";
import {
  discoverSyncthing, defaultPilotFolder, normalizeFolderId,
} from "./onboarding";
import {
  installOfficialSyncthing, officialInstallDirectory,
  officialSyncthingVersion, supportedOfficialInstall,
} from "./onboarding-installer";
import type { PairingCard } from "../../../packages/syncthing-control/src/pairing-card";
import { inspectStorageCapacity } from "../../../packages/syncthing-control/src/storage-capacity";
import {
  MEDIA_BYPASS_TYPES,
} from "../../../packages/sync-policy/src/media-bypass";

type ConnectorBypassControl = {
  settings: { deviceContentScope?: string };
  connectionSummary?(): { ready: boolean; vaultId: string; deviceId: string };
  setDeviceContentScope?(value: "markdown-only" | "follow-server"): Promise<{
    ok: boolean; message: string;
  }>;
  getDeviceMediaBypassExtensions(): readonly string[];
  getServerMediaBypassExtensions(): readonly string[];
  setDeviceMediaBypassExtensions(value: readonly string[]): Promise<{
    ok: boolean; message: string;
  }>;
  recheckSharingScope(): Promise<{ ok: boolean; message: string }>;
};

function connectorControl(app: App): ConnectorBypassControl | null {
  const candidate = (app as App & {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins?.plugins?.["ignis-connector"] as Partial<ConnectorBypassControl> | undefined;
  return candidate && typeof candidate.getDeviceMediaBypassExtensions === "function" &&
    typeof candidate.getServerMediaBypassExtensions === "function" &&
    typeof candidate.setDeviceMediaBypassExtensions === "function" &&
    typeof candidate.recheckSharingScope === "function" &&
    candidate.settings ? candidate as ConnectorBypassControl : null;
}

export default class IgnisMediaDesktop extends Plugin {
  mediaSettings!: MobileSettings;
  controller!: MobileSyncthingController;
  private statusBar: HTMLElement | null = null;
  private busy = false;

  async onload(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("Ignis Media Desktop requires desktop Obsidian.");
    }
    const stored = (await this.loadData()) as Partial<MobileSettings> | null;
    this.mediaSettings = { ...defaultSettings(), ...(stored || {}) };
    try {
      this.ensurePrivateHome(this.mediaSettings);
      this.controller = new MobileSyncthingController(this.mediaSettings);
    } catch {
      // Invalid historical settings must not break Obsidian or the Yjs connector.
      this.mediaSettings = defaultSettings();
      this.controller = new MobileSyncthingController(this.mediaSettings);
    }
    this.addSettingTab(new IgnisMediaSettings(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("IGNIS Media: 確認中");
    this.addCommand({
      id: "show-syncthing-status",
      name: "Check local Syncthing status",
      callback: () => { void this.refresh(true); },
    });
    this.registerInterval(window.setInterval(() => { void this.refresh(false); }, 30000));
    void this.refresh(false);
    if (this.mediaSettings.autoStart) {
      void this.perform("start");
    }
  }

  async onunload(): Promise<void> {
    try {
      await this.controller.unload();
    } catch {
      new Notice("IGNIS Media: Syncthingの停止を確認できません。転送状態をご確認ください。", 9000);
    }
  }

  async saveSettings(next: MobileSettings): Promise<void> {
    this.ensurePrivateHome(next);
    this.controller.configure(next);
    this.mediaSettings = { ...next };
    // Store only executable/home/port and lifecycle preferences in Vault.
    // The Syncthing API key and enrolled identity stay in the local OS profile.
    await this.saveData(this.mediaSettings);
  }

  private ensurePrivateHome(settings: MobileSettings): void {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter &&
        privateHomeInsideVault(adapter.getBasePath(), settings.homeDir)) {
      throw new Error("Syncthing's private state directory must be outside the Vault.");
    }
  }

  async refresh(notify: boolean): Promise<MediaOverview> {
    const overview = await this.controller.overview();
    const { health } = overview;
    if (this.statusBar) {
      this.statusBar.setText(`IGNIS Media: ${health.label}`);
      this.statusBar.setAttribute("aria-label",
        `IGNIS Media: ${health.label}。 ${health.explanation}`);
    }
    if (notify) {
      new Notice(`${health.label} — ${health.explanation}`, 6500);
    }
    return overview;
  }

  async perform(action: "start" | "stop" | "pause" | "resume"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (action === "stop") {
        // Always fetch fresh transfer state before confirming an interruption.
        const current = await this.controller.overview();
        if (!(await new ConfirmStopModal(this.app, current).confirm())) return;
      }
      if (action === "start") await this.controller.start();
      if (action === "stop") await this.controller.stop();
      if (action === "pause") await this.controller.pause();
      if (action === "resume") await this.controller.resume();
      await this.refresh(true);
    } catch (error) {
      // Do not put potentially sensitive config paths or credentials in Notice.
      new Notice("IGNIS Media: 操作に失敗しました。設定と管理対象インスタンスをご確認ください。", 7000);
    } finally {
      this.busy = false;
    }
  }
}

export class ConfirmStopModal extends Modal {
  private decide: ((value: boolean) => void) | null = null;

  constructor(app: App, private overview: MediaOverview) {
    super(app);
  }

  confirm(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => { this.decide = resolve; });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Syncthingを停止しますか？" });
    const remaining = this.overview.health.needBytes;
    contentEl.createEl("p", {
      text: remaining !== null && remaining > 0
        ? `未転送データが約${formatByteCount(remaining)}あります。転送は中断し、次回起動後に再開します。`
        : "ローカルのファイルは削除されませんが、停止中は複製が進みません。",
    });
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("キャンセル").onClick(() => this.finish(false))
    ).addButton((button) =>
      button.setButtonText("停止する").setWarning().onClick(() => this.finish(true))
    );
  }

  private finish(value: boolean): void {
    this.decide?.(value);
    this.decide = null;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide?.(false);
    this.decide = null;
  }
}

export class IgnisMediaSettings extends PluginSettingTab {
  private poll: number | null = null;
  private draft: MobileSettings | null = null;
  private installAbort: AbortController | null = null;
  // The settings panel is a short-lived view. A request which began under
  // an older view cannot mutate a newly displayed panel (or a hidden one).
  private viewEpoch = 0;
  private refreshPending: Promise<void> | null = null;

  constructor(app: App, private plugin: IgnisMediaDesktop) {
    super(app, plugin);
  }

  hide(): void {
    this.viewEpoch++;
    this.refreshPending = null;
    if (this.poll !== null) window.clearInterval(this.poll);
    this.poll = null;
    this.installAbort?.abort();
    this.installAbort = null;
    super.hide();
  }

  display(): void {
    const epoch = ++this.viewEpoch;
    this.refreshPending = null;
    if (this.poll !== null) window.clearInterval(this.poll);
    this.draft = { ...this.plugin.mediaSettings };
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "IGNIS Media — 同期の管理" });
    containerEl.createEl("p", {
      text: "文章はIGNISとYjs、大容量ファイルはSyncthingが担当します。" +
            "Syncthingを導入していなくても、IGNISの編集機能は動作します。",
    });
    const connectorState = containerEl.createEl("p", {
      cls: "ignis-connector-sharing-state",
    });
    connectorState.setAttribute("role", "status");
    connectorState.setAttribute("aria-live", "polite");
    const renderConnectorState = () => {
      const connector = connectorControl(this.app);
      if (!connector) {
        connectorState.setText(
          "IGNIS Syncは未接続です。文書だけを同期する場合はIgnis Connectorを有効にしてください。"
        );
        return;
      }
      const ready = connector.connectionSummary?.().ready === true;
      const localOnly = connector.settings.deviceContentScope === "markdown-only";
      const chosen = connector.getDeviceMediaBypassExtensions();
      const mode = localOnly
        ? "Markdownと選択したファイル形式のみをIGNISで共有"
        : "添付ファイルはサーバーの共有規則に従う";
      connectorState.setText(
        (ready ? "IGNIS Sync接続確認済み" : "IGNIS Sync未認証（接続を確認してください）") +
        " · " + mode + (chosen.length ? "（" + chosen.join(", ") + "）" : "") +
        "。Syncthingは任意で、設定しなくてもこの選択は変わりません。"
      );
    };
    renderConnectorState();
    new Setting(containerEl).setName("添付ファイルをこのPCに保持")
      .setDesc("ON: Markdownと個別に許可した文書だけをIGNIS Syncで転送します。" +
        " OFF: サーバーの共有規則に従います。Syncthingの起動・設定は変更しません。")
      .addToggle((toggle) => toggle
        .setValue(connectorControl(this.app)?.settings.deviceContentScope === "markdown-only")
        .onChange(async (enabled) => {
          const connector = connectorControl(this.app);
          if (!connector?.setDeviceContentScope) {
            toggle.setValue(!enabled);
            connectorState.setText(
              "Ignis Connectorを有効にし、接続を確認してから共有範囲を選んでください。"
            );
            return;
          }
          try {
            const result = await connector.setDeviceContentScope(
              enabled ? "markdown-only" : "follow-server"
            );
            if (!result.ok) toggle.setValue(!enabled);
            renderConnectorState();
            if (!result.ok) connectorState.setText(result.message);
          } catch {
            toggle.setValue(!enabled);
            connectorState.setText(
              "共有設定を保存できませんでした。前の設定を維持しています。"
            );
          }
        }));
    new Setting(containerEl).setName("Ignis Connectorの接続を確認")
      .setDesc("サーバーとの接続、共有許可、送信対象の詳細を確認します。")
      .addButton((button) => button.setButtonText("Connectorを開く")
        .onClick(() => {
          const settings = (this.app as App & {
            setting?: { open(): void; openTabById?(id: string): void };
          }).setting;
          settings?.open();
          settings?.openTabById?.("ignis-connector");
        }));
    const bypass = containerEl.createEl("details", {
      cls: "ignis-media-bypass-settings",
    });
    bypass.createEl("summary", { text: "PDFs and media Bypass" });
    bypass.createEl("p", {
      text: "個別に選んだ種類だけ、Syncthingの起動状態に関係なくIGNIS Connectorで" +
        "転送します（1ファイル4 MiBまで）。Mac側のSync管理者が許可した種類に" +
        "限ります。添付全体を共有しないモードでも、文書だけを選べます。",
      cls: "setting-item-description",
    });
    const bypassStatus = bypass.createEl("p", {
      cls: "ignis-media-bypass-status",
      text: connectorControl(this.app) ?
        "実行中のIgnis Connectorの設定と連動します。" :
        "Ignis Connectorが読み込まれていません。先に有効化してください。",
    });
    bypassStatus.setAttribute("role", "status");
    bypassStatus.setAttribute("aria-live", "polite");
    new Setting(bypass).setName("サーバー許可を確認")
      .setDesc("Connectorの接続済みVaultの共有規則を読み直します。Syncthingには触れません。")
      .addButton((button) => button.setButtonText("Recheck").onClick(async () => {
        const connector = connectorControl(this.app);
        if (!connector) {
          bypassStatus.textContent = "Ignis Connectorを先に有効化してください。";
          return;
        }
        const result = await connector.recheckSharingScope();
        bypassStatus.textContent = result.message;
        renderConnectorState();
      }));
    for (const extension of MEDIA_BYPASS_TYPES) {
      new Setting(bypass).setName("." + extension)
        .addToggle((toggle) => {
          toggle.setValue(connectorControl(this.app)
            ?.getDeviceMediaBypassExtensions().includes(extension) || false);
          toggle.onChange(async (selected) => {
            const connector = connectorControl(this.app);
            if (!connector) {
              toggle.setValue(!selected);
              bypassStatus.textContent = "Ignis Connectorを先に有効化してください。";
              return;
            }
            const current = connector.getDeviceMediaBypassExtensions();
            const next = selected ? [...current, extension] :
              current.filter((item) => item !== extension);
            const result = await connector.setDeviceMediaBypassExtensions(next);
            if (!result.ok) toggle.setValue(!selected);
            bypassStatus.textContent = result.message;
            renderConnectorState();
          });
        });
    }

    const onboarding = containerEl.createEl("details", { cls: "ignis-media-onboarding" });
    const onboardingSummary = onboarding.createEl("summary", {
      text: "初回セットアップ（必要なときに開く）",
    });
    onboarding.open = true;
    let firstStatus = true;
    onboarding.createEl("p", {
      cls: "setting-item-description",
      text: "本体を用意 → このPCで起動 → Macを登録 → 空の検証フォルダを共有。既存Vaultは変更しません。",
    });
    const currentStep = onboarding.createEl("p", {
      cls: "setting-item-description", text: "現在の手順を確認しています...",
    });
    const discoveryMessage = onboarding.createEl("p", { cls: "setting-item-description" });
    const installStep = new Setting(onboarding)
      .setName("① Syncthingを用意する")
      .setDesc("インストール済みのSyncthingを自動で探します。検出だけでは起動しません。");
    installStep.addButton((button) => button.setButtonText("自動検出").onClick(async () => {
      button.setDisabled(true);
      try {
        const found = await discoverSyncthing({
          candidates: this.draft!.executablePath ? [this.draft!.executablePath] : [],
        });
        if (!found.length) {
          discoveryMessage.setText("見つかりませんでした。公式配布ページから導入するか、詳細設定で実行ファイルを指定してください。");
          return;
        }
        this.draft!.executablePath = found[0].executablePath;
        executableInput?.setValue(found[0].executablePath);
        markDirty();
        discoveryMessage.setText(
          `検出済み: ${found[0].executablePath}（ほか${found.length - 1}件）。保存して起動できます。`
        );
      } catch {
        discoveryMessage.setText("検出できませんでした。実行ファイルの場所を手動で指定できます。");
      } finally {
        button.setDisabled(false);
        await refreshOverview();
      }
    }));
    installStep.addButton((button) =>
      button.setButtonText("公式ダウンロード").onClick(() =>
        window.open("https://syncthing.net/downloads/", "_blank", "noopener,noreferrer")
      )
    );
    let installButton: { setDisabled(value: boolean): unknown } | null = null;
    installStep.addButton((button) => {
      installButton = button;
      button.setButtonText(`v${officialSyncthingVersion()}を自動導入`);
      button.setDisabled(!supportedOfficialInstall());
      button.onClick(async () => {
        button.setDisabled(true);
        const abort = new AbortController();
        this.installAbort = abort;
        let lastProgress = 0;
        try {
          const draft = { ...this.draft! };
          const adapter = this.app.vault.adapter;
          if (!(adapter instanceof FileSystemAdapter) ||
              privateHomeInsideVault(adapter.getBasePath(), draft.homeDir) ||
              privateHomeInsideVault(adapter.getBasePath(),
                officialInstallDirectory(draft.homeDir))) {
            throw new Error("Vaultの外に保存先を設定してください。");
          }
          discoveryMessage.setText("公式配布物をダウンロードし、SHA-256で検証しています...");
          const executablePath = await installOfficialSyncthing({
            homeDir: draft.homeDir,
            signal: abort.signal,
            onProgress: ({ bytes, total }) => {
              const now = Date.now();
              if (now - lastProgress < 250) return;
              lastProgress = now;
              const progress = total ? `${Math.min(100, Math.floor(bytes / total * 100))}%` :
                formatByteCount(bytes);
              discoveryMessage.setText(`公式配布物を受信中: ${progress}。検証が完了するまで起動しません。`);
            },
          });
          if (abort.signal.aborted) return;
          this.draft!.executablePath = executablePath;
          executableInput?.setValue(executablePath);
          markDirty();
          discoveryMessage.setText("SHA-256の確認が完了しました。次は「設定を保存して起動」を押してください。");
        } catch (error) {
          discoveryMessage.setText(abort.signal.aborted
            ? "自動導入を中止しました。"
            : error instanceof Error && error.message.includes("Vault")
              ? "秘密情報と実行ファイルは、Vaultの外に保存してください。"
              : "自動導入できませんでした。ネットワークと空き容量を確認するか、公式配布ページをご利用ください。");
        } finally {
          if (this.installAbort === abort) this.installAbort = null;
          await refreshOverview();
        }
      });
    });

    const startStep = new Setting(onboarding)
      .setName("② このPCで起動する")
      .setDesc("専用ホームとローカルAPIを使います。既存のSyncthing設定には干渉しません。");
    let quickStart: { setDisabled(value: boolean): unknown } | null = null;
    startStep.addButton((button) => {
      quickStart = button;
      button.setButtonText("設定を保存して起動").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.saveSettings({ ...this.draft! });
          await this.plugin.perform("start");
          pending.setText("設定を保存しました。");
        } catch {
          new Notice("起動準備に失敗しました。保存先・ポート・実行ファイルを確認してください。", 7000);
        } finally {
          // Refresh owns the final enabled/disabled state: an async operation
          // must not re-enable a control after the service becomes running.
          await refreshOverview();
        }
      });
    });

    const pairStep = onboarding.createDiv({ cls: "ignis-media-pairing" });
    pairStep.createEl("h4", { text: "③ Macを登録する" });
    pairStep.createEl("p", {
      cls: "setting-item-description",
      text: "Macで発行した接続カードを貼り付ける方法がおすすめです。Mac側が未対応なら手動入力もできます。",
    });
    pairStep.createEl("p", {
      cls: "setting-item-description",
      text: "接続カードはDevice ID・接続先・共有IDをまとめた文字列です。秘密鍵ではなく、発行元の本人確認にもならないため、相手のDevice IDを照合してください。",
    });
    const importedCard = pairStep.createEl("textarea");
    importedCard.setAttribute("aria-label", "Macから受け取った接続カード");
    importedCard.placeholder = "IGNIS-PAIR1...";
    importedCard.rows = 3;
    importedCard.style.width = "100%";
    let verifiedCard: PairingCard | null = null;
    const pairingPreview = pairStep.createEl("p", {
      cls: "setting-item-description",
      text: "Macのカードを貼り付けてから「内容を確認」を押してください。",
    });
    let confirmCardButton: { setDisabled(value: boolean): unknown } | null = null;
    importedCard.addEventListener("input", () => {
      verifiedCard = null;
      confirmCardButton?.setDisabled(true);
      pairingPreview.setText("変更されたカードの内容を再確認してください。");
    });
    new Setting(pairStep).setName("Macの接続カード")
      .addButton((button) => button.setButtonText("内容を確認").onClick(() => {
        try {
          verifiedCard = this.plugin.controller.previewPairingCard(importedCard.value);
          pairingPreview.setText(
            `接続先: ${verifiedCard.name} / ${verifiedCard.address} / Device ID: ${verifiedCard.deviceId} / 共有ID: ${verifiedCard.folderId}。相手の情報と一致するか確認してください。`
          );
          confirmCardButton?.setDisabled(false);
        } catch {
          verifiedCard = null;
          confirmCardButton?.setDisabled(true);
          pairingPreview.setText("カードが壊れているか期限切れです。Mac側から新しいカードを受け取ってください。");
        }
      }))
      .addButton((button) => {
        confirmCardButton = button;
        button.setButtonText("確認してMacを追加").setCta().setDisabled(true).onClick(async () => {
          if (!verifiedCard) return;
          button.setDisabled(true);
          try {
            const card = this.plugin.controller.previewPairingCard(importedCard.value);
            if (card.deviceId !== verifiedCard.deviceId ||
                card.address !== verifiedCard.address ||
                card.folderId !== verifiedCard.folderId) {
              throw new Error("Pairing card changed during confirmation");
            }
            const result = await this.plugin.controller.importPairingCard(importedCard.value);
            pilotId = result.peer.folderId;
            pilotInput?.setValue(pilotId);
            pairFeedback.setText(result.alreadyPresent
              ? "Macは登録済みです。共有IDを検証フォルダ欄に反映しました。"
              : "Macを登録しました。Mac側にもこのPCのDevice IDを登録してください。");
          } catch {
            pairFeedback.setText("登録できませんでした。相手のDevice IDとカードの有効期限、接続状態を確認してください。");
          } finally {
            verifiedCard = null;
            confirmCardButton?.setDisabled(true);
            await refreshOverview();
          }
        });
      });

    const ownCard = pairStep.createEl("details", { cls: "ignis-media-own-card" });
    ownCard.createEl("summary", { text: "このPCの接続カードを発行する（Macへ渡す）" });
    ownCard.createEl("p", {
      cls: "setting-item-description",
      text: "Tailnet IPとSyncthingのTCPポートが一意に検出できれば自動入力します。できない場合は、下の欄に入力してください。",
    });
    let ownAddress = "";
    new Setting(ownCard).setName("このPCのTailnetアドレス（必要な場合）")
      .addText((text) => text.setPlaceholder("100.x.y.z:22020").onChange((value) => {
        ownAddress = value;
      }));
    const ownCardMessage = ownCard.createEl("p", { cls: "setting-item-description" });
    new Setting(ownCard).setName("このPCの接続カード")
      .addButton((button) => button.setButtonText("カードをコピー").onClick(async () => {
        try {
          const card = await this.plugin.controller.makeLocalPairingCard({
            address: ownAddress || undefined, folderId: pilotId,
          });
          await navigator.clipboard.writeText(card);
          ownCardMessage.setText("接続カードをコピーしました。Mac側で内容を確認してから登録してください。有効期限は24時間です。");
        } catch {
          ownCardMessage.setText("カードを発行できません。Tailnet IPとSyncthingのTCP待受ポートを確認してください。");
        }
      }));

    const manualPairing = pairStep.createEl("details", { cls: "ignis-media-manual-pairing" });
    manualPairing.createEl("summary", { text: "手動でMacのDevice IDとアドレスを入力する" });
    let peerName = "固定Mac";
    let peerId = "";
    let peerAddress = "";
    new Setting(manualPairing).setName("Macの名前")
      .addText((text) => text.setValue(peerName).onChange((value) => { peerName = value; }));
    new Setting(manualPairing).setName("MacのDevice ID")
      .setDesc("MacのSyncthing設定画面からコピーできます。")
      .addText((text) => text.setPlaceholder("AAAAAAA-BBBBBBB-...").onChange((value) => {
        peerId = value;
      }));
    new Setting(manualPairing).setName("MacのTailnetアドレス")
      .setDesc("IPまたはMagicDNS名。例: 100.x.y.z / mac.example.ts.net。既定のTCP 22020番へ接続します。")
      .addText((text) => text.setPlaceholder("100.x.y.z または mac.example.ts.net").onChange((value) => {
        peerAddress = value;
      }));
    const pairFeedback = pairStep.createEl("p", { cls: "setting-item-description" });
    let pairButton: { setDisabled(value: boolean): unknown } | null = null;
    new Setting(manualPairing).setName("Macの登録")
      .addButton((button) => {
        pairButton = button;
        button.setButtonText("Macを追加").onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.plugin.controller.registerPeer({
              deviceId: peerId, name: peerName, address: peerAddress,
            });
            pairFeedback.setText(result.alreadyPresent
              ? "Macは既に登録されています。共有フォルダの設定へ進めます。"
              : "Macを登録しました。Mac側にも、このPCのDevice IDを登録してください。");
          } catch (error) {
            pairFeedback.setText(error instanceof Error && (
              error.message.startsWith("接続先") ||
              error.message.includes("Device ID") ||
              error.message.includes("名前")
            ) ? error.message : "登録できません。Device ID、接続先、Syncthingの状態を確認してください。");
          } finally {
            await refreshOverview();
          }
        });
      });
    pairStep.createEl("p", {
      cls: "setting-item-description",
      text: "相手を登録しただけでは通信できません。Mac側でもSLSを承認する必要があります。",
    });

    const shareStep = onboarding.createDiv({ cls: "ignis-media-share-step" });
    shareStep.createEl("h4", { text: "④ 空の検証フォルダを共有する" });
    shareStep.createEl("p", {
      cls: "setting-item-description",
      text: "既存の動画・Markdownは対象外です。専用の空フォルダを作り、Mac側でも同じ共有IDを登録します。",
    });
    let pilotId = "ignis-media-pilot";
    const pilotPath = defaultPilotFolder();
    let selectedPeerId = "";
    const peerSelect = shareStep.createEl("select");
    peerSelect.setAttribute("aria-label", "共有先デバイス");
    peerSelect.addEventListener("change", () => { selectedPeerId = peerSelect.value; });
    let pilotInput: { setValue(value: string): unknown } | null = null;
    new Setting(shareStep).setName("共有ID（Macと同じ値）")
      .addText((text) => {
        pilotInput = text;
        text.setValue(pilotId).onChange((value) => { pilotId = value; });
      });
    shareStep.createEl("p", {
      cls: "setting-item-description", text: `保存先: ${pilotPath}（Vaultの外）`,
    });
    const shareFeedback = shareStep.createEl("p", { cls: "setting-item-description" });
    let createPilotButton: { setDisabled(value: boolean): unknown } | null = null;
    new Setting(shareStep).setName("検証フォルダ")
      .addButton((button) => {
        createPilotButton = button;
        button.setButtonText("空のフォルダを共有").onClick(async () => {
          button.setDisabled(true);
          try {
            const adapter = this.app.vault.adapter;
            if (!(adapter instanceof FileSystemAdapter)) {
              throw new Error("Desktop Vault path is unavailable.");
            }
            const folderId = normalizeFolderId(pilotId);
            const capacity = await inspectStorageCapacity(path.dirname(pilotPath));
            if (capacity.constrained) {
              shareFeedback.setText(
                `ディスクの空き容量が${formatByteCount(capacity.availableBytes)}です。新しい共有には少なくとも2 GiBの余裕を確保してください。同期は開始しません。`
              );
              return;
            }
            await this.plugin.controller.createPilotShare({
              folderId, folderPath: pilotPath,
              peerDeviceId: selectedPeerId, vaultPath: adapter.getBasePath(),
            });
            shareFeedback.setText("検証フォルダを登録しました。Mac側で同じ共有IDを登録すると転送できます。");
          } catch {
            shareFeedback.setText("共有できません。Macの登録、共有ID、空の専用フォルダを確認してください。既存ファイルは変更しません。");
          } finally {
            await refreshOverview();
          }
        });
      });

    const summary = containerEl.createDiv({ cls: "ignis-media-health" });
    const headline = summary.createEl("h3", { text: "確認中..." });
    // Announce real state transitions, not every 15-second details refresh.
    headline.setAttribute("role", "status");
    headline.setAttribute("aria-live", "polite");
    const explanation = summary.createEl("p", { text: "接続状況を確認しています。" });
    const details = summary.createEl("p", { cls: "setting-item-description" });
    const device = summary.createEl("p", { cls: "setting-item-description" });
    const statusEl = summary.createEl("p", { cls: "setting-item-description" });
    const peerPanel = containerEl.createDiv({ cls: "ignis-media-peers" });
    peerPanel.createEl("h4", { text: "接続先デバイス" });
    const peerSummary = peerPanel.createEl("p", { text: "確認中..." });
    const folderPanel = containerEl.createDiv({ cls: "ignis-media-folders" });
    folderPanel.createEl("h4", { text: "共有フォルダ" });
    const folderSummary = folderPanel.createEl("p", { text: "確認中..." });

    new Setting(containerEl).setName("このPCのDevice ID")
      .setDesc("固定Mac側への登録に使います。Device ID自体は秘密鍵ではありません。")
      .addButton((button) => button.setButtonText("IDをコピー").onClick(async () => {
        try {
          const result = await this.plugin.refresh(false);
          if (!result.status.deviceId) {
            new Notice("Device IDはまだ取得できません。まずSyncthingを起動してください。");
            return;
          }
          await navigator.clipboard.writeText(result.status.deviceId);
          new Notice("Device IDをコピーしました。");
        } catch {
          new Notice("コピーできません。画面に表示されたDevice IDを使用してください。");
        }
      }));

    const controls = new Setting(containerEl).setName("転送エンジン");
    const actions = new Map<string, { setDisabled(disabled: boolean): unknown }>();
    for (const [label, action] of [
      ["起動・再接続", "start"], ["停止", "stop"],
      ["一時停止", "pause"], ["再開", "resume"],
    ] as const) {
      controls.addButton((button) => {
        button.setButtonText(label).onClick(async () => {
          button.setDisabled(true);
          await this.plugin.perform(action);
          await refreshOverview();
        });
        actions.set(action, button);
      });
    }

    const refreshOverview = (): Promise<void> => {
      // Multiple callers may request the same snapshot (timer, manual status
      // refresh, pairing completion). Render it exactly once per view.
      if (this.refreshPending) return this.refreshPending;
      const work = (async () => {
        try {
          const result = await this.plugin.refresh(false);
          if (epoch !== this.viewEpoch) return;
        const { health, status } = result;
        if (firstStatus) {
          firstStatus = false;
          // Two independent sharing engines: choosing local-only attachments
          // is a complete Connector workflow, not an obligation to install
          // Syncthing. The large-media wizard remains available on demand.
          const connectorOnly = connectorControl(this.app)
            ?.settings.deviceContentScope === "markdown-only";
          onboarding.open = health.kind !== "synced" && !connectorOnly;
        }
        onboardingSummary.setText(health.kind === "synced"
          ? "セットアップ完了（再設定する場合は開く）"
          : "初回セットアップ（手順を確認・再開）");
        if (headline.textContent !== health.label) headline.setText(health.label);
        explanation.setText(health.explanation);
        details.setText(
          `接続中: ${health.connectedPeers}/${health.peerCount}台  ·  ` +
          `共有フォルダ: ${health.folderCount}  ·  ` +
          `未転送: ${formatByteCount(health.needBytes)}`
        );
        device.setText(status.deviceId ?
          `このPCのDevice ID: ${status.deviceId}` :
          "Device ID: 未確認（Syncthingを起動してから表示されます）");
        peerSummary.setText(result.peers.length
          ? result.peers.map((peer) => {
              const connection = peer.paused ? "一時停止" :
                peer.connected ? "接続中" : "オフライン";
              return `${peer.name}（${connection}）`;
            }).join("、")
          : "共有先のデバイスはまだありません。");
        folderSummary.setText(result.folders.length
          ? result.folders.map((folder) =>
              `${folder.label}（${folder.paused ? "一時停止" : "共有中"}）`).join("、")
          : "共有フォルダはまだありません。");
        if (health.kind === "synced") {
          currentStep.setText("セットアップ完了。Macと接続し、双方向の同期状態を確認できています。");
        } else if (!this.draft?.executablePath) {
          currentStep.setText("次の操作: ①「自動検出」または「自動導入」を押してください。");
        } else if (status.state !== "running") {
          currentStep.setText("次の操作: ②「設定を保存して起動」を押してください。");
        } else if (!result.peers.length) {
          currentStep.setText("次の操作: ③ Macを登録して、このPCのDevice IDをMac側へ伝えてください。");
        } else if (!result.folders.length) {
          currentStep.setText("次の操作: ④ 空の検証フォルダを共有してください。");
        } else {
          currentStep.setText("セットアップ済み。接続先の承認と同期状況を確認してください。");
        }
        // Keep the first-run screen short. Advanced steps become visible
        // only when their prerequisite has actually been completed.
        pairStep.hidden = status.state !== "running";
        shareStep.hidden = status.state !== "running" || result.peers.length === 0;
        const knownPeers = result.peers;
        const previousSelection = selectedPeerId;
        peerSelect.empty();
        for (const peer of knownPeers) {
          const option = peerSelect.createEl("option", { text: peer.name });
          option.value = peer.deviceId;
        }
        selectedPeerId = knownPeers.some((peer) => peer.deviceId === previousSelection)
          ? previousSelection : (knownPeers[0]?.deviceId ?? "");
        peerSelect.value = selectedPeerId;
        const running = status.state === "running";
        installButton?.setDisabled(running || !supportedOfficialInstall() ||
          this.installAbort !== null);
        quickStart?.setDisabled(running || !this.draft?.executablePath ||
          status.state === "unmanaged" || status.state === "starting");
        pairButton?.setDisabled(!running);
        createPilotButton?.setDisabled(!running || !selectedPeerId ||
          result.folders.some((folder) => folder.id === pilotId.trim()));
        statusEl.setText(health.checkedAt ?
          `確認時刻: ${new Date(health.checkedAt).toLocaleTimeString()}` : "");
        actions.get("start")?.setDisabled(running ||
          status.state === "unmanaged" || status.state === "starting");
        actions.get("stop")?.setDisabled(!running);
        actions.get("pause")?.setDisabled(!running || health.kind === "paused");
        actions.get("resume")?.setDisabled(!running);
        } catch {
          if (epoch !== this.viewEpoch) return;
        headline.setText("状態を確認できません");
        explanation.setText("ローカルの接続設定とSyncthingの動作を確認してください。");
        peerSummary.setText("情報を取得できません。");
        folderSummary.setText("情報を取得できません。");
        currentStep.setText("状態を確認できません。詳細設定を確認してください。");
        pairStep.hidden = true;
        shareStep.hidden = true;
        installButton?.setDisabled(!supportedOfficialInstall() ||
          this.installAbort !== null);
        quickStart?.setDisabled(true);
        pairButton?.setDisabled(true);
        createPilotButton?.setDisabled(true);
        for (const button of actions.values()) button.setDisabled(true);
        }
      })();
      this.refreshPending = work;
      void work.finally(() => {
        if (this.refreshPending === work) this.refreshPending = null;
      });
      return work;
    };
    new Setting(containerEl).setName("状態を更新")
      .setDesc("完了表示には、このPCだけでなく相手側の未転送量も利用します。")
      .addButton((button) => button.setButtonText("更新").onClick(refreshOverview));

    const advanced = containerEl.createEl("details", { cls: "ignis-media-advanced" });
    advanced.createEl("summary", { text: "詳細設定（パス・ポート・常駐動作）" });
    advanced.createEl("p", {
      cls: "setting-item-description",
      text: "通常は初回セットアップだけで利用できます。上級者向けの設定です。",
    });
    const pending = advanced.createEl("p", {
      cls: "setting-item-description",
      text: "変更は「設定を保存」を押したときに反映します。入力途中の値では再起動しません。",
    });
    const markDirty = () => pending.setText("未保存の変更があります。設定を保存してください。");
    let executableInput: { setValue(value: string): unknown } | null = null;
    new Setting(advanced).setName("Syncthing executable")
      .setDesc("Syncthingの実行ファイルへの絶対パス。未設定でも編集機能は動作します。")
      .addText((text) => {
        executableInput = text;
        text.setPlaceholder("C:\\path\\to\\syncthing.exe");
        text.setValue(this.draft!.executablePath);
        text.onChange((value) => {
          this.draft!.executablePath = value.trim();
          markDirty();
        });
      });

    new Setting(advanced).setName("Private Syncthing home")
      .setDesc("秘密鍵と内部データを保存する専用ディレクトリ。必ずVaultの外に配置します。")
      .addText((text) => {
        text.setValue(this.draft!.homeDir);
        text.onChange((value) => {
          this.draft!.homeDir = value.trim();
          markDirty();
        });
      });

    new Setting(advanced).setName("Local GUI/API port")
      .setDesc("127.0.0.1のみを使用します（既定値8386）。")
      .addText((text) => {
        text.setValue(String(this.draft!.guiPort));
        text.onChange((value) => {
          const port = Number(value);
          this.draft!.guiPort = port;
          markDirty();
        });
      });

    new Setting(advanced).setName("Start when Obsidian opens")
      .setDesc("初期状態ではOFF。設定を確認してから有効化してください。")
      .addToggle((toggle) => {
        toggle.setValue(this.draft!.autoStart);
        toggle.onChange((value) => {
          this.draft!.autoStart = value;
          markDirty();
        });
      });

    new Setting(advanced).setName("Stop on plugin unload")
      .setDesc("初期状態ではOFF。ONでも、このセッションが起動したプロセスだけを終了時に停止します。")
      .addToggle((toggle) => {
        toggle.setValue(this.draft!.stopOnUnload);
        toggle.onChange((value) => {
          this.draft!.stopOnUnload = value;
          markDirty();
        });
      });

    new Setting(advanced).setName("設定を保存")
      .setDesc("Syncthingの既存インスタンスを停止せず設定を保存します。")
      .addButton((button) => {
        button.setButtonText("保存").setCta().onClick(async () => {
          try {
            await this.plugin.saveSettings({ ...this.draft! });
            pending.setText("設定を保存しました。");
            new Notice("IGNIS Media: 設定を保存しました。");
            await refreshOverview();
          } catch {
            new Notice("保存できません。絶対パス、ポート番号、Vault外の保存先を確認してください。", 7000);
          }
        });
      });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Syncthingの全量複製はバックアップとは異なります。" +
        "既存Vaultの同期方式を切り替えるには、別途所有権の安全確認が必要です。",
    });
    void refreshOverview();
    this.poll = window.setInterval(() => { void refreshOverview(); }, 15000);
  }
}
