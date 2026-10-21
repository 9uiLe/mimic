# 実行と再開

## 記録を使う範囲

再開、複数回の実験、対象・条件と証拠の取り違え防止に必要なとき、構造化記録を使う。判断の重要度だけで記録一式を必須にしない。単発の推薦は、原文への参照、必要能力、案と根拠、未知と次の確認を応答や依頼された成果物へ示せる。重要な未知や異論への調査・レビューは、記録の有無とは別に行う。

全経路で、開始状態から必要な操作、観測可能な結果までを確認する。能力不足、対象環境の差、人の逐次操作への依存、権限変更、重大な異論があれば調査・実験・レビューへ戻る。狭く低リスクで成功条件が明確な小変更は、変更と相応の実物確認で完了できる。原文、操作履歴、出力の保存は案件の権限・保存方針に従う。

`CORE` は導入された `moletta` 技能の絶対パス、`RUN` は初期化が返した実行ディレクトリ、`FILE` は実際のファイルへ置き換える。コマンドは主担当エージェントが実行する。記録の形式は [record-format.md](record-format.md)、入力の範囲と保持は [security.md](security.md) を参照する。

## 保存先の初期化

原文と最新の関連発言を読み、[発言の解釈と全体の範囲](intent-and-scope.md) を判断する。成果・必須条件・明示的な実行指示を維持し、提案・願望・将来像は採否を評価する。利用者へ発言ごとの JSON 記入を要求しない。

```sh
python3 CORE/scripts/moletta.py init --brief FILE --goal '達成したい成果' --name '作業名'
```

既定では、現在の Git worktree のルートに `.moletta-runs/<作業単位ID>/` を新規作成する。ID は UTC 時刻・作業名・乱数からなり、同じ依頼を再び開始しても別の記録になる。返された `run` を以後の `RUN` に使う。既存作業の再開時は `init` を使わず、その RUN を指定する。

`.moletta-runs/README.md` が内容と保持方法を説明する。応答の `gitignore` は `/.moletta-runs/` という規則の有無を報告する。必要なら利用者の保存方針に従って追加し、記録をコミット対象から外す。Moletta は `.gitignore` を自動編集しない。linked worktree もそれぞれのルートに記録し、共有 Git directory へ集約しない。

`--project PROJECT` で対象の worktree / ディレクトリを選べる。Git の外では、選択したプロジェクトまたは呼び出し元のディレクトリを使う。`--brief` の相対パスは呼び出し元を基準にする。場所を明示する場合は次を使う。この場合 `--name` は指定しない。

```sh
python3 CORE/scripts/moletta.py init RUN --brief FILE --goal '達成したい成果'
```

### 道具の保存だけを使う場合

端末の割当・所有 receipt、数値集約、選択した予約台帳の保存にも初期化済み RUN を使う。これらの保存だけなら、`intent.json` の封印、設計計画、観測の `check --stage verify` は不要である。道具の処理が完了したことと、製品の成果が検証済みであることを区別する。端末の再開・解放には `device status / release`、予約には `delegation status` を使い、未回収や未完了の義務を消さない。

この保存から構造化観測へ進む場合は、次の意図と計画を完成させる。初期化しただけの記録を設計・検証の準備完了として扱わず、テンプレートを埋めるためだけに形式的な要求・実験を作らない。

## 構造化した意図と計画

重要な解釈と理由は `notes`、全体案と負担は `options`、結論と再考条件は `decision` を使う。`brief.md` は原文のコピー、`intent.json` は成果・受入条件・人の必須制約である。意図を確認して埋め、封印する。

```sh
python3 CORE/scripts/moletta.py seal RUN
```

封印後の意図は編集しない。人が目的・必須制約を変える場合は、新しい実行を作り、変更理由と参照元を残す。

後続の人の指示を、古い封印を理由に無視しない。新しい明示要求の引用が元の `brief.md` にない場合も、関連する原文・後続発言と参照元を含む新しい実行を作る。単なる方式変更は計画で扱い、既に明示された許可を聞き直さない。

`plan.json` に要求、全体案、資料、実験、レビュー、判断、次の行動を記す。分解や方式は根拠に応じて更新できる。全案共通の要求と、方式固有の義務を分ける。案の `subject` には対象の実装・設定の識別子と版を記し、追跡すべきローカル入力を明示する。

`next_action` には問い、理由、時間予算、終了条件を一つ記す。実験を選ぶ場合はその ID を対応させる。

```sh
python3 CORE/scripts/moletta.py check RUN --stage plan
python3 CORE/scripts/moletta.py check RUN --stage decide
```

