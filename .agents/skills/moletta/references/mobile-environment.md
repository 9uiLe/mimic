# 並列作業のモバイル環境

同じ Mac／Linux ユーザーで動く作業は、インストール済み OS を共有し、端末の可変データを作業ごとに分ける。実機、常用の Simulator、既存 AVD を借用せず、使い終わった専用端末を必ず解放する。

## 割当てと実行

CLI の場所を `MOLETTA`、初期化済みの作業記録を `RUN` として示す。

割当を使う場合だけ、[実行と再開](workflow.md) の `init` で保存先を用意する。端末 receipt の保存だけに意図の封印や設計計画は不要である。構造化観測も保存する場合は、その計画・観測契約を別に満たす。どちらも所有・回収は必須で、未解放を完了扱いにしない。

```sh
python3 "$MOLETTA" device inspect ios
python3 "$MOLETTA" device inspect android --sdk /absolute/path/to/Android/sdk
python3 "$MOLETTA" device allocate "$RUN" --platform ios \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-VERSION \
  --device-type com.apple.CoreSimulator.SimDeviceType.DEVICE
python3 "$MOLETTA" device allocate "$RUN" --platform android \
  --runtime 'system-images;android-API;VARIANT;ARCH' \
  --device-type DEVICE --sdk /absolute/path/to/Android/sdk
python3 "$MOLETTA" device status "$RUN"
python3 "$MOLETTA" device release "$RUN" --lease LEASE_ID
```

`inspect` の結果から明示した runtime、device type を選ぶ。Android の機種一覧は `device_types_raw` にホストツールの一覧として返る。存在しない OS を選んでも、Moletta はダウンロード、ライセンス同意、SDK 導入を行わない。不足する実行能力は、現環境では未確認として計画へ戻す。

割当ては端末の作成まで。起動済み、操作可能、アプリ検証済みを意味しない。返却した `launch_argv` を引数配列として実行し、`launch_env` を実行環境へ追加する。文字列の結合やシェルへの `eval` は使わない。ホストの操作ツールや予算付きコマンド観測で起動し、起動完了と実際の成果は別途確認する。

`destination` は iOS の UDID、Android の `emulator-PORT`。ビルド、インストール、UI 操作も必ずこの識別子を指定する。iOS の `booted`、接続先を省略した `adb`、変更した AVD 名やポートは使わない。

## 共有するものと分けるもの

| 対象 | 共有 | 作業専用 |
| --- | --- | --- |
| iOS | Xcode、利用可能な Simulator runtime | UUID を含む端末名、UDID、CoreSimulator が作る端末データ |
| Android | SDK、インストール済み system image | UUID を含む AVD 名、AVD 定義、可変データ、エミュレータ設定、console／adb のポート対 |

iOS は既定の device set に新しい端末を作る。共有 runtime を削除したり、常用端末を複製したりしない。Xcode の選択は作業中維持する。設定済みの `DEVELOPER_DIR` は receipt の起動環境にも保存する。

Android は `ANDROID_AVD_HOME`、`ANDROID_USER_HOME`、`ANDROID_EMULATOR_HOME` を lease ごとのディレクトリへ向け、`avdmanager create avd` に明示した image と格納先を渡す。OS image を作業ディレクトリへコピーしない。起動引数の `-no-snapshot` で Quick Boot の読み込みと保存を止め、`-no-boot-anim` で起動アニメーションを省く。ユーザーデータのためのディスク領域は必要で、占有量の上限やゼロ消費を保証しない。

現在のアダプターは Xcode の `xcrun simctl` と、Android SDK の `avdmanager`／`emulator`／`adb` を対象にする。Android の公式資料は新しい Android CLI への移行を案内しているが、このアダプターは自動移行や未検証の代替コマンドを実行しない。必要な従来ツールがない場合は能力不足を返す。

## ホスト全体での所有管理

worktree 内だけのロックでは別 worktree の競合を防げないため、同じユーザーの全 worktree が一つの registry と排他ロックを使う。

- macOS: `~/Library/Application Support/moletta/devices`
- Linux: `$XDG_STATE_HOME/moletta/devices`。未設定なら `~/.local/state/moletta/devices`
- 共通の上書き: `MOLETTA_DEVICE_STATE`。管理・テスト用に `--state-dir` も指定できる。

