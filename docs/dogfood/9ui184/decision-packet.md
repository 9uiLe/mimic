# 9UI-184: Mimic の参照方式を選ぶための判断資料

2026-10-09 22:14 UTC 時点の暫定資料。方式の採用と S11 の暫定推奨は異なる。判断の目的は、利用者が納得できる設計・製品へ早く到達すること。モデル呼び出し回数の減少だけでは採用しない。

## いま使える判断

**現行画面と出典付き参照経路を当面維持し、比較 Run の実行安定化を優先する。B0/C1/C2 の方式の優劣は未判定で、今日、最終方式を選ぶ根拠はない。** [現行画面](http://127.0.0.1:43173/) と [三案比較画面](http://127.0.0.1:43173/design-review) はユーザーの Mac の Chrome for Testing で操作確認された 9UI-178 の成果である。これは利用者の満足度や B0 方式の安定性を証明しない。

統合版を固定した [新しい1 cohort の実測](../9ui183/bounded-cohort-status.md) では、共通上流の S07 が2回の上限と保存済み work の一度の照合を経ても受理されず、三方式とも S09 に到達しなかった。現時点で選べる行動は現行画面を使い続けることと、この停止の原因・回復経路を優先して検証すること。C1/C2 はともに未評価候補として残し、早期人間判断や再試行速度の優劣を主張しない。

## 実画面で確認できる現在の成果

9UI-178 の実 Run `run_mimic_monitor_cycle2_v2_20261009` は、出典 playbook を S09 の evidence file として受け取り、S10 の三つの構造案を S11 の四つの共通基準で比較した。受理された [exact artifacts](../9ui178/accepted-design-artifacts.json) と [実行解釈](../9ui178/design-cycle.md) を参照できる。S11 は Criteria Comparison Studio を暫定推奨し、Resume Board の再開コンテキストを取り込むと提案した。人間の採用判断ではない。

同じ保存状態を使った [変更前](../9ui178/before-same-state.png) と [変更後](../9ui178/after-same-state.png) の画面では、以前は長いセッション・成果物 ID が主要な閲覧経路を占めていた。変更後は目的→三案比較→別タブでの既存 prototype 操作→Run 進捗→必要時の技術詳細という経路になった。[比較画面](../9ui178/three-direction-review.png) には三案の操作可能な構造プレビューと四基準表がある。ユーザーの Mac 上の Chrome for Testing で `/` と `/design-review` を実操作した記録であり、同じ URL の現行サービスは `http://127.0.0.1:43173/`。新しい比較 Run の S10 artifact は、この画面で操作された prototype ではない。

S09 は SmartHR table を近接、teamLab object・GitHub Actions Run・MediaWiki history を隣接、Google Expressive・Factorio chain を遠い参照として扱った。ただし、この Run に供給した graph は新しい四事例への link を欠き、graph traversal や候補全体の網羅性は確立していない。出典ごとの観察と適用仮説は [9UI-179 の source review](../../../knowledge/seed/product-ui-source-review.md) と [9UI-180 の情報量 review](../../../knowledge/seed/purpose-information-source-review.md) に残る。

四基準は、判断に必要な可視情報、隠れた決定情報、不要なノイズ、次の行動。アクセシビリティは今回の Mimic の設計評価・収束の評価軸から外している。既存の操作機能は維持する。

## 比較の条件

[方式設計](../../development/approach-comparison.md) の B0 は平坦な出典付き事例一覧、C1 は task-conditioned graph 検索の投影、C2 は事例の機構を S09 に先に見せ、反例と目的上の失敗を S11 で強調する方式。B0/C2 も S09 Skill の契約を満たすため、未順位づけの参照グラフと出典台帳を受け取る。C1 だけが課題に合わせた graph 検索結果と役割づけを受け取る。同じ凍結ページ・観察、S01–S08 の exact refs、Skill/schema、モデル設定、事例 corpus を使う。三 arm は同じ Run の分岐 Task とし、先行 arm の方向案は後続 arm の入力にしない。9UI-182 の初期案は arm ごとに別 Run を想定したが、暫定 S01–S08 refs を別 Run の base に移すと router の必須参照を満たせなかった。9UI-183 では計画変更を明記して一つの Run に三つの分岐 Task を置き、Task・session・artifact prefix・evidence path を arm ごとに分離した。実行は逐次なので順序効果は残る。詳細は [9UI-183 runbook](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/README.md) を参照。

比較で知りたいことは、(1) 事例が課題に合っているか、(2) 案が構造的に異なり、反例と不適用条件まで扱うか、(3) 共通基準から推奨・代案・不確実性を説明できるか、(4) 最初のレビュー可能な判断資料までの試行・時間・人間介入である。静的 CLI の受理は、この設計上の有効性や利用者の納得を証明しない。

## 実測結果

[9UI-183 の試行履歴](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/attempt-history.md) と機械集計 [v9](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/v9-report.json)、[v10](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/v10-report.json)、[v11](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/v11-report.json)、[v12](https://github.com/9uiLe/mimic/blob/3a0f923b4a25d9c66aa9d16b39bdb5ae5257bf62/docs/dogfood/9ui183/v12-report.json) を参照。各 Run の正確な artifact ID、lock digest、入力・Skill・schema hash、モデル設定、受理・棄却状態は report にある。v9 は schema hash を固定する前の試行。v10～v12 は固定済み。四 cohort のモデル・brief が異なり、当時の manifest は ignored `dist/` の compiled Core/CLI modules と実行設定のハッシュを固定していなかった。v9/v10 の B0 evidence は、現行 S09 契約に必要な生グラフを渡す前の版でもある。したがって横に並べた経過時間を方式間の速度差と解釈できない。9UI-183 の更新版ハーネスは新規 cohort で compiled modules と実行設定を固定・照合する。

| cohort                               | 共通 Task の試行・受理                            | B0 の試行・受理                         | C1 / C2              | 観測した停止                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| v9 (`gpt-6-sol`, low)                | 6 試行、S04–S08 受理                              | 5 試行、S09 の1 ref 受理。S10 は4回棄却 | 未実行               | S10 の出力は静的検証で構文・契約不一致。schema hash 未固定                                                                                          |
| v10 (`gpt-6-sol`, low)               | 6 試行、S04–S08 受理                              | 4 試行、S09 の1 ref 受理。S10 は未受理  | 未実行               | S10 の3回目は immutable marker の後に outcome 不明。同一保存候補の一度限りの照合でも Core 受理なし                                                  |
| v11 (`gpt-6.1-sol`, low)             | 8 試行、S04–S08 受理                              | 2 試行、受理 ref なし                   | 未実行               | S05 の中断、S08 の公式出力プロトコル不一致を別 session で回復。S09 は2回とも provenance path 重複で静的棄却                                         |
| v12 (`gpt-6.1-sol`, low)             | 5 試行、S04/S01/S02/S05 受理。S07 は prepared     | 未実行                                  | 未実行               | S07 の immutable marker 後に outcome 不明。保存候補の一度限りの照合でも Core 受理なし                                                               |
| 固定1 cohort (`gpt-6.1-sol`, medium) | 6 試行、S04/S01/S02/S05 受理。S07 は2回とも未受理 | 0 / 2 の上限、未実行                    | ともに 0 / 2、未実行 | S07-a は120秒で timeout。S07-b は保存 work/marker の後に outcome 不明。同じ work の正規 resume 1回でも `reservation-invalid`。S08 と全 arm は BLOCK |

新しい固定 cohort の [入力ハッシュ](../9ui183/bounded-cohort-inputs.json)、[exact refs と停止の機械レポート](../9ui183/bounded-cohort-report.json)、[全試行と照合記録](../9ui183/bounded-cohort-attempts.json) を保存した。共通上流6試行の記録時間は合計413,782 msで、S07の2試行を含む。これは準備・確認の時間を含まない値であり、レビュー可能な案までの時間ではない。三方式の arm 固有の試行と時間はすべて0で、入力は固定されたが S09 のモデル評価は未実施。C1 の host 検索は準備段階で4事例を選んだが、Skill が使った証拠ではない。

v11 の B0・S09 に費やした完了済み生成時間は 153,268 ms。v9/v10 にも失敗試行の時間があり、unknown outcome と中断を含む総所要時間は確定できない。これは失敗・再開を含む実際の運用負担の証拠であり、B0/C1/C2 の優劣を示す値ではない。すべて公式の既存 Codex subscription 経路で実行し、モデル出力の手直しで静的検証を通していない。人間による方向採用、理解度、満足度、選択にかかった時間は未測定。オペレーターは停止状態を読み、marker の有無を確認して別 session または別 Run を開始したが、これは利用者の採用判断ではない。

## いま判断できること

三方式の S11 まで揃った同条件比較は**不成立**。したがって、C1 や C2 の方が速い・質が高いという推奨はできない。現行の出典付き evidence は 9UI-178 で S11 と操作可能な比較画面まで到達した別 Run の実例がある。一方、新しい固定 cohort は共通 S07 で止まり、方式固有の出力はない。新しい方式を既定経路へ切り替える前に、S07 の提出予約と outcome 不明の照合、S09–S11 の完走率を改善・測定する必要がある。

**暫定提案:** 現行の出典付き evidence と S09→S11 の人間向け比較画面を当面維持し、実行安定化を先に進める。C1 の graph 検索投影と C2 の段階的反例提示はともに未評価の候補として隔離比較を続ける。切替判断の条件は、同じ凍結入力で各 arm が S11 を出し、事例選択理由、構造差、共通基準、見落とし、所要時間と再試行を照合できること。

現行を維持すると、操作確認済みの 9UI-178 の閲覧経路を保ち、参照の役割づけと反例の明示は人間向け playbook と S09 の中で行う。C1 を既定にする場合、課題特性から事例を検索する host 側処理と網羅漏れの検証が必要になる。C2 では S10 後の反例チェックが手戻りを増やす可能性があるが、これは未測定の仮説である。どれを選んでも、静的検証、人間による正式採用、S13 以降の承認済み foundation 要件は維持する。現在の Run には S13 が要求する承認済み foundation がないため、S11 の提案から S13/S16 の画面品質は推定できない。