`plan` は計画の対応、`decide` は出典を使った調査・原文レビュー・案の選択条件も調べる。必要な段階だけ使う。出力は意味上の完了宣言ではない。

## コマンドを観測する

実験条件を計画に書いてから実行する。`capture` は実行前の条件を固定し、実際の出力と終了状態を保存する。シェルの解釈を介さず argv を渡す。

```sh
python3 CORE/scripts/moletta.py capture RUN --experiment V1 --timeout 30 --cwd PROJECT -- COMMAND ARG
```

`--cwd` を省略すると呼び出し元の作業ディレクトリを使う。タイムアウトでは POSIX のプロセス群を停止し、観測を残す。

stdout / stderr は各 1 MiB までの保存条件で確認する。大きすぎる、不透明、既知の認証情報パターンに該当する出力は、本体を保持せず `output_blocked` の診断として保存する。コマンドが終了コード 0 でも合格にできない。実行された作用は消えないので、安全な測定出力を案件側で用意し、対象の現状を確認して次の行動を選ぶ。入力検査はコマンドの任意の読み取りやネットワーク送信を制御しない。

## ホストの操作ツールを観測する

ブラウザー・画面・機器などは、ホストにあるツールで操作する。先に観測を開始する。

```sh
python3 CORE/scripts/moletta.py begin RUN --experiment V1
```

返された observation ID を保持し、実際に対象へ到達、操作、結果の観測を行う。そのツールの生の出力・操作履歴を UTF-8 ファイルへ保存し、必要な画像や結果ファイルを添付する。

```sh
python3 CORE/scripts/moletta.py record RUN --observation OBS --transcript TRACE --method '使用したツールと観測方法'
```

`--artifact` は任意で複数回指定できる。各入力は 1 MiB 上限と限定的な入力検査を受ける。画像などの不透明な添付物を案件の権限・保持方針に従って明示して選ぶ場合は、次のように opt-in する。これは内容を匿名化する指定ではない。

```sh
python3 CORE/scripts/moletta.py record RUN --observation OBS --transcript TRACE \
  --method '使用したツールと観測方法' --artifact IMAGE --allow-opaque-artifacts
```

実際の出力を説明文で置き換えず、取得できなかった観測を作らない。取り込みは `attested_native` として保存される。Moletta 自体が対象を操作したことや、そのファイルが本物のツール出力であることを認証する手順ではない。

取り込みの保存が失敗した場合は、取得済みの同じ履歴を使って `record` を再試行できる。対象の操作を自動で繰り返す手順ではない。コマンド取得の保存に失敗した場合も、実行済みの作用を確認してから次の行動を選ぶ。

## 観測を判定する

どちらの取得方法でも、観測と実物を読み、事前の基準に対して一回の判定を付ける。

```sh
python3 CORE/scripts/moletta.py assess RUN --observation OBS --result pass --reason '事前の合格条件と観測の対応'
```

判定は `pass / fail / inconclusive`。終了コード 0 を自動合格にはしない。失敗・不明を後から合格へ書き換えず、別の適用可能な合格観測で解消を明示する。

```sh
python3 CORE/scripts/moletta.py assess RUN --observation NEW_OBS --result pass --reason '再確認した結果' --resolves OLD_OBS
python3 CORE/scripts/moletta.py check RUN --stage verify
```

`verify` は選択案の対象環境で、全要求に合格観測があるかを調べる。さらに、成果ごとに、その成果へ対応する要求をすべて含む `end_to_end` の合格観測を必要とする。対象・実験・追跡入力が異なる観測は、現在の条件の根拠にしない。原文の欠落や観測の妥当性は別に読み直す。

## モバイル端末を分離する

所有・回収と各ホストの前提は [mobile-environment.md](mobile-environment.md) を使う。

```sh
python3 CORE/scripts/moletta.py device inspect ios
python3 CORE/scripts/moletta.py device inspect android --sdk ANDROID_SDK
python3 CORE/scripts/moletta.py device allocate RUN --platform ios \
  --runtime INSTALLED_RUNTIME --device-type INSTALLED_DEVICE_TYPE
```

Android の割当は `--platform android` と確認済みの system image / device type を指定する。利用できるものを `inspect` で確認してから選び、未インストールなら不足を報告する。自動ダウンロードはしない。OS は共有し、作業単位ごとに未起動の Simulator / AVD と可変データを分ける。Android のポートも host registry で調停する。

