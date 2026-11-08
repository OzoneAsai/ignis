# IGNIS Media Desktop

IGNISのファイル複製を補助する、Obsidianデスクトップ専用のSyncthing管理プラグイン。Markdown共同編集は従来のIGNIS ConnectorとYjsが担当し、このプラグインは独立して導入・無効化できる。SyncthingなしでもIGNISの編集・既存Vault Syncは動作する。

**Markdownだけを共有する場合、このプラグインもSyncthing本体も不要。** IGNIS ServerのVault Syncを `markdown-only` に設定すれば、Connectorがその設定を認識し、写真・動画は端末側に残す。設定方法と既存Vaultからの移行制約は `docs/VAULT_SYNC.md` を参照。

### PDFs and media Bypass（v0.3.2）

設定画面の「PDFs and media Bypass」から、PDF・DOCX・XLSX・PPTXなどの個別形式を選択できる。これは**Syncthingで転送する設定ではない**。有効なIgnis Connectorが、認証済みIGNIS Serverから取得したVault単位の許可リストと、端末側の選択の共通部分だけを通常のVault Syncで送受信する。Syncthingが未設定・停止中でも利用でき、1ファイル4 MiBを超えて転送しない。

サーバー管理者は先にVaultの許可リストを設定する必要がある。Media Desktopでチェックを入れるだけでは、サーバーに未許可の形式を追加できない。Connectorを読み込んでいない場合はボタンに案内を表示し、Syncthingの起動や設定変更は発生しない。保存済みの未送信操作がある場合は、削除や範囲縮小を自動実行しない。バイパス対象が4 MiBを超えた場合、未登録ファイルは同期対象へ載せず、既に追跡中のものは同期台帳を削除扱いにせず409で保留する。

**IGNIS Webで閲覧できるのはPDF**であり、Office文書をブラウザー上で直接編集する機能ではない。PDFは同じVaultのリソースURLを使うプレビューと、新しいタブで開く操作を用意している。

## 現在できること

- Windows/macOSのローカルSyncthingを、独立した秘密情報保存先とループバックAPIに限定して管理。
- 起動、識別済みプロセスへの再接続、状態確認、一時停止、再開、停止（確認ダイアログ付き）。
- デバイス名・接続状態、共有フォルダ、一時停止、ローカル/相手側の未転送量をObsidian設定画面に表示。
- Device IDをコピーしてペアリングに利用。Device ID自体は秘密鍵ではない。
- 未設定・異常・オフラインを区別し、双方の同期状態が不明なときは「同期済み」と断定しない。
- **初回セットアップガイド**（インストール済み実行ファイルの検出、公式バイナリの検証付き自動導入、起動、Macの登録、空フォルダの作成）。利用開始後は折りたたみ、状態表示を優先する。
- **接続カードの交換**（v0.3.0）：MacまたはSLSから24時間有効な端末情報カードを発行し、相手の画面に貼り付けて内容を確認してから登録できる。3つの入力欄は詳細設定に折りたたみ、既存の手動方式も残した。
- **容量不足の事前確認**（v0.3.1）：新しい検証フォルダを登録する前にディスク空き容量を確認する。2 GiB未満の場合は共有を開始せず理由を表示する。これは大容量メディアを複製できる容量を保証するものではない。

## 初回設定

Obsidianの「設定 → コミュニティプラグイン → IGNIS Media Desktop」を開き、最初に表示されるガイドを利用する。

1. **① Syncthingを用意する:** 「自動検出」でPATH、一般的なインストール先、展開済みのダウンロードを探す。見つからなければ「v2.1.7を自動導入」を選べる。GitHubの公式リリースだけをHTTPSで取得し、**固定した公式ZIPと実行ファイルのSHA-256を両方検証**したうえで、ユーザー領域のIGNIS専用ディレクトリへ配置する。既存インストールは上書きしない。対応する自動導入はWindows x64とmacOS arm64。ほかの環境では公式ダウンロードまたは詳細設定の絶対パスを使う。自動検出やダウンロードだけでは実行しない。
2. **② このPCで起動する:** 「設定を保存して起動」を押す。プラグイン専用の状態ディレクトリはデフォルトで**Vault外**、APIは127.0.0.1:8386だけにバインドする。既存の別Syncthingインスタンスのホームを無条件に採用しない。
3. **③ Macを登録する:** Mac側の接続カードを貼り付け「内容を確認」→「確認してMacを追加」と進む。端末名、Device ID、Tailnetアドレス、共有IDが自動で展開される。接続カードを取得できない場合は折りたたみの手動入力で代替可能。チェックディジットはローカルAPIで検証し、既存登録を上書きしない。**Mac側でもこのPCのDevice IDを登録**する必要がある。登録しただけではフォルダは共有されない。
4. **④ 空の検証フォルダを共有する:** 共有先を選び、Macと同じフォルダIDを入力して「空のフォルダを共有」。この操作が作成できるのは、既存VaultやSyncthingの内部領域と重ならない**新規の空フォルダ**だけ。Mac側も同じフォルダIDを登録してから同期を確認する。本番メディアの所有権移行には別途安全な移行手順が必要。

### Macのバックエンド側を用意する

MacではObsidianが起動していなくてもIGNIS ServerのSidecarがSyncthingを扱う。手作業でAPIキー入りのJSONを作らずに済むよう、同じリポジトリの`scripts/ignis-media-pair.mjs`から設定できる。**Syncthing本体は別途起動済みであること**、また`DATA_ROOT`はVault外に置くことが前提。