並列作業ごとに別の `--state-dir` を指定しない。各 run の `devices/LEASE_ID.json` に所有 receipt を保存し、registry 側にも同じ lease を残す。receipt は `.moletta-runs/RUN/devices/` の中に置き、Git へ追加しない。Moletta が作る管理ディレクトリは `0700`、管理記録とロックは `0600`。所有 token は同じユーザーの誤操作検出に使い、悪意ある同一ユーザーを認証する仕組みではない。

Android のポートは registry の予約と実際の空き確認を併用する。互いに協調する Moletta 作業の重複割当てを防ぐ。外部のエミュレータが直後にポートを取る競合まで原子的には防げないため、起動失敗は観測して解放する。共通の SDK／adb サーバーまで作業別に複製しない。

## 解放と中断後の回復

正常終了、失敗、時間切れ、作業中断でも `device release` を行う。解放が失敗したら `cleanup_pending` と理由を残し、完了扱いにせず再試行する。端末内のアプリデータを証拠として残す必要があれば、解放前に必要最小限の観測を run の成果物へ保存する。

iOS は registry に記録した UDID と専用名の一致を確認し、その UDID だけを shutdown／delete する。Android はポートが使用中なら、その serial に問い合わせた AVD 名が専用名と一致する場合だけ対象の `emu kill` を送る。プロセスの終了を確認してから、所有 marker が一致する専用ディレクトリだけを削除する。別 AVD、名前の変更、開始途中のプロセス、所有不整合、ツール接続不能では削除を保留する。`shutdown all`、`delete all`、`delete unavailable`、`killall`、`adb kill-server` は実行しない。

端末作成前に所有記録を保存するので、作成途中の失敗は専用名／専用ディレクトリから回収できる。失敗直後に解放を試み、回収できない lease を残す。再開時は `device status RUN` で未解放を確認し、`device release` で回収する。構造化観測の記録が準備済みなら `next` でも未解放の処理を提示する。端末の保存だけの RUN に、`next` のための封印や設計計画を追加しない。

```sh
python3 "$MOLETTA" device gc
python3 "$MOLETTA" device gc --older-than-hours 24 --apply
```

`gc` は既定では候補を表示するだけ。最低経過時間を満たす作成・解放途中の lease と、run receipt が消えた lease だけを対象にする。`--apply` でも同じ所有確認を行い、記録済みの専用端末以外を列挙削除しない。receipt が残る正常な lease は、経過時間や作成コマンドの PID 終了だけでは廃棄しない。放置された intact な run は、その run と lease を明示して `release` する。回収のために registry を消したり、共有 OS を削除したりしない。

## 検証の範囲と根拠

配布テストは一時ディレクトリと偽の実行ファイルで、実際の引数、作成・所有・解放、途中失敗、別 worktree のロック、GC、権限を検査する。ポート使用状況はテスト内で模擬する。実際の iOS／Android の起動、画面操作、ホストごとの tool version 互換性は別の実機検証が必要。

ローカルの Xcode 環境では、導入済み runtime から Moletta 専用の未起動 Simulator を 1 台作成し、その端末だけを解放・削除する確認も行った。既存の端末 ID 集合は前後で変わらなかった。アプリ実行・性能測定・全 Xcode 版の互換性の確認ではない。Android は確認環境に `avdmanager` がなく、実際の AVD 作成・起動・削除は未確認である。

一次資料:

- [Apple: Getting the Most Out of Simulator](https://developer.apple.com/videos/play/wwdc2019/418/) — `simctl` による明示した device type／runtime の端末作成。インストールした Xcode の `xcrun simctl help` でも利用可能な構文を確認する。
- [Android: Start the emulator from the command line](https://developer.android.com/studio/run/emulator-commandline) — 共有される読み取り専用 system directory と、AVD ごとの可変 data directory、明示したポート対、snapshot 無効化。
- [Android: Environment variables](https://developer.android.com/tools/variables) — SDK、エミュレータ設定、AVD の検索先を指定する環境変数。
- [Android: avdmanager](https://developer.android.com/tools/avdmanager) — 既存 SDK package を指定した作成と専用 path。従来ツールの非推奨化と新しい CLI の案内も確認する。
