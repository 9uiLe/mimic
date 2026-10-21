# モバイルの性能測定を集約する

Moletta は、明示して選んだローカルの数値測定ファイルを読み、条件ごとの記述統計と baseline / candidate 差分を保存します。iOS / Android の操作、測定の実行、実機 UX の良否の判断は案件側または人が担当します。測定が必要な箇所では案件側の計測手段を使い、その出力を取り込みます。

## コマンドと保持範囲

保存には [実行と再開](workflow.md) の `init` が返す RUN を使う。`CORE` は導入された `moletta` 技能の絶対パスへ置き換える。集計・比較の保存だけなら、意図の封印や設計計画・観測の全体検証は不要である。数値処理の成功を製品の性能や成果の合格観測へ読み替えない。

```sh
python3 CORE/scripts/moletta.py metrics summarize RUN \
  --input measurements.csv --format csv
python3 CORE/scripts/moletta.py metrics summarize RUN \
  --input apple-metrics.json --format xcresult-metrics-json --context apple-context.json
python3 CORE/scripts/moletta.py metrics summarize RUN \
  --input app-benchmarkData.json --format android-benchmark-json --context android-context.json
python3 CORE/scripts/moletta.py metrics compare RUN \
  --baseline BASELINE_SUMMARY --candidate CANDIDATE_SUMMARY
```

`RUN/metrics/` に集約または比較 JSON を保存し、保存先とハッシュを表示します。入力のログ本体、個々の測定値、入力ファイルのパスは集約に保存しません。Moletta は入力をコピーせず、ネットワークへ送信しません。集約には元ファイルの SHA-256、バイト数、形式、必要なら context の正規化 JSON の SHA-256 を残します。測定名・端末ラベル・シナリオ・環境の説明は集約に残るので、秘密情報を含めないでください。元の測定値が必要な場合は、利用者が元ファイルを案件側で管理します。ハッシュは入力の一致確認に使えますが、測定の真正性を認証しません。

この集約は匿名化ではありません。ラベルには必要最小限の仮名・合成 ID を使い、集約や比較 JSON も機密情報を含み得るローカル資料として扱います。ハッシュ化した端末 ID も同一端末を関連付けられます。公開配布物へ含めず、外部共有は利用者が明示して選んだ資料・範囲に限ります。選択ファイルと sidecar の末端が symlink の場合は読み取りを拒否します。

共通の入力保護が認証情報によく使われるファイル名と既知の秘密値パターンを拒否します。診断に該当値や入力パスを含めません。この限定的な検査が任意の個人情報・業務上の秘密を検出する保証はありません。

1 入力は最大 16 MiB、100,000 サンプル、1,000 グループです。数値欠落、非数値、NaN / Infinity、空の測定配列、重複 sample ID、不正な行・JSON は入力全体をエラーにします。除外して分母を変えたり、数値文字列を JSON の数値として扱ったりしません。ファイル内に元々記録されなかった試行の存在や、測定器の故障は検出できません。

## 汎用 CSV / JSONL 契約

各行は 1 サンプルです。次のフィールドを過不足なく持たせます。CSV の列順は任意です。JSONL は 1 行 1 オブジェクトで、空行は認めません。

| フィールド | 意味 |
| --- | --- |
| `metric` | 測定対象の名前。異なる定義の指標には異なる名前を使う |
| `unit` | 単位。`ms`、`s`、`bytes` など。自動変換しない |
| `value` | 有限の数値。JSONL では文字列でなく JSON 数値 |
| `sample_id` | 同じ指標・単位・全条件内で一意な試行 ID |
| `platform` | `ios` または `android` |
| `device` | 同じ物理端末・仮想端末を区別できる固定ラベル |
| `device_kind` | iOS は `physical` / `simulator`、Android は `physical` / `emulator` |
| `os_version` | OS の版・ビルド |
| `environment` | build mode、コンパイル方式、温度・電源条件、ネットワーク、測定の前提など比較に必要な条件 |
| `scenario` | 操作、入力、cold / warm 条件などを含む測定シナリオ |
| `build_revision` | 測定したアプリ・対象の版 |
| `collector` | 測定器・ライブラリの名前と版、測定定義を変える設定 |

文字列は空でない 2,048 文字以内の値で、制御文字を認めません。環境の同一性は申告された値の一致を検査します。実環境が同じであると独立に証明するものではありません。

この例の値は契約説明用の合成値であり、実アプリの測定ではありません。

```csv
metric,unit,platform,device,device_kind,os_version,environment,scenario,build_revision,collector,sample_id,value
launch,ms,ios,lab-phone-1,physical,synthetic-os,release-cold-quiet,fixture-launch,fixture-base,fixture-v1,1,100
launch,ms,ios,lab-phone-1,physical,synthetic-os,release-cold-quiet,fixture-launch,fixture-base,fixture-v1,2,120
```

## iOS: xcresulttool の構造化測定出力

[Apple の Xcode 16.3 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-16_3-release-notes) が説明する次のコマンドの JSON を取り込みます。