返された lease の `launch_argv` と `launch_env` をそのままホストの操作へ対応させ、計画した範囲で起動・観測する。割当だけでは起動やアプリ動作の確認は完了しない。実機 UX は人が扱い、Moletta の自動操作や合格へ置き換えない。

観測が終わったら、最終の `check --stage verify` と完了報告の前に所有 lease を解放する。未解放 lease があれば `DEVICE_CLEANUP_PENDING` により verify の準備完了を拒否する。

```sh
python3 CORE/scripts/moletta.py device status RUN
python3 CORE/scripts/moletta.py device release RUN --lease LEASE_ID
```

他の作業の端末、全端末一括、共有 runtime の削除を使わない。解放に失敗した lease は `cleanup_pending` に残し、対象を確認して同じ lease の解放を再試行する。異常終了や消失した作業の回収は `device gc` で候補を確認し、必要な場合だけ `--apply` を使う。存続する作業の端末を時間経過だけで回収しない。host registry の場所を選ぶ場合は割当・状態確認・回収で同じ `--state-dir` または `MOLETTA_DEVICE_STATE` を使う。

## 構造化された性能値を集約する

```sh
python3 CORE/scripts/moletta.py metrics summarize RUN --input METRICS --format csv
python3 CORE/scripts/moletta.py metrics summarize RUN --input METRICS \
  --format xcresult-metrics-json --context CONTEXT
python3 CORE/scripts/moletta.py metrics compare RUN --baseline BASELINE_SUMMARY --candidate CANDIDATE_SUMMARY
```

対応形式は `csv`、`jsonl`、`xcresult-metrics-json`、`android-benchmark-json`。形式と sidecar の契約は [performance.md](performance.md) を使う。Instruments trace、xcresult bundle、Perfetto、logcat、自由形式のログを直接読ませない。Android の nested sampled metrics は非対応で、入力全体を拒否する。

明示したファイルのハッシュと条件ごとの count / mean / p50 / p95 / 最小 / 最大を `RUN/metrics/` に残し、元ログをコピーしない。不正なサンプルや片側だけの条件を黙って捨てない。build revision 以外の条件が異なる比較は拒否する。結果は性能の因果、回帰の合否、実機 UX、機能の正しさの判断ではない。

## 承認した範囲で担当を選ぶ

主担当は [adaptive-delegation.md](adaptive-delegation.md) に従い、モデル・effort を選ぶときは利用可能なホスト能力を実際に確認し、実行と判断の役割に必要な範囲を選ぶ。必要なユーザー承認は実際の発言を参照し、取得済みの範囲を聞き直さない。リポジトリの記述から承認を作らない。承認済みの現在設定による作業に独自の台帳を追加せず、ホストの制御で足りる場合はそれを使う。

複数割当の予約・報告をこの台帳で調整する必要がある場合だけ、初期化済み RUN で次を使う。

```sh
python3 CORE/scripts/moletta.py delegation configure RUN --approval APPROVAL
python3 CORE/scripts/moletta.py delegation reserve RUN --request REQUEST --catalog HOST_CATALOG
python3 CORE/scripts/moletta.py delegation complete RUN --assignment ASSIGNMENT_ID --usage USAGE
python3 CORE/scripts/moletta.py delegation status RUN
```

`configure` は取得済みの承認を記録し、`reserve` は承認・24 時間以内の catalog・予算・並列数を照合する。起動はホストが行い、予約応答はモデルを起動しない。選択した設定を黙って別モデルへ置き換えず、担当には必要最小限の新しい文脈を渡す。実行時間・token の停止と権限はホストが管理する。

終了時は実際の使用量を記録する。不明な token 数は `null` とし、予約枠を占め続ける。費用が不明なら総費用は `null` で、既知の小計と区別する。承認参照・catalog・使用量は申告記録であり、人やサービスの真正性を認証するものではない。

## 有限の探索と再開

```sh
python3 CORE/scripts/moletta.py next RUN
python3 CORE/scripts/moletta.py checkpoint RUN
```

`next` は修正すべき不整合、選択した案に関係する未完了・未判定・未解消の観測、宣言した次の行動を優先する。それらがない場合、完了の意味判断へ進む前に未解放の端末 lease を示す。自動実行や権限の追加ではない。予算と終了条件に達したら、証拠に基づく継続、条件付き判断、構成の再検討、外部の不足の提示から選び、`next_action` を更新または null にする。

中断前は計画を更新して checkpoint を作る。再開時は原文、封印した意図、計画、観測を読み、対象や環境の変化を確認して `next` から続ける。一つの実行ディレクトリを複数担当で編集しない。
