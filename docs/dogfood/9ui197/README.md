# 9UI-197: 9UI-191 の最小デザイン試行

このアダプタは既存の Mimic brief、S09 reference selection、S10 directions、S11 evaluation、Run registry と `mimic decide` を使う。新しいモデル接続や判断権限を追加しない。9UI-191 は調査であり、この実装は「定型化が減る」という効果の証明ではない。既存 B0/C1/C2 固定 Run とその入力は変更しない。

## 使い方

新しい目的から始める場合は、先に `pnpm --filter @mimic/core build && pnpm --filter @mimic/cli build` を実行し、`node scripts/9ui225-start-design.mjs <新規workspace>` を利用者の端末で起動する。利用者・目的・主操作・必須情報・ブランド特徴・変更できない事実を短く入力する。参照の出典と使う理由まで既に整理されている場合は、同じ項目を `brief` に持つ JSON ファイルを第2引数に渡せる（追加項目は `model` と確認済みの `systemContext`、任意の `budget`）。この入口は既存 Skills/Schemas と evidence、guided config/plan を新規 workspace に配置し、Core Run を保存する。同じ入力と workspace なら途中から再開でき、異なる入力や既存の別 workspace は変更しない。**生成・モデル利用許可・人間の案選択は行わない。** 返された config と Run ID を使い、有効な別の公式サブスクリプション許可の下で既存 dispatcher を実行してから、以下の `review`、exact 選択、改稿へ進む。モデルの利用資格はこの準備コマンドでは確認できない。

1. 比較条件ごとに空の Mimic workspace を用意し、通常の `mimic init` を実行する。既存手順どおり `skills/` と `schemas/` を配置し、システム・タスク・参照の出典ファイルを `inputs/` に置く。Chrome/Chromium のみを画面検査に使う。
2. 各 workspace に `trial-config.json` を保存する。二つの設定では `condition` と `runId`、`workspace` 以外の課題・事実・モデル・予算・証拠ファイルの内容を同じにする。`skills/` と `schemas/` の内容も同じであることをハッシュで確認する。guided 条件だけが brief の適用理由、構造案、批評指示を受ける。追加参照の処理と批評の費用は後で分けて測る。
3. `node scripts/9ui197-harness.mjs prepare <workspace>/trial-config.json` で既存 S04–S11 plan template から不変の plan と manifest を書く。`mimic run --id <runId> --tasks tasks-<runId>.json` と公式サブスクリプションの認可済み session dispatcher で実行する。出力の手修正や保存 marker の編集は行わない。S07 は既存の `PROPOSE_ONLY` 経路を使う。
4. 受理済み候補を得たら `node scripts/9ui197-harness.mjs review <config>` で exact artifact、停止、未確定事項を確認する。`review-<runId>.html` は比較・推奨と保留を先に見せ、詳細を折りたたむ。`previewUrls` がある場合だけ候補の操作画面へリンクする。画面検査は `node scripts/with-patched-chrome.mjs node scripts/9ui197-harness.mjs capture <config>` を別途実行するまで `UNVERIFIED` である。

   通常の `review` は候補数と S11 の共通評価項目から A 型の一覧表を作り、空・停止中・選択待ち・改訂上限を区別する。モニターで current review を指定した場合、一覧表へのリンクを保存済み3案の実画面試作より先に表示する。詳細と検査ログは下部で開く。選択済み Run では実際の exact ref と残回数を表示し、改訂準備の入力形式を案内する。画面自体は選択や改訂を保存しない。

   A の共通項目マトリクスを人が**改訂用の作業ベース**として選択した後は、設定の別コピーに `workingPreviewRef` として選んだ exact ref を加え、`node scripts/9ui197-harness.mjs working-preview <その設定コピー>` を実行できる。保存済み Run、plan、選択確認、候補 digest を再照合し、選択案の構造がマトリクスである場合だけ `working-preview-<runId>.html` を出す。これは既存候補から決定論的に描画するローカルの**未承認試作**で、S10 が完成画面を生成したという主張ではない。表から各候補の詳細へ進み比較へ戻り、候補の仮選択と改訂前確認を画面内で試せる。試用は保存・改訂開始を行わず、実際の選択記録を変えない。S11 の推奨提案、Run と改訂履歴、固定情報、未確定事項も区別して示す。`mimic preview` の approved scenario・素材・token の検証や最終採用処理には接続しない。

   操作を Chrome で確かめるには `node scripts/with-patched-chrome.mjs node scripts/9ui197-harness.mjs capture-working-preview <その設定コピー>` を使う。ハーネスが生成した**そのローカルファイルだけ**を開き、固定文言、必須領域、仮選択と改訂確認、横はみ出しを確認して `working-capture-<runId>.json` と撮影を残す。通常の `capture` の URL 制約や検査結果は変更しない。コマンドが停止した場合や撮影していない場合に PASS と表示しない。

   9UI-216 の実画面比較には、同じ選択済み exact ref を含む設定コピーで `node scripts/9ui197-harness.mjs real-screens <その設定コピー>` を実行する。保存済み S10 の A 一覧表・B 二案対照・C 判断項目順次と共通の S11 評価から、`real-screens-<runId>.html` 一枚に3つの操作画面を描く。初期表示は3画面の一覧で、各案を大きく開ける。比較枠の差し替え、項目の前後移動、候補詳細、仮選択と改訂前確認は画面内だけで動き、Run の選択・採用・公開を記録しない。画面意匠は Codex が保存済み構造を元に実装した試作で、Mimic S10 が生成した完成 UI ではない。追加モデル実行は不要。

   選択済み A を改訂した後は、`node scripts/9ui197-harness.mjs revision-screen <改訂Runのconfig>` で、保存済み A@1 と未選択の A@2 を照合する操作画面 `revision-screen-<runId>.html` を出せる。前 Run の人間選択と exact ref、改訂 Run の次 revision、S11 評価、固定文言を再確認し、条件が揃わなければ描画しない。画面の A@2 だけを仮選択・改善対象確認で試せる。B/C は前 Run の比較資料であり、改訂 Run の選択候補ではない。desktop は候補列の表、390px は判断項目ごとの縦並びとし、詳細・比較への復帰と未検証事項を示す。選択は保存せず、Mimic が生成した S10 の構造案を Codex のレンダラーが未承認の操作画面にしたものとして扱う。生成・実際の採用・効果の実証はこのコマンドでは行わない。

   `node scripts/with-patched-chrome.mjs node scripts/9ui197-harness.mjs capture-real-screens <その設定コピー>` は Chrome desktop/390px で3画面の操作と固定表示を確認し、`real-screens-capture-<runId>.json` と一覧・各案の PNG を保存する。localhost 担当が共有するときは、生成 HTML を read-only の独立 URL（例: `GET /design-review/real-screens`）へ割り当て、既存の approved `/preview` 経路とは分ける。HTML は自己完結しており追加 asset は不要。サービス管理タスクが URL とレスポンスの CSP を調整するまで、このハーネスはサーバーを変更・再起動しない。