```sh
xcrun xcresulttool get test-results metrics --path Result.xcresult > apple-metrics.json
xcrun xcresulttool get test-results metrics --schema --schema-version 0.4.0
```

対応形状は `TestWithMetrics` の配列で、`testRuns[].device`、`testRuns[].testPlanConfiguration`、`testRuns[].metrics[].measurements` を使います。測定名は `identifier`、なければ `displayName`、単位は `unitOfMeasurement` です。対象を曖昧にしないため `testIdentifierURL` を必須にし、テスト計画の構成もシナリオに含めます。1 ファイルは 1 端末に限定します。端末名を残し、`deviceId` は SHA-256 に置き換えます。

出力にない OS・実機種別などは sidecar で宣言します。次のフィールドが過不足なく必要です。この例も合成のメタデータです。

```json
{
  "platform": "ios",
  "device_kind": "physical",
  "os_version": "synthetic-os",
  "environment": "release; cold; quiet lab",
  "build_revision": "fixture-base",
  "collector": "Xcode fixture; xcresulttool schema 0.4.0"
}
```

実装時には、ローカルの `xcresulttool version 25115` と `--schema-version 0.4.0` の出力でフィールド形状を確認しました。自動テストの JSON はこの形状に合わせた合成 fixture です。実アプリの `.xcresult` による測定結果や実機統合の確認を意味しません。Xcode の出力契約が変わった場合は、その版の schema を確認して adapter を更新してください。

## Android: AndroidX Benchmark の単一値指標

[Android の Microbenchmark 文書](https://developer.android.com/topic/performance/benchmarking/microbenchmark-write) と [Macrobenchmark 文書](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview) は JSON レポートの出力を説明しています。[AndroidX の公式 BenchmarkData.kt](https://github.com/androidx/androidx/blob/androidx-main/benchmark/benchmark-common/src/main/java/androidx/benchmark/json/BenchmarkData.kt) が定義する `benchmarks[].metrics.<name>.runs` の有限数値配列を使います。提供元の `median` などの集約値から再集約しません。

sidecar は次のフィールドを過不足なく持ちます。単位のない JSON から独自指標の単位を推測しないため、全指標について `units` の明示を必須にします。キー集合が入力指標と一致しなければエラーです。この例は合成値です。

```json
{
  "device": "lab-phone-2",
  "device_kind": "physical",
  "environment": "release; cold; quiet lab",
  "build_revision": "fixture-base",
  "collector": "AndroidX Benchmark fixture-version",
  "units": {"timeToInitialDisplayMs": "ms"}
}
```

`className`、テスト名、`params` をシナリオに、SDK と OS fingerprint を OS 情報に含めます。JSON の `context` 全体のハッシュと `warmupIterations`、`repeatIterations`、`thermalThrottleSleepSeconds` も比較条件に含めるため、ロック状態・コンパイル方式などの差を黙って比較しません。この保守的な条件一致により、測定条件の差があるレポートは比較を拒否することがあります。

`sampledMetrics` のように 1 試行が複数のフレーム値を持つ指標は未対応です。非空の `sampledMetrics` があれば入力全体を拒否します。全フレームの混在、試行間の平均、提供済み percentile の再集約は行いません。必要な場合は案件側で、測定単位と試行の意味を決めた指標を汎用 CSV / JSONL に明示して出力します。

## 統計と比較の意味

`metric`、`unit` と全メタデータが同じサンプルだけを集約します。結果は `count`、算術平均 `mean`、`p50`、`p95`、最小、最大です。percentile は昇順値の位置 `p * (n - 1)` を線形補間します。1 サンプルなら各統計は同じ値です。試行数と分布を含む記述であり、標本の独立性、十分な試行数、統計的有意性を認定しません。

比較は両方の集約が同じ指標・単位・端末・実機種別・OS・環境・シナリオ・collector の集合を持つことを必須にし、`build_revision` だけの差を認めます。片側だけの指標や条件を黙って捨てません。各集約内では比較対象の条件ごとに 1 build に限定します。異なる端末や simulator / emulator の値を実機の値と比較しません。

各統計について `candidate - baseline` と `100 * 差 / abs(baseline)` を返します。baseline が 0 なら割合は `null` です。単位の正規化、良い／悪い方向の推測、回帰の合否、改善原因の断定、UX や機能の正しさの判断は行いません。実機 UX は人の確認に結び付け、性能差の原因は対照を持つ別の実験で検討します。コマンド終了コード 0 は集約処理が完了したことだけを示します。

## 未対応の入力

Instruments の `.trace`、`.xcresult` bundle 自体、Perfetto trace、logcat、自由形式のテキストログ、画像・動画からの数値抽出には対応しません。案件側の正式な出力機能で構造化された測定値にしてから取り込みます。Moletta が任意のプロファイラ出力を理解すると仮定しないでください。

スクロールのカクつきを扱う場合は [滑らかさの検証](scroll-performance.md) を使います。再現操作、hitch 指標、測定区間を先に確認し、XCTest による継続比較と Instruments による原因調査を選びます。必要な観測を得られない状態を 0 や合格へ変換しません。
