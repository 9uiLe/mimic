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

各 `KNOWLEDGE.md` と、そこから参照する補足資料が正本です。入口では定義、背景、関連概念との違い、対象範囲を説明し、出典との対応は各ディレクトリの `references/sources.md` で確認できます。[RepositoryのREADME](../README.md)やこの索引は、本文を参照した代わりにはなりません。

## 参照する前に

`KNOWLEDGE.md` 先頭の `id`・`title`・`status`・`version`・`scope`・`related` を確認します。収録している５件の説明文は正式採用済み（`status: accepted`）です。版と採用状態は各入口の先頭、対象範囲は各概念の `scope` と本文で確認します。

使う概念の定義だけでなく、出典の立場と対象範囲、関連概念との違い、説明用の整理や例の位置づけまで読みます。入口から参照する `references/` や `examples/` の内容が説明に必要な場合は、それも確認します。利用者や案件の条件に適用するときは、本文が説明する知識と、案件固有の仮定・提案を区別します。必要な知識がない場合は、その不足を明記します。

実際に読めた本文と版を確認します。索引・題名・リンクだけを受け取った場合や、本文を取得できなかった場合に、参照済みとは報告しません。本文を読めたこと、内容を適切に適用できたこと、実画面の使いやすさを確かめたことは、それぞれ区別します。

## 閲覧・編集の案内

複数の概念を読む道筋は、`knowledge/` の外にある[「判断材料の選定」の案内](../topics/decision-material-selection.md)に置きます。この案内の[人向け閲覧ページ](../prototypes/decision-material-selection/index.html)と[案内のMarkdown](../prototypes/decision-material-selection/ai.md)は、案内の正本から生成します。個別概念の本文や補足を取り込んだ全文ではないため、概念を使うときはリンク先の `KNOWLEDGE.md` を読みます。

ディレクトリの構成と補足資料の役割は[知識の構造ガイド](../guideline/knowledge-structure.md)を参照します。これは資料の配置を揃える構造であり、ClaudeやCodexのスキルとしての呼び出しや実行は定義しません。

掲載・編集・採用の方針は[Repositoryの方針と利用ガイド](../guideline/README.md)、AIの作業は[AI向けの作業ガイド](../guideline/ai.md)に従います。内容の編集は正本で行い、生成物を直接編集しません。生成物の更新方法と公開手順は[開発・公開ガイド](../guideline/development.md)を参照します。
