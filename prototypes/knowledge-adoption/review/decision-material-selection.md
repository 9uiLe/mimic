# 「判断材料の選定」採用候補の編集確認

この記録は、[8a7f839時点の原稿](https://github.com/9uiLe/mimic/blob/8a7f839e8235fa016db6fb033a792799db56c8ef/knowledge/decision-material-selection.md)と出典を照合したものです。[現在の参照先](../../../topics/decision-material-selection.md)とその補足ファイルを一括して確認済みとする記録ではありません。

対象は[改稿した本文](https://github.com/9uiLe/mimic/blob/8a7f839e8235fa016db6fb033a792799db56c8ef/knowledge/decision-material-selection.md)。2026年10月22日に作成した、採用判断用の編集資料であり、本文の正式採用や公開を完了した記録ではない。

## 変更の目的

旧版0.1.1と研究案0.2.0-draftにあった独自の選定方式を外し、既存の概念・思想を、それぞれの立場と対象範囲に沿って説明する。題名「判断材料の選定」は、複数の概念を扱う編集上の題目として位置づけた。改稿した文書のメタデータは`status: proposed`、`version: "0.2.0"`とした。

## 原典・公式指針との対応

以下の本文を直接確認した。確認は記載した範囲の照合であり、各理論の研究史や関連文献の網羅的な調査ではない。

| 出典・確認箇所 | 本文で説明する内容 | 対象範囲と留意点 |
| --- | --- | --- |
| [Vicente & Rasmussen, Ecological Interface Design: Theoretical Foundations](https://backend.orbit.dtu.dk/ws/files/158017888/SMC.PDF) — Abstract・Introduction、§II.B（原稿5–6頁）、§III.A（7–8頁）・B（8–10頁） | 情報内容・構造と表現の区別。同一の作業領域を異なる抽象度で記述し、目的と手段の関係で結ぶ抽象化階層。複雑な人間機械システムにおける想定外事象への対処という背景 | §III.Bは、目的に関わる制約の表現を論じる。一般UIの項目削減手順や、最適な表示件数の理論としては紹介していない。抽象化階層全体やEIDの3原則の説明を尽くす文書ではない |
| [Zhang & Norman, Representations in Distributed Cognitive Tasks](https://worrydream.com/refs/Zhang_2004_-_Representations_in_Distributed_Cognitive_Tasks.pdf) — Abstract、The Nature of External Representations（原稿29–30頁） | 頭の中と外部環境に分散した情報。外的表象の記憶補助、知覚できる情報、可能な操作、課題の性質との関係 | ハノイの塔の分析と実験から論じる著者の立場として記述。任意のUIや、作成した温度表示例の速さ・正確さの実証として扱わない。URLの`2004`ではなく、PDF冒頭の「To appear in Cognitive Science, 18, 87-122, 1994」に従って年を表記 |
| [Don Norman, Design as Communication](https://jnd.org/design-as-communication/) — Communication & Context: Design as Story Telling、Conceptual Models & User-Centered Design、Conceptual Models as Stories | 文脈による役割の理解。構成要素と動作の理由をつなぐ概念モデル。製品と補助資料が伝える情報を通じたデザイナーと利用者の間の意味の伝達 | 著者の解説として記述。すべての利用者が同じ意味を理解するという保証にはしていない。概念モデルを単なる名称や表示項目と同一視しない |
| [Carbon, Data table guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) — Variants / Expandable | 展開領域を補足情報や追加の問い合わせ時間が必要なデータに使う指針。窮屈な場合の専用ページ・サイドパネル等 | データテーブル部品の指針として記述。元の`/components/data-table/usage/`から現行URLへの転送も確認 |
| [GOV.UK Design System, Accordion](https://design-system.service.gov.uk/components/accordion/) — When to use this component、When not to use this component、Decide between using accordions, tabs and details | 隠れた内容への気づきや操作理解の問題、全員が見る必要のある内容に使わないという指針 | アコーディオン部品の指針として記述。関連する複数の節を開示・比較する用途も原文で確認したが、本文では用途を一般化せず、隠す条件を紹介した |

## 取り除いた独自の仮説・手順

- Mimicの5軸と、採否を決める独自の選定アルゴリズム・比較手順。
- AIが確認する入力、返す内容、仮案の採用・保留を定める運用指示。
- 仕事一覧に固有の業務規則、8→4→3項目の削減例、要約案の推奨。
- 画面の正答率、見落とし、所要時間などを、知識の採用条件に置く記述。
- 一般UIへの応用仮説や、実施していない画面実験を知識本文の未検証事項として列挙する構成。

## 説明例と概念間の関係

温度表示の例は新たに作成した。二つの値の照合と差の外的表象、および地点・単位という文脈を示すための例である。EIDを一般UIへ適用した例とも、表示の効果の証拠ともしていない。

グルーピングと視覚的な優先順位への接続は、３文書が扱う問いを区別する編集上の説明である。複数の理論を統合した原典の分類としては扱っていない。同階層のMarkdownリンクを使った。

## 残る根拠不明点と採用判断

本文に残した概念説明には、上表の該当箇所を対応させた。固定の選定軸、一般UIの最適な項目数、各表示案の効果については根拠を示しておらず、本文でも主張していない。

「判断材料の選定」が既存の単一理論名として読まれないか、またEIDの対象範囲と一般UIの部品指針を区別できるかを、別文脈の読解担当が確認した。単一理論や手順としての誤読は見られず、修正必須の指摘はなかった。正式採用の判断は人のレビューに残る。

## 実施した確認

[旧版0.1.1](https://github.com/9uiLe/mimic/blob/a7c062d74d2c08e0fc225d75ddeb4428cfd9e8f7/knowledge/decision-material-selection.md)、[研究案](../../decision-material-selection/draft.md)、上記5資料の該当箇所を照合し、出典の説明と編集上の整理・例を分けた。ここで記録する確認対象は、本文と出典の対応である。
