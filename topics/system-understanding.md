---
id: system-understanding
title: システムを理解するための情報提示
version: "1.0.0"
scope: system-understanding-and-information-presentation
related:
  - mental-models
  - conceptual-models
  - cognitive-load
  - multimedia-learning
  - explanation-design
  - external-representations
---

# システムを理解するための情報提示

## この案内の目的

人がシステムや仕組みを理解する過程について、認知科学・学習研究・HCIの知識を探す入口です。
AIが「どんな情報を見せるか、何を見せないか、どんな形式で見せるか」を判断する際の参照先を示します。
本文・出典の説明を置き換える要約や、あらゆるUIに適用できる自動選択アルゴリズムではありません。

## 理解が形成される過程から読む

[メンタルモデルの形成と修正](../knowledge/mental-models/KNOWLEDGE.md)は、既有知識と新しい説明の関係、自己説明、比較による転移、誤解の修正を扱います。
「分かった」という感覚、見た例の記憶、条件を変えたときの予測は区別して読みます。
[概念モデル](../knowledge/conceptual-models/KNOWLEDGE.md)は設計者のモデルと利用者のモデル、製品が伝える情報の違いを補います。

理解の過程を「部品を覚える→説明を読む→理解完了」という固定の順番にはしません。
どの過程が問題かを考える際には、用語・関係の不足、既有の誤解、変化の追跡、別の場面への適用を区別して本文へ進めます。
これらの観点の並べ方は編集上の整理であり、引用した論文に共通する段階理論ではありません。

## 何を見せるか・何を後に回すか

| 情報選択で知りたいこと | 読む知識と、判断時に区別すること |
| --- | --- |
| 利用者は何を説明・予測できる必要があるか | [メンタルモデル](../knowledge/mental-models/KNOWLEDGE.md)。部品名の記憶と、関係を使った推論を区別する。 |
| なぜ利用者の期待と結果が違うのか | [説明の選択と忠実さ](../knowledge/explanation-design/KNOWLEDGE.md)。比較対象、既知の条件、説明する差分を確認する。 |
| 初めての人に必要な説明は何か | [認知負荷](../knowledge/cognitive-load/KNOWLEDGE.md)と[マルチメディア学習](../knowledge/multimedia-learning/KNOWLEDGE.md)。前提知識と、部品・関係を同時に処理する負担を読む。 |
| 詳細を減らすと説明が嘘になるか | [説明の選択と忠実さ](../knowledge/explanation-design/KNOWLEDGE.md)。対象への忠実さと説明範囲を区別する。 |
| どこに詳細を置き、どう見つけてもらうか | [判断材料の選定](decision-material-selection.md#情報を示す時点と部品の違い)。段階的な表示と、隠すと支障がある内容を読む。 |
| 見せた説明を使って答えを確認できるか | [説明の選択と忠実さ](../knowledge/explanation-design/KNOWLEDGE.md)。検証の負担、理解、判断成績、主観評価を分ける。 |

「画面から省く」「必要なときに開ける」「今は分からないので断定しない」は異なる扱いです。
[同期システムの作例](../knowledge/explanation-design/examples/synchronization.md)で、この違いと情報選択の理由を具体化しています。
作例の選択を、研究が実証した唯一の最適解として扱いません。

## どの形式で見せるか

形式は見た目の好みだけでなく、読み手が追う必要のある関係から検討できます。
[マルチメディア学習](../knowledge/multimedia-learning/KNOWLEDGE.md)で言葉と図の対応、事前学習、分割、アニメーションの条件を読み、
[外的表象](../knowledge/external-representations/KNOWLEDGE.md)で外に示す情報と頭の中の処理の違いを確認します。

| 読み取りたい関係 | 表現を調べる入口 |
| --- | --- |
| システムの境界と構成要素の責務 | [C4モデル](../knowledge/c4-model/KNOWLEDGE.md) |
| 処理の順序、相互作用、状態の変化 | [UML](../knowledge/uml/KNOWLEDGE.md) |
| データの移動と処理 | [データフロー図](../knowledge/data-flow-diagrams/KNOWLEDGE.md) |
| データの種類と関連 | [ER図](../knowledge/entity-relationship-diagrams/KNOWLEDGE.md) |
| 数量の比較、推移、分布 | [統計グラフ](../knowledge/statistical-charts/KNOWLEDGE.md) |

図種の選択、図を読める前提、説明対象に忠実な内容は別の論点です。
同じ図種でも、凡例、文章との対応、必要な前提によって読み取りの負担が変わります。
表に挙げた図種が常に文章や別形式より優れる、という比較実験の結果ではありません。

## AIが知識を適用するときの範囲

利用者の目的・既有知識・利用状況が不明なら、専門性や理解度を確定した属性として扱いません。
知識に基づく説明と、特定案件での表示の採用判断を分けて記録します。
案件の判断を残す場所は[設計判断台帳](https://github.com/9uiLe/mimic/blob/main/contracts/product-design.md)、適用の扱いは[AI向け利用手順](https://github.com/9uiLe/mimic/blob/main/contracts/agent-guide.md)に従います。
この案内を追加したことだけでは、機械可読な適用契約や自動評価器が追加されたことにはなりません。

## 調査範囲と出典

メンタルモデル、認知負荷、マルチメディア学習、人に向けた説明を中心に、原論文・レビュー・メタ分析を選んで確認しています。
文献の種類、確認箇所、主張との対応、一般化の限界は各本文の `references/sources.md` にあります。
既存本文と今回の文献を横断する案内であり、領域全体を網羅した系統的レビューではありません。
