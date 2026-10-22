# 知識の入口

デジタルUIに関するデザインの知識・概念・思想・哲学を、一つにつき一つのディレクトリに置きます。人もAIも、この索引から必要な概念の `KNOWLEDGE.md` を読み、そこから出典や説明例などの補足を参照します。

## 読む本文

| ID | 正本 | 説明すること |
| --- | --- | --- |
| `ecological-interface-design` | [Ecological Interface Design](ecological-interface-design/KNOWLEDGE.md) | 作業領域の制約をインターフェースに表す設計枠組み |
| `external-representations` | [外的表象](external-representations/KNOWLEDGE.md) | 外部環境に表された情報と、頭の中の処理との関係 |
| `conceptual-models` | [概念モデル](conceptual-models/KNOWLEDGE.md) | 構成要素を結び、仕組みや動作を理解する枠組み |
| `grouping` | [グルーピング](grouping/KNOWLEDGE.md) | 意味上の分類、近接によるまとまり、名称や見出しの役割 |
| `visual-hierarchy` | [視覚的な優先順位](visual-hierarchy/KNOWLEDGE.md) | 相対的な強調、内容の階層、業務上の優先度の違い |
| `lightness-and-luminance` | [明度と相対輝度](lightness-and-luminance/KNOWLEDGE.md) | 色の明るさに関する表現と、コントラスト計算に使う量の違い |
| `color-contrast` | [色コントラスト](color-contrast/KNOWLEDGE.md) | 前景・背景の組み合わせと、文字・UIの識別に関する条件 |
| `design-tokens` | [Design Token](design-tokens/KNOWLEDGE.md) | 設計上の意図と値を、名前・参照・役割で共有する仕組み |
| `ai-slop` | [AI Slop](ai-slop/KNOWLEDGE.md) | 批評語の用法、UIへの射程、不要要素と画一化の違い |
| `aesthetic-and-minimalist-design` | [Aesthetic and Minimalist Design](aesthetic-and-minimalist-design/KNOWLEDGE.md) | 必要情報を保ち、不要な要素との競合を減らすUXヒューリスティック |
| `typography` | [Typography](typography/KNOWLEDGE.md) | 日本語と英数字を含む文字の形・組み方、役割、拡大への対応 |
| `layout-spacing` | [レイアウトの余白](layout-spacing/KNOWLEDGE.md) | コンポーネント・グループ・セクション間の間隔と、尺度・情報密度の関係 |

各 `KNOWLEDGE.md` と、そこから参照する補足資料が正本です。この索引だけを読んで、個別の本文を参照済みとは扱いません。

## 参照する前に

`KNOWLEDGE.md` 先頭の `id`・`title`・`version`・`scope`・`related` を確認し、本文と必要な出典・補足を読みます。

具体的なUIの文字スタイルを示すときは、[利用ガイドのTypographyの提示方針](../guideline/README.md#uiのtypographyを具体的に示すとき)を参照します。

使う概念の定義、背景、対象範囲、関連概念との違いを本文で読みます。出典の主張に触れるときは、本文から `references/sources.md` と原典の該当箇所へ進みます。`examples/` は説明用の例として読み、出典による効果の実証や案件への採用案と区別します。必要な知識がない場合は、その不足を明記します。

実際に読めた本文と版を確認します。本文を取得できなかった場合に参照済みとは報告しません。知識の説明と、個別UIでの適用・検証を区別します。

## 複数の概念から読む

横断的な案内は[「判断材料の選定」](../topics/decision-material-selection.md)、[「色の知識」](../topics/color.md)、[「AI Slopに関する知識」](../topics/ai-slop.md)です。案内は個別概念の本文や出典を取り込んだ全文ではありません。使う概念の `KNOWLEDGE.md` へ進みます。

具体的なUI色を提示するときは、色とは独立した[Design Tokenの本文](design-tokens/KNOWLEDGE.md)と[色への適用例](design-tokens/examples/color-presentation.md)を読み、[利用ガイドの色の提示方針](../guideline/README.md#uiの色を具体的に示すとき)に従います。
