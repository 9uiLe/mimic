# Mimic

デジタルUIに関するデザインの知識・概念・思想・哲学を言語化し、人とAIが理解できるように説明する知識データベースです。Web、iOS、Androidなどに共通する考え方を扱います。

## 収録している知識

| 本文 | 説明すること |
| --- | --- |
| [Ecological Interface Design](knowledge/ecological-interface-design/KNOWLEDGE.md) | 作業領域の制約をインターフェースに表す設計枠組み |
| [外的表象](knowledge/external-representations/KNOWLEDGE.md) | 外部環境に表された情報と、頭の中の処理との関係 |
| [概念モデル](knowledge/conceptual-models/KNOWLEDGE.md) | 構成要素を結び、仕組みや動作を理解する枠組み |
| [グルーピング](knowledge/grouping/KNOWLEDGE.md) | 意味上の分類、近接によるまとまり、名称や見出しの役割 |
| [視覚的な優先順位](knowledge/visual-hierarchy/KNOWLEDGE.md) | 相対的な強調、内容の階層、業務上の優先度の違い |

一つの概念・思想・哲学ごとにディレクトリを用意し、`KNOWLEDGE.md` を入口としています。出典や説明例は、同じディレクトリ内の必要な補足へリンクします。これらが知識の正本です。収録している５件の説明文は正式採用済み（`accepted`）です。版と採用状態は、各 `KNOWLEDGE.md` の先頭で確認できます。

## 読み方・使い方

人は上の一覧から関心のある概念の入口を読みます。複数の概念を横断して読むための[「判断材料の選定」の案内](topics/decision-material-selection.md)もあります。この案内は[閲覧ページ](prototypes/decision-material-selection/index.html)でも読めます。[GitHub Pages](https://9uile.github.io/mimic/)では、同じ案内から生成したページを公開します。個別の概念はMarkdownで参照します。

AIは[知識の入口](knowledge/README.md)から必要な本文を読み、版・採用状態・出典の対象範囲を確認します。索引や要約だけを読んで、本文を参照済みとは扱いません。

個別のUIに適用するときは、その案件の目的や条件に照らして考えます。案件固有の仕様・設計書・レビュー資料は案件側に置きます。

## 詳しいガイド

- [Repositoryの方針と利用ガイド](guideline/README.md)：掲載する内容、説明の品質、採用の考え方。
- [AI向けの作業ガイド](guideline/ai.md)：知識の参照・編集・確認・報告の手順。
- [知識の構造ガイド](guideline/knowledge-structure.md)：概念ごとのディレクトリ、固定の入口、補足資料の役割。
- [開発・公開ガイド](guideline/development.md)：生成物の更新、ローカル検査、GitHub Pagesへの公開。

## ライセンス

このRepositoryは[MITライセンス](LICENSE)で提供します。参照先の資料と依存ライブラリには、それぞれの権利・ライセンス条件が適用されます。
