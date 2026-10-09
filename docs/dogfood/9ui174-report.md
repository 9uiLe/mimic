# 9UI-174 実ドッグフード記録

## 目的と入力

稼働中の `http://127.0.0.1:43173/` にある Run モニターを、Mimic の正規 Skill と Codex ハーネスで1サイクル改善する。入力は実ページ、保存済み Run、現行 UI 契約、既存 synthetic preview の境界、参照例と実装制約。既存サービスと成果物は保持した。

## 実行結果

- v5 の S04–S11 は受理されたが、S10 が1案だけを生成した。S11 はその1案を評価できたものの、発散の受入条件は満たさなかった。
- v6 の S10 はモデルが4つの構造案を生成したが、JSON 構文と重複した provenance ポインタのため提出はブロックされた。この実行と原文を残した。提出前 provenance 検査を加え、無効な出力で不変マーカーが先に記録される問題を修正した。
- v7 では前段 S04–S09 の既存モデル成果物を exact ref で再結合した。S10 の4案は v6 のモデル原文から JSON と provenance 表現を機械的に補正して受理した。S11 は実モデル出力で4案を同じ4基準で評価し、`proposed` の判断1件を保存した。ただし判断の `rationale` 欄は空だった。
- v8 は v7 の保存済みモデル成果物を同じ task 順序で exact ref に再結合し、S11 の `rationale` にモデルが summary で既に記述した因果文を逐語的に複写した。追加のモデル呼び出しや新たな採用判断はしていない。v7 は変更せず残した。原文、再結合、構文・由来表現の補正、v8 の逐語複写は同じ workspace の `.mimic/agent-work` に監査記録がある。人間承認は記録していない。

[比較プレビュー](./9ui174-design-review.html)は4案の模式図、同一基準の評価、代替案と未確認事項を表示する。[検証 JSON](./9ui174-run-verification.json)には v8 の exact locks、評価対応と理由欄の検証結果を保存した。再検証は `node scripts/verify-monitor-design-cycle.mjs /private/tmp/mimic-riverbend-minimal-QEqg92 run_mimic_monitor_design_v8_20261009` で行う。

| 案         | 構造                           | S11 の比較                                                                               |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| 検索一覧   | Run 一覧と継続する詳細領域     | Run 発見、preview 分離、操作案は PASS。実利用とアクセシビリティは UNVERIFIED。優先候補。 |
| 時系列     | Run を時系列に並べ、行内で展開 | 前2基準は PASS。時系列の意味と有用性に CONCERN。代替候補。                               |
| 案内フロー | 1 Run ずつ段階的に確認         | 前2基準は PASS。追加の操作段階の価値に CONCERN。                                         |
| 横並び比較 | 共通項目で Run を列比較        | 前2基準は PASS。狭い画面での可読性と実装に CONCERN。                                     |

共通基準は「Run identity and finding」「Preview separation」「Feasible interaction」「Unverified user/accessibility outcomes」。案間の構造差はナビゲーション、情報配置、操作、同時表示量について比較した。実装前のモデル評価であり、ユーザー試験や WCAG 2.2 AA 監査ではない。v7 の実行時プロンプトでは S11 の必須入力（4方向、problem-profile、product-ui-contract）の本文を渡し、任意入力は ref・meta・scope のみだった。そのため任意の journey、capability、reference-selection 等の本文に基づく評価は成立していない。独立レビュー後にハーネスを修正し、今後は任意入力の本文も渡す。v7 の保存済み判断は変更せず、v8 にも任意入力本文に基づく新たな評価は追加していない。

## 制御と判断の境界

Mimic Core が frozen plan、S10 から S11 への exact refs、schema、origin、provenance、静的提出を検証した。モデルが方向案、評価と暫定推奨を記述した。Codex コーディネーターは構文と provenance 表現の補正、成果物の再結合、モデル既存文の理由欄への逐語複写、検証と模式プレビュー作成を担当した。技術的なページ改善として検索可能な Run 一覧と展開式詳細を実装したが、デザイン方向の正式な採用ではない。正式判断は [9UI-175](https://linear.app/9uile/issue/9UI-175/run-モニターのデザイン方向を正式採用するか) に残した。

## 改善範囲と残る限界

モニターは検索、コンパクトな Run 詳細、ポーリング中の検索語と開閉状態の維持を提供し、既存 synthetic preview を分離する。保存済み状態の閲覧とモデルによる設計推論は確認した。実ユーザーの成功率、Run と preview の出所関係、アクセシビリティ適合、正式採用は確認していない。
