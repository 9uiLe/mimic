# 知識の入口

デジタルUIに関するデザインの知識・概念・思想・哲学を、一つにつき一つのディレクトリに置きます。人もAIも、この索引から必要な概念の `KNOWLEDGE.md` を読み、そこから出典や説明例などの補足を参照します。

## 読む本文

| ID | 正本 | 説明すること | 採用状態 |
| --- | --- | --- | --- |
| `ecological-interface-design` | [Ecological Interface Design](ecological-interface-design/KNOWLEDGE.md) | 作業領域の制約をインターフェースに表す設計枠組み | 正式採用済み |
| `external-representations` | [外的表象](external-representations/KNOWLEDGE.md) | 外部環境に表された情報と、頭の中の処理との関係 | 正式採用済み |
| `conceptual-models` | [概念モデル](conceptual-models/KNOWLEDGE.md) | 構成要素を結び、仕組みや動作を理解する枠組み | 正式採用済み |
| `grouping` | [グルーピング](grouping/KNOWLEDGE.md) | 意味上の分類、近接によるまとまり、名称や見出しの役割 | 正式採用済み |
| `visual-hierarchy` | [視覚的な優先順位](visual-hierarchy/KNOWLEDGE.md) | 相対的な強調、内容の階層、業務上の優先度の違い | 正式採用済み |
| `lightness-and-luminance` | [明度と相対輝度](lightness-and-luminance/KNOWLEDGE.md) | 色の明るさに関する表現と、コントラスト計算に使う量の違い | 採用前 |
| `color-contrast` | [色コントラスト](color-contrast/KNOWLEDGE.md) | 前景・背景の組み合わせと、文字・UIの識別に関する条件 | 採用前 |
| `design-tokens` | [Design Token](design-tokens/KNOWLEDGE.md) | 設計上の意図と値を、名前・参照・役割で共有する仕組み | 採用前 |
| `ai-slop` | [AI Slop](ai-slop/KNOWLEDGE.md) | 批評語の用法、UIへの射程、不要要素と画一化の違い | 採用前 |
| `aesthetic-and-minimalist-design` | [Aesthetic and Minimalist Design](aesthetic-and-minimalist-design/KNOWLEDGE.md) | 必要情報を保ち、不要な要素との競合を減らすUXヒューリスティック | 採用前 |

各 `KNOWLEDGE.md` と、そこから参照する補足資料が正本です。入口では定義、背景、関連概念との違い、対象範囲を説明し、出典との対応は各ディレクトリの `references/sources.md` で確認できます。[RepositoryのREADME](https://github.com/9uiLe/mimic/blob/main/README.md)やこの索引は、本文を参照した代わりにはなりません。

## 参照する前に

`KNOWLEDGE.md` 先頭の `id`・`title`・`status`・`version`・`scope`・`related` を確認します。５件は正式採用済み（`status: accepted`）です。「明度と相対輝度」「色コントラスト」「Design Token」「AI Slop」「Aesthetic and Minimalist Design」の５件は採用前（`status: proposed`）で、方向の確認と説明文の正式採用を区別しています。版と採用状態は各入口の先頭、対象範囲は各概念の `scope` と本文で確認します。

使う概念の定義だけでなく、出典の立場と対象範囲、関連概念との違い、説明用の整理や例の位置づけまで読みます。入口から参照する `references/` や `examples/` の内容が説明に必要な場合は、それも確認します。利用者や案件の条件に適用するときは、本文が説明する知識と、案件固有の仮定・提案を区別します。必要な知識がない場合は、その不足を明記します。

実際に読めた本文と版を確認します。索引・題名・リンクだけを受け取った場合や、本文を取得できなかった場合に、参照済みとは報告しません。本文を読めたこと、内容を適切に適用できたこと、実画面の使いやすさを確かめたことは、それぞれ区別します。

## 閲覧・編集の案内

複数の概念を読む道筋は、`knowledge/` の外にある[「判断材料の選定」の案内](../topics/decision-material-selection.md)に置きます。この案内の[人向け閲覧ページ](../prototypes/decision-material-selection/index.html)と[案内のMarkdown](../prototypes/decision-material-selection/ai.md)は、案内の正本から生成します。個別概念の本文や補足を取り込んだ全文ではないため、概念を使うときはリンク先の `KNOWLEDGE.md` を読みます。

[「色の知識」の案内](../topics/color.md)からは、明るさ・コントラスト・視覚的な強調に関する本文を読めます。[Design Token](design-tokens/KNOWLEDGE.md)は、色に限らず設計上の値を共有する仕組みとして独立して読めます。具体的なUI色へ適用・共有するときは[色への適用例](design-tokens/examples/color-presentation.md)を参照し、[利用ガイドの提示方針](../guideline/README.md#uiの色を具体的に示すとき)を適用します。

[「AI Slopに関する知識」の案内](../topics/ai-slop.md)からは、批評語と既存UX指針の違い、情報の必要性、まとまりや強調を扱う本文へ進めます。

ディレクトリの構成と補足資料の役割は[知識の構造ガイド](https://github.com/9uiLe/mimic/blob/main/guideline/knowledge-structure.md)を参照します。これは資料の配置を揃える構造であり、ClaudeやCodexのスキルとしての呼び出しや実行は定義しません。

掲載・編集・採用の方針は[Repositoryの方針と利用ガイド](../guideline/README.md)、AIの作業は[AI向けの作業ガイド](../guideline/ai.md)に従います。内容の編集は正本で行い、生成物を直接編集しません。生成物の更新方法と公開手順は[開発・公開ガイド](https://github.com/9uiLe/mimic/blob/main/guideline/development.md)を参照します。