```bash
# 既に起動済みのSyncthingを選び、Device IDと専用データ領域を確認して登録
DATA_ROOT=/path/to/ignis-data node scripts/ignis-media-pair.mjs init --home /path/to/private-syncthing-home --port 8386

# 接続状態を確認して、SLSへ渡すカードを発行する
DATA_ROOT=/path/to/ignis-data node scripts/ignis-media-pair.mjs status
DATA_ROOT=/path/to/ignis-data node scripts/ignis-media-pair.mjs offer --copy

# SLSのObsidian設定画面で発行したカードをMacへ貼り付けて登録する
DATA_ROOT=/path/to/ignis-data node scripts/ignis-media-pair.mjs enroll

# 任意: 両端の登録後、空の検証用フォルダをMacにも追加（明示確認あり）
DATA_ROOT=/path/to/ignis-data node scripts/ignis-media-pair.mjs pilot
```

`init`は`config.xml`からAPIキーを内部的に読むが、端末へ出力せず、Syncthingの状態や既存設定は変更しない。Sidecarの登録ファイルは`DATA_ROOT/plugins/syncthing/syncthing-connection.json`へ排他的に作成し、0600権限で保護する。既存登録があれば上書きせず停止する。端末数が複数の場合は`pilot --peer DEVICE_ID`で共有先を指定できる。

Mac側の検証フォルダは`DATA_ROOT/plugins/syncthing/pilot-media/共有ID`にのみ作られ、既存VaultもSyncthingの設定・DBも共有しない。**Macの空き容量が2 GiB未満なら、新規共有は原則停止**。例外的な空フォルダ試験に限り、容量条件を理解して`--allow-low-space`を付けることができるが、大容量ファイルの複製には使わない。IPCを直接呼ぶ場合も同じ容量確認がかかる。

この管理者コマンドは**1回の操作のためにSidecarを起動し、終了時に停止する**。IGNIS Server本体でSyncthingプラグインを常駐させたい場合は、別途サーバー側の信頼済み管理経路からサーバースコープのプラグインを有効にする必要がある。コマンド実行だけではプラグインの有効状態を変更しない。未認証の公開管理エンドポイントは使用しない。

自動導入先は、プライベートホームの兄弟ディレクトリ内にある`Tools/Syncthing/v2.1.7`。導入の中断、SHA-256不一致、検証不能な既存ファイルでは起動しない。最新版への自動更新は行わない。

Obsidian起動時の自動起動と、プラグイン終了時の停止は初期状態では両方OFF。終了後もSyncthingが残る場合、次回起動時は専用ホームと記録済みDevice IDを照合して接続する。

## 状態表示の意味

- **同期中:** このPCまたは共有先にまだ必要なバイト数がある。
- **ローカル同期済み:** 両側が接続し、各共有フォルダの相手側完了状態が有効で、ローカルに必要なデータもない。
- **相手はオフライン / 一時停止中:** ローカルデータは使用できるが複製は進行しない。
- **状態を取得できません:** APIの応答不足・不整合。最後の値を「同期完了」の保証として表示しない。
- **確認できないサービス:** APIポートに別のプロセスがいるか識別情報が不一致。誤って開始・停止しない。

## 安全上の境界

- このプラグインは通常Vaultのファイル所有権を勝手にSyncthingへ移さない。IGNIS側のPathOwner事前診断と、両端の変更履歴の移行手順が完成するまでは既存Vaultを同期対象にしない。
- 「同期済み」は**バックアップ成功**を意味しない。誤削除も同期され得るため、別の履歴保存手段を用意する。
- SyncthingのAPIキーはObsidianのdata.jsonへ書き込まず、Vault外のローカル設定から読み込む。
- 接続カードに含まれるのは公開Device ID・端末名・TCP接続先・共有フォルダIDと有効期限だけ。**チェックサムは貼り付け間違いの検知であり、暗号署名でも本人確認でもない**。受け取った端末IDを信頼できる別経路で照合する。カードにはAPIキー・秘密鍵・ユーザーのファイル内容を含めない。カードを取り込んでもフォルダは自動共有しない。
- Mac側のIGNIS Server Syncthing Sidecarにも同じカードを作成する`pairingCard`、カードを登録する`importPairingCard`の内部RPCを追加した。どちらも既存の信頼済みバックエンド呼び出し専用であり、公開の`/api/plugins`管理APIは増やさない。双方の登録が完了してもファイル共有は自動有効化されず、従来の空フォルダ確認が別途必要。
- Mac側には信頼済みIPCの`createPilotShare`と読み取り専用の`listPeers`もある。空フォルダ作成は権限付き管理者操作でのみ行い、重複した同じ設定は無変更で返す。HTTP APIの応答が途中で途切れた場合も、次回は設定を再照合してから再実行する。通常のHTTP公開管理エンドポイントは増やさない。
- 自動インストールで実行することは、**ボタンによる明示操作の後、検証済みのバイナリを配置することまで**。ネットワークから取得した任意のスクリプト、パッケージマネージャーやシェルインストーラは実行しない。
- 固定Macのサービス管理はIGNIS Server側のSidecarが担当する。macOSの常駐サービス登録や本番Vault移行は別の明示操作とする。
- Obsidian GUIでの操作確認、ログイン時からの長期常駐、複数GBの中断再開と容量不足の実機検証は今後の受入項目。

## 開発

ルートディレクトリから次を実行する。

- npm run typecheck --workspace @ignis/obsidian-media-desktop
- npm run build --workspace @ignis/obsidian-media-desktop
- npx vitest run apps/obsidian-ignis-media-desktop/src

出力はdist/main.jsとdist/manifest.json。Obsidianプラグインディレクトリへ配置する際は、既存設定と本番Vaultを上書きしない。
