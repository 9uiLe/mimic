# 実行記録の契約

Python 3.11 以上。公開 CLI は `scripts/moletta.py`。JSON を標準出力へ返し、不正な入力や拒否した操作は診断を返す。`check` の終了コードは準備条件を満たす場合 0、満たさない場合 1。不正な記録も `INVALID_RUN` の検査結果として 1 を返す。操作の拒否・失敗とコマンド引数の誤りは 2 を返す。

`init [RUN] --brief FILE --goal TEXT [--project PROJECT] [--name NAME]` で開始する。RUN を省略すると、選択した Git worktree のルートに `.moletta-runs/<UTC時刻-作業名-乱数>/` を作る。Git の外では選択したディレクトリを使う。`--name` は RUN 省略時だけ使える。応答の `run` は再開に使う具体的なパス、`workspace` は既定の保存先または null、`gitignore` は `/.moletta-runs/` という規則の確認と案内である。`.gitignore` は変更しない。

`.moletta-runs/README.md` は保存内容と保持方針を説明する。既存の正常な README は上書きしない。作業単位 ID と、journal が持つ `run_id` は別の識別子である。新規開始は既存作業へ合流せず、再開は返された RUN を明示する。

## 所有と状態

| ファイル | 所有者・用途 |
| --- | --- |
| `brief.md` | 保存した原文。封印後は変更しない |
| `intent.json` | 成果・受入条件・必須制約。封印まで編集する |
| `seal.json` | runtime が保存する実行 ID と原文・意図のダイジェスト |
| `plan.json` | エージェントが更新する要求、案、資料、実験、判断、次の行動 |
| `journal.json` | runtime が保存する観測開始・完了・判定の順序付き履歴 |
| `artifacts/` | 観測の出力・添付物、ローカルに保存した出典 |
| `checkpoints/` | 意図・計画と履歴の prefix ダイジェストを含む保存点 |
| `metrics/` | 構造化された性能値の派生集約・比較。元ログ本体は含めない |
| `devices/` | 作業単位が所有する端末 lease の receipt と解放状態 |
| `delegation/policy.json` | 実際に取得したユーザー承認の範囲・期限・予算の申告記録 |
| `delegation/assignments.json` | 担当の予約と一回の使用量記録。文脈本体を含めない |

`init` は既存ディレクトリを拒否する。`seal` は同一内容に対してだけ再実行できる。観測は開始→完了→判定と進み、完了・判定はそれぞれ一回。コマンド取得とホストの出力取り込みは、同じ履歴へ保存する。

端末・集計・予約の保存だけを使う場合も初期化済み RUN を使うが、封印や設計計画は要求しない。[実行と再開](workflow.md) が適用条件を定義する。以下の意図・計画・観測の準備条件は、構造化観測を行う場合の契約である。

構造上の準備状況は計画と履歴から導出する。準備状況の検査結果と判定の応答には `semantic_review_required: true` を含める。

## JSON 入力

`schema_version` は 1。以下の項目は null の場合も省略しない。未知のキー、不正な型、各配列での重複した ID・リンクは拒否する。`init` が生成するテンプレートを、判断に必要な内容で埋める。

```json
{
  "schema_version": 1,
  "outcomes": [{"id": "O1", "statement": "達成したい結果", "acceptance": "観測可能な合格条件"}],
  "constraints": [{"id": "C1", "text": "人が指定した必須制約"}]
}
```

`plan.json` の最上位:

| 項目 | 内容 |
| --- | --- |
| `schema_version` | 1 |
| `target_environment` | 実証対象の環境を識別する文字列 |
| `requirements` | `{id, origin, source_quote, outcome_ids, constraint_ids, criterion}` の配列 |
| `options` | `{id, architecture, contribution, tradeoffs, subject, coverage}` の配列 |
| `notes` | `{id, kind, claim, locator, sha256, outcome_ids, requirement_ids, option_ids}` の配列 |
| `research` | `{question, source_ids, finding, applicability}` の配列 |
| `experiments` | 下記の実験の配列 |
| `review` | 下記のレビュー |
| `decision` | 下記の判断 |
| `next_action` | null または `{kind, question, rationale, timebox_minutes, stop_condition, experiment_id}` |

### 要求、案、出典

