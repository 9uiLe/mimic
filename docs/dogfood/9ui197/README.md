# 9UI-197: 9UI-191 の最小デザイン試行

このアダプタは既存の Mimic brief、S09 reference selection、S10 directions、S11 evaluation、Run registry と `mimic decide` を使う。新しいモデル接続や判断権限を追加しない。9UI-191 は調査であり、この実装は「定型化が減る」という効果の証明ではない。既存 B0/C1/C2 固定 Run とその入力は変更しない。

## 使い方

1. 比較条件ごとに空の Mimic workspace を用意し、通常の `mimic init` を実行する。既存手順どおり `skills/` と `schemas/` を配置し、システム・タスク・参照の出典ファイルを `inputs/` に置く。Chrome/Chromium のみを画面検査に使う。
2. 各 workspace に `trial-config.json` を保存する。二つの設定では `condition` と `runId`、`workspace` 以外の課題・事実・モデル・予算・証拠ファイルの内容を同じにする。guided 条件だけが brief の適用理由、構造案、批評指示を受ける。追加参照の処理と批評の費用は後で分けて測る。
3. `node scripts/9ui197-harness.mjs prepare <workspace>/trial-config.json` で既存 S04–S11 plan template から不変の plan と manifest を書く。`mimic run --id <runId> --tasks tasks-<runId>.json` と公式サブスクリプションの認可済み session dispatcher で実行する。出力の手修正や保存 marker の編集は行わない。S07 は既存の `PROPOSE_ONLY` 経路を使う。
4. 受理済み候補を得たら `node scripts/9ui197-harness.mjs review <config>` で exact artifact、停止、未確定事項を確認する。`review-<runId>.html` は比較・推奨と保留を先に見せ、詳細を折りたたむ。`previewUrls` がある場合だけ候補の操作画面へリンクする。画面検査は `capture <config>` を別途実行するまで `UNVERIFIED` である。
5. 選択は人が既存の `mimic decide` に正規の確認を渡して行う。人が確定した decision の `chosenAlternative` に候補の `artifactId@revision#lockDigest` がない場合、レポートは `selection-needs-exact-ref` とし、選択済みとはみなさない。改訂は選ばれた候補だけを対象にし、初期予算は最大 2 回。上限後は途中案を含め人へ返す。Mimic の Run plan は固定なので、改訂には正規の新しい Run と承認済み exact base が必要で、保存済み plan を書き換えない。
6. 両条件の manifest がそろったら `compare <baseline-config> <guided-config>` で宣言した課題・事実・出典・モデル・予算の一致を確認する。実行 checkpoint のモデル一致は各 review の `usage.model` を見る。実 budget、参照/批評コスト、選択・修正の手間、人間の回答時間と満足度は実測しない限り `UNVERIFIED` または `UNMEASURED` のままにする。

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

`content` は画面で守る必要がある数値・実績・文言を `fixed-fact` / `fixed-copy`、編集可能な表現を `editable-copy`、所有者への質問を `confirm` に分ける。画面に出さない内部情報を fixed content に混ぜない。`capture` は宣言した `previewUrls` の実画面本文を Chrome で読み、固定文言の欠落、指定した要素・操作、横はみ出しを記録する。`previewUrls` と `operations` は候補の `artifactId@revision#lockDigest` をキーにする。操作チェックは `{ "selector": "button", "resultSelector": "#result", "expectedText": "Done" }` と記し、クリック前後でその結果領域が変わった場合だけ PASS にする。指定がない項目は PASS にしない。画面はこの Run の成果物と別に作られた場合、その関係を証拠として明示する。

## 境界

- S10 は初期 3 案を目安にするが、色替えを数に含めない。既存 Skill の六軸比較と exact provenance を保持する。
- S11 は場所と理由のある批評を求める。紫、角丸、書体や「AI らしさ」の合成点を機械ゲートにしない。機械は固定表示文言、宣言された要素と操作、横はみ出しを確認する。ブランド適合と差の価値は人が選ぶ。
- 参照は出典、使用理由、適用条件、模倣しない部分を brief に持つ。ブランド色が確定していれば文字/背景/強調の役割を述べ、未確定なら質問として残す。
- このハーネスは候補の表示 URL や人間の回答を作り出さない。実画面 URL がない候補の操作性、利用者の満足度、方法の優劣は未検証として表示する。

調査根拠と限界は [9UI-191](https://linear.app/9uile/issue/9UI-191) にある。公式ガイドや少数事例は設計仮説の材料であり、Mimic の効果測定として扱わない。