5. 選択は人が S11 のレビューと S10 候補の exact ref を確認し、`mimic select-revision-base --file <selection.json> --confirmation <confirmation.json>` に明示確認を渡して commit する。AI の S11 提案は選択に数えない。`selection.json` は `id`、`runId`、`ref`、`reviewRef`、human `actor`、`at`、`reason` を含む。`confirmation.json` は CLI 文書の exact digest/候補/レビューを結ぶ既存のローカル確認方式に従う。別候補へ変更する場合は前 selection ID を `supersedesSelectionId` に指定して再確認する。人の確認がない場合は選択待ちのままで、改訂用の選択は最終デザイン採用・公開ではない。改訂は同じ workspace の新しい Run で行い、設定に `previousRunId`、人が選んだ `baseRef`、`revisionRequest` を入れる。`prepare` は前 Run の選択確認と候補の exact ref を再照合し、選ばれた exact ref を S10 の `revise` 入力と対象 artifact に固定する。選ばれた内容だけを新しい S10/S11 brief に渡し、出力が同じ artifact の次 revision で、前 ref を実行入力として消費することを確認する。ArtifactStore は同じ artifact ID への自己依存を認めないため、前 revision との関係は `supersedesRevision` と Run の入力・生成イベントで照合する。連続する前 Run を数え、初期予算 2 回を超える改訂を拒否する。途中案は保存される。生成結果が意図どおりの改善かどうかは人が判断し、ハーネスは自動採用しない。保存済み plan は書き換えない。

   選択済み Run から次の改訂を準備するには、同じ workspace に `{"runId":"新しいRunID","revisionRequest":"改善する画面箇所と理由"}` の JSON を自分で保存し、`node scripts/9ui197-harness.mjs prepare-next <現在のconfig.json> <改訂課題.json>` を実行する。このコマンドは保存済み Run と正規の人間選択を再確認し、上限内なら旧モデル・予算・brief・出典を引き継いだ新しい config と既存 `prepare` の plan を作る。途中失敗しても同じ内容なら準備ファイルを再利用して再試行でき、既存内容が異なる場合は停止する。旧候補のプレビュー/検査設定は引き継がない。生成を開始せず、新しい利用許可も作らない。次 Run の実行には別途有効な公式サブスクリプションの認可経路が必要で、期限切れ grant は使わない。

   Chrome で課題を入力して準備する場合は、別端末で `node scripts/9ui220-revision-ui.mjs <現在のconfig.json> 4318` を**明示起動**し、表示された URL を開く。人間選択のある現在 Run の A 型比較と課題欄が同じ画面にあり、明示ボタンを押すと既存 `prepare-next` と同じ検証で次 Run の config/tasks/manifest を保存する。再読み込み後も保存済み計画を確認でき、この画面では AI 生成を開始していないと表示する。現時点の実行状態は Run 本体で確認する。同じ課題の再送は二重準備せず、違う課題や途中で変わった exact ref は拒否する。既存 monitor に入口リンクを出すには、monitor 起動時に `--revision-prep-port 4318` を追加する。この引数はリンクだけであり、monitor 自体は書き込まない。改稿準備 UI を停止するとリンク先は利用できなくなる。最終採用・モデル実行・許可登録は別操作のままである。

   Core は候補の生成元、S11 レビューとの exact 依存、保存した利用者確認、候補の失効・改変・別候補への置換を再確認する。これらが一致しなければ改訂 Run は始まらない。ハーネスは人の回答や確認を作らない。