- `origin` は `explicit / derived`。明示要求の `source_quote` は原文に存在する文字列、導出要求では null。全案共通の能力を記し、方式固有の実装上の義務を必須要求へ昇格させない。
- `subject` は `{identity, revision, files}`。識別子と版を文字列で記し、入力ファイルをパスの配列で列挙する。相対パスは RUN 基準。runtime は宣言したファイルの SHA-256 を観測開始時と照合する。外部の版と列挙範囲は申告であり、未追跡の依存を自動検出しない。
- `coverage` は `{requirement_id, mechanism, status, evidence_ids}` の配列。全要求の仕組みを説明し、`status` は `supported / unknown / violated`。根拠 ID は対応する note または完了・判定済みの observation を参照する。
- note の `kind` は `source / inference`。source は HTTPS URL と `sha256: null`、または `artifacts/` 内の実在する保存ファイルと SHA-256 を使う。inference は locator・sha256 とも null。推論だけでは supported の証拠にしない。
- `research.source_ids` は source の note を参照し、問い、実際に分かったこと、適用条件を記す。

### 実験とレビュー

実験の全項目は `{id, option_id, outcome_ids, requirement_ids, question, scope, environment, pass_criterion, fail_criterion, retained_conditions, omitted_conditions, negative_control}`。`scope` は `unit / integration / end_to_end`。合否・保持条件・省く条件・否定対照を実行前に定義する。対照が不適用なら理由を記す。

`review` は `{mode, raw_brief_read, findings}`。mode は `pending / independent_context / self_review`、raw_brief_read は boolean。指摘は `{id, severity, issue, disposition, reason}`。severity は `critical / material / minor`、disposition は `open / accepted / rejected / deferred`。reason は未判断なら null、判断した場合は根拠を記す。重要な未解決指摘を採用の確定に残さない。

### 判断と次の行動

`decision` は `{status, option_id, rationale, conditions, reconsider_when}`。status は `exploring / provisional / selected / rejected`、option_id は対象 ID または null。条件は文字列の配列。理由と再考のきっかけを記す。条件付き採用は解消条件を必要とする。

`next_action.kind` は `explore / experiment / review / decide`。時間予算は正の整数の分数。実験を行う場合は experiment_id を指定し、それ以外は null。次の問い、選ぶ理由、終了条件を記す。

## 観測の適用範囲

開始時に、封印した意図、実験、対象案と仕組み、要求、宣言した対象ファイルを保存する。条件・対象・追跡入力が変わった観測を、現在の成功の根拠にはしない。

取得元は `direct_command / attested_native`。直接実行は argv・作業場所・保存可能な出力・終了状態を保存する。取り込みは実際の UTF-8 操作履歴と任意の添付物、観測方法を保存する。取得元の真正性は認証しない。

コマンドの `status` は `completed / timeout / launch_error / output_blocked`。stdout / stderr を各 1 MiB の上限と限定的な入力規則で確認し、保存できない場合は本体の代わりに `output-blocked.txt` を保存する。`output_blocked`、実行不能、timeout は合格判定にできない。終了コードは実行の値を残すため、`output_blocked` と終了コード 0 は両立する。

原文・取り込む transcript・添付物は各 1 MiB までの明示したファイルを使う。選択ファイルの末端 symlink、認証情報によく使われるファイル名、既知の秘密値パターン、不透明な入力を限定検査する。画像などの不透明な添付物を選ぶ `--allow-opaque-artifacts` もサイズ・既知のパターン検査を維持する。検査は任意の機密情報の検出や匿名化ではなく、ホストのファイル・ネットワーク権限を強制しない。[security.md](security.md) が範囲を定義する。

`assess` は合否と理由を追記する。失敗・不明の解消には、後続の別の合格観測を `--resolves` で対応付ける。同じ案・環境・範囲で、元の要求定義と成果を覆うことを確認する。修正に伴う対象の版の変更は認める。完了していない観測や未判定の観測も確認対象とする。

`verify` は選択案について、対象環境の合格観測が全要求を覆うことを求める。成果ごとに、その成果に対応するすべての要求を含む `end_to_end` の合格観測も必要とする。到達だけの全体観測と、変更操作の単体観測を寄せ集めて、一連の成功とは扱わない。未選択案の失敗は選択案の成功を妨げない。未解放の所有端末 lease があれば `DEVICE_CLEANUP_PENDING` を返し、`structural_readiness` を false にする。

## 端末の所有記録

