# Mimic

デジタルUIに関するデザインの知識・概念・思想・哲学を言語化し、人とAIが理解できるように説明する知識データベースです。Web、iOS、Androidなどに共通する考え方を扱います。

## 収録している知識

| 本文 | 説明すること | 採用状態 |
| --- | --- | --- |
| [Ecological Interface Design](knowledge/ecological-interface-design/KNOWLEDGE.md) | 作業領域の制約をインターフェースに表す設計枠組み | 正式採用済み（`accepted`） |
| [外的表象](knowledge/external-representations/KNOWLEDGE.md) | 外部環境に表された情報と、頭の中の処理との関係 | 正式採用済み（`accepted`） |
| [概念モデル](knowledge/conceptual-models/KNOWLEDGE.md) | 構成要素を結び、仕組みや動作を理解する枠組み | 正式採用済み（`accepted`） |
| [グルーピング](knowledge/grouping/KNOWLEDGE.md) | 意味上の分類、近接によるまとまり、名称や見出しの役割 | 正式採用済み（`accepted`） |
| [視覚的な優先順位](knowledge/visual-hierarchy/KNOWLEDGE.md) | 相対的な強調、内容の階層、業務上の優先度の違い | 正式採用済み（`accepted`） |
| [明度と相対輝度](knowledge/lightness-and-luminance/KNOWLEDGE.md) | 色の明るさに関する表現と、コントラスト計算に使う量の違い | 採用前（`proposed`） |
| [色コントラスト](knowledge/color-contrast/KNOWLEDGE.md) | 前景・背景の組み合わせと、文字・UIの識別に関する条件 | 採用前（`proposed`） |
| [Design Token](knowledge/design-tokens/KNOWLEDGE.md) | 設計上の意図と値を、名前・参照・役割で共有する仕組み | 採用前（`proposed`） |
| [AI Slop](knowledge/ai-slop/KNOWLEDGE.md) | 批評語の用法、UIへの射程、不要要素と画一化の違い | 採用前（`proposed`） |
| [Aesthetic and Minimalist Design](knowledge/aesthetic-and-minimalist-design/KNOWLEDGE.md) | 必要情報を保ち、不要な要素との競合を減らすUXヒューリスティック | 採用前（`proposed`） |

一つの概念・思想・哲学ごとにディレクトリを用意し、`KNOWLEDGE.md` を入口としています。出典や説明例は、同じディレクトリ内の必要な補足へリンクします。これらが知識の正本です。既存５件は正式採用済み（`accepted`）、「明度と相対輝度」「色コントラスト」「Design Token」「AI Slop」「Aesthetic and Minimalist Design」の５件は採用前（`proposed`）です。版と採用状態は、各 `KNOWLEDGE.md` の先頭で確認できます。

## 読み方・使い方

人は上の一覧から関心のある概念の入口を読みます。複数の概念を横断して読むための[「判断材料の選定」の案内](topics/decision-material-selection.md)もあります。この案内は[閲覧ページ](prototypes/decision-material-selection/index.html)でも読めます。[GitHub Pages](https://9uile.github.io/mimic/)は、全概念の一覧から本文・関連概念・出典・例をHTMLで読み、Markdown原文も参照できる構成です。Pagesの配信はmainへの反映時に行われます。

色については[「色の知識」の案内](topics/color.md)から、明るさ・コントラスト・視覚的な強調に関する本文を読めます。[Design Token](knowledge/design-tokens/KNOWLEDGE.md)は、色に限らず設計上の値を名前や参照で共有する独立した概念として読めます。具体的なUI色を適用・共有するときは[色への適用例](knowledge/design-tokens/examples/color-presentation.md)を参照し、[利用ガイドの提示方針](guideline/README.md#uiの色を具体的に示すとき)に従います。

AIは[知識の入口](knowledge/README.md)から必要な本文を読み、版・採用状態・出典の対象範囲を確認します。索引や要約だけを読んで、本文を参照済みとは扱いません。

個別のUIに適用するときは、その案件の目的や条件に照らして考えます。案件固有の仕様・設計書・レビュー資料は案件側に置きます。

## 詳しいガイド

- [Repositoryの方針と利用ガイド](guideline/README.md)：掲載する内容、説明の品質、採用の考え方。
- [AI向けの作業ガイド](guideline/ai.md)：知識の参照・編集・確認・報告の手順。
- [知識の構造ガイド](guideline/knowledge-structure.md)：概念ごとのディレクトリ、固定の入口、補足資料の役割。
- [開発・公開ガイド](guideline/development.md)：生成物の更新、ローカル検査、GitHub Pagesへの公開。

## ライセンス

このRepositoryは[MITライセンス](LICENSE)で提供します。参照先の資料と依存ライブラリには、それぞれの権利・ライセンス条件が適用されます。