6. 両条件の初期 Run の manifest がそろったら `compare <baseline-config> <guided-config>` で宣言した課題・事実・出典・モデル・予算の一致を確認する。改訂 Run は選択済み案と修正依頼が追加入力になるので、この初期条件比較には含めない。実行 checkpoint は既存の保存検証と plan binding を通ったものだけ使用し、モデル一致は各 review の `usage.model` を見る。実 budget、参照/批評コスト、選択・修正の手間、人間の回答時間と満足度は実測しない限り `UNVERIFIED` または `UNMEASURED` のままにする。

設定例（`workspace` と出典ファイルは実環境に合わせて置く）:

```json
{
  "workspace": "/absolute/path/to/new-workspace",
  "runId": "run_design_guided_001",
  "condition": "guided",
  "model": "account-entitled-model-id",
  "budget": { "maxGenerations": 2, "timeoutMs": 120000 },
  "referenceFile": "inputs/references.md",
  "evidenceFiles": {
    "s04": ["inputs/system.md"],
    "s08": ["inputs/task.md"]
  },
  "brief": {
    "audience": "保存済み Run を比較する担当者",
    "purpose": "候補を選び、次の操作へ進む",
    "primaryAction": "同じ基準で候補を比較する",
    "requiredInformation": ["候補ごとの主操作", "根拠", "未確定事項"],
    "brandCharacter": "明快で落ち着いた判断面",
    "content": [
      { "policy": "fixed-fact", "text": "12 active Runs" },
      { "policy": "fixed-copy", "text": "Resume Run" },
      { "policy": "editable-copy", "text": "Compare options" },
      { "policy": "confirm", "text": "ブランドとして何を優先するか" }
    ],
    "references": [
      {
        "source": "case:smarthr-table",
        "reason": "比較に必要な列を前面に出す",
        "appliesWhen": "候補間で共通項目を走査するとき",
        "doNotBorrow": "元画面の語彙やレイアウト全体"
      }
    ]
  }
}
```

`content` は画面で守る必要がある数値・実績・文言を `fixed-fact` / `fixed-copy`、編集可能な表現を `editable-copy`、所有者への質問を `confirm` に分ける。画面に出さない内部情報を fixed content に混ぜない。`capture` は宣言した `previewUrls` の実画面本文を Chrome で読み、固定文言の欠落、指定した要素・操作、横はみ出しを記録する。`previewUrls`、画面の描画完了を示す `readySelectors`、`operations` は候補の `artifactId@revision#lockDigest` をキーにする。プレビュー URL がある候補には、描画後に表示される ready selector が必須である。操作チェックは `{ "selector": "button", "resultSelector": "#result", "expectedText": "Done" }` と記し、各操作を新しいページからクリックして、その結果領域が変わった場合だけ PASS にする。指定がない項目は PASS にしない。プレビュー URL・ready selector・必須要素・操作チェックを変更した場合、旧キャプチャは `STALE_SETTINGS` として無効になり、再撮影までは検証結果が `UNVERIFIED` になる。画面はこの Run の成果物と別に作られた場合、その関係を証拠として明示する。

改訂設定では初期設定と同じ `workspace`、`condition`、`model`、`budget`、`revisionBudget`、`brief`、出典ファイルを使い、次の項目を足す。`baseRef` は直前 Run のレビューが表示した exact ref をそのまま使う。例の digest はダミー値である。

```json
{
  "previousRunId": "run_design_guided_001",
  "baseRef": {
    "artifactId": "art_selected_direction",
    "revision": 1,
    "lockDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "revisionRequest": "比較時に必須の状態が見えないので、選択した案の状態表示を改善する"
}
```

## 境界

- S10 は初期 3 案を目安にするが、色替えを数に含めない。既存 Skill の六軸比較と exact provenance を保持する。
- S11 は場所と理由のある批評を求める。紫、角丸、書体や「AI らしさ」の合成点を機械ゲートにしない。機械は固定表示文言、宣言された要素と操作、横はみ出しを確認する。ブランド適合と差の価値は人が選ぶ。
- 参照は出典、使用理由、適用条件、模倣しない部分を brief に持つ。ブランド色が確定していれば文字/背景/強調の役割を述べ、未確定なら質問として残す。
- このハーネスは候補の表示 URL や人間の回答を作り出さない。実画面 URL がない候補の操作性、利用者の満足度、方法の優劣は未検証として表示する。

調査根拠と限界は [9UI-191](https://linear.app/9uile/issue/9UI-191) にある。公式ガイドや少数事例は設計仮説の材料であり、Mimic の効果測定として扱わない。