`device allocate RUN` は明示したインストール済み runtime / system image と device type を使い、未起動の Simulator / AVD を作る。OS の共有インストールは変更せず、所有 lease に対応する可変データを分ける。ホストが共有する registry は `MOLETTA_DEVICE_STATE` または `--state-dir` で選べる。既定は macOS では `~/Library/Application Support/moletta/devices`、Linux では `$XDG_STATE_HOME/moletta/devices` または `~/.local/state/moletta/devices`。

receipt は `schema_version`、`lease_id`、`owner_token`、run と registry のパス、platform、runtime、device type、状態、時刻、使用ツール、起動 argv・環境、端末の具体的な識別子を持つ。Android は console / adb port の組も予約する。状態は `creating / allocated / cleanup_pending / released`。registry と receipt の所有情報を照合してから、対象の停止・削除を行う。解放の失敗を成功へ書き換えず、`cleanup_pending` を保持する。

観測後、最終 verify と完了報告の前に解放する。`next` は完了の意味判断へ進む前に未解放 lease を提示する。`device gc` は既定で候補だけを示し、`--apply` で所有確認付きの回収を行う。作成・解放が未完了、または run receipt が消失した古い lease が対象で、存続する作業を経過時間だけでは回収しない。実機 UX の判定はこの記録の外にあり、人が担う。

## 性能の集約・比較記録

`metrics summarize RUN --input FILE --format FORMAT [--context FILE]` は選択した入力から派生 JSON を `metrics/summary-<ID>.json` に保存する。対応形式は `csv / jsonl / xcresult-metrics-json / android-benchmark-json`。`metrics compare RUN --baseline FILE --candidate FILE` は派生比較を `metrics/comparison-<ID>.json` に保存する。応答には保存先、保存ファイルの SHA-256、`raw_input_copied: false` を含む。

summary の `schema_version` は 1、`kind` は `performance_summary`。`source` に元ファイルの SHA-256・サイズ・形式・sidecar の正規化ハッシュを、`groups` に指標・単位・全条件と `count / mean / p50 / p95 / minimum / maximum` を持つ。元ファイルのパス、サンプル ID、測定値の配列は保存しない。入力上限は 16 MiB、100,000 サンプル、1,000 グループ。欠損・非有限数値・重複を黙って除かない。

比較は build revision 以外の条件集合の一致を必要とする。comparison は両 summary のハッシュと出典情報、各統計の差を持ち、baseline が 0 の割合は null とする。形式・統計式・sidecar・未対応入力の正確な契約は [performance.md](performance.md) が所有する。集約があっても実験の合格観測や実機 UX の確認にはならない。

## 担当と予算の記録

`delegation configure / reserve / complete / status` は [adaptive-delegation.md](adaptive-delegation.md) の契約を使う。policy は host、`adaptive / fixed / disabled`、実際のユーザー承認の参照、期限、最大並列数、総 token 予算、役割ごとの許可済みモデル・effort を持つ。未設定時は disabled として現在のホスト設定を維持する。

`reserve` は 24 時間以内の host catalog と許可された選択を照合し、担当の `task_id`、役割、model / effort、token・時間予算、意図して絞った文脈の SHA-256、policy / catalog の SHA-256 を記録する。状態は `reserved / completed`。予約はモデルを起動せず、文脈本体やモデル認証を保存しない。起動・停止と実行上限はホストが担う。

`complete` は報告された `{total_tokens, cost_usd, source}` を一回記録する。使用量不明は null とし、token が不明なら完了後も予約量を予算計算に残す。総費用は全件の費用が分かる場合だけ数値を返し、不明があれば null。既知の費用小計を総費用として扱わない。実際の超過使用量も履歴に残して予算超過を示す。承認、catalog、使用量は申告であり、人の承認やサービス実行の真正性を認証しない。

## 整合性と限界

保存操作は POSIX の advisory lock で直列化し、journal をチェックサム付きで置き換える。書き込み中のプロセスが停止するとロックは自動解放される。`.write.lock` ファイルは削除しない。添付物の変更・欠落や、checkpoint に保存した履歴の書き換え・切り詰めを検出する。これはローカルファイルの誤編集を扱う仕組みであり、利用者が全記録とチェックサムを意図的に書き換えることを防ぐサービスではない。

型や整合性を満たしても、要求の意味上の網羅性、観測方法の妥当性、全体最適は証明できない。原文と観測を読む判断を併用する。
