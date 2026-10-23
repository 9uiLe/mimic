---
id: decision-material-selection
title: 判断材料の選定
version: "1.1.0"
scope: general-digital-ui
related:
  - ecological-interface-design
  - external-representations
  - conceptual-models
  - grouping
  - visual-hierarchy
  - aesthetic-and-minimalist-design
  - layout-spacing
---

# 判断材料の選定

## この案内について

利用者が判断に使う情報の内容と提示の仕方を考えるために、関連する知識へ進む案内です。「判断材料の選定」は複数の考え方を扱う題目であり、一つの理論の名称ではありません。各概念の定義・背景・対象範囲は、リンク先の `KNOWLEDGE.md` と、そこから参照する出典・説明例で読みます。この案内が、それらの本文をまとめて置き換えるものではありません。

## 情報の内容と表現

[Ecological Interface Design（EID）](../knowledge/ecological-interface-design/KNOWLEDGE.md)は、複雑な人間機械システムで情報の内容・構造と表現を考える枠組みを説明します。一般のUIで表示項目を減らす手順や、適切な項目数の理論としては扱いません。

## 外部の情報と、その意味の理解

[外的表象](../knowledge/external-representations/KNOWLEDGE.md)は、図や配置など外部環境にある情報と、内部と外部に情報が分散する認知課題との関係を説明します。[概念モデル](../knowledge/conceptual-models/KNOWLEDGE.md)は、構成要素を結び、仕組みと動作の理由を理解する枠組みを説明します。外に情報があることと、その意味を理解できることを区別して読みます。

## まとまりと強調

[グルーピング](../knowledge/grouping/KNOWLEDGE.md)は、情報をどのような意味のまとまりとして構成し、表すかを扱います。[視覚的な優先順位](../knowledge/visual-hierarchy/KNOWLEDGE.md)は、提示する情報の相対的な強調や関係の表し方を扱います。情報の内容、まとまり、強調は関連しますが、同じ概念ではありません。

## 情報の多さ・必要性・重要度から読む

文字・画像・ボタンについて「情報が多い」と感じるときは、何が多いのかと、何を理解・判断・操作する場面なのかを分けて読みます。
次は複数の知識を読む道筋であり、一つの理論の分類ではありません。

| 知りたいこと | 読む本文と理由 |
| --- | --- |
| 要素数・文章量・占有面積から、要否を決められるか | [Aesthetic and Minimalist Design](../knowledge/aesthetic-and-minimalist-design/KNOWLEDGE.md)で、量と、作業に必要な要素を保つことの違いを読む。文字・画像・操作の役割もここから読む。 |
| 何を強く見せるか、何が重要なのか | [視覚的な優先順位](../knowledge/visual-hierarchy/KNOWLEDGE.md)で、見た目が伝える重要さと、仕事の優先度を区別する。 |
| 同じ内容でも、混み合って見えるのはなぜか | [レイアウトの余白](../knowledge/layout-spacing/KNOWLEDGE.md)で、間隔、まとまり、情報密度の関係を読む。 |

[予定一覧の説明例](../knowledge/visual-hierarchy/examples/schedule.md)は、短い状態表示、会場の写真、操作ボタンを使って、量・役割・強調の違いを具体化した作例です。

## 情報を示す時点と部品の違い

Jakob Nielsenの[Progressive Disclosureの解説](https://www.nngroup.com/articles/progressive-disclosure/)は、基本的な選択肢を最初に示し、専門的な選択肢を求めに応じて示す考え方を説明します。Usability Criteria for Progressive Disclosureは、よく使う機能を先に示し、詳細への入口と、その先にある内容を分かりやすくすることを挙げています。

同記事のStaged Disclosure: One Step at a Timeでは、作業順に沿って情報を示す方法を区別しています。この場合、後に示す内容が同じか、より重要な場合もあります。後で示すこと、利用頻度が低いこと、重要度が低いことを同じ意味にはしません。

情報を最初からすべて見せず、操作に応じて詳細を示す部品もあります。[Carbonのデータテーブル指針](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)のExpandableは、行の展開領域を補足情報や追加の取得時間が必要なデータに使うとしています。展開領域が窮屈なら、専用ページやサイドパネルなども選択肢に挙げています。

[GOV.UKのアコーディオン指針](https://design-system.service.gov.uk/components/accordion/)のWhen not to use this componentは、隠れた内容に気づかない人や操作を理解しない人がいることを説明し、全員が見る必要のある内容には使わないとしています。

Nielsenの概念の解説と、Carbon・GOV.UKそれぞれの部品で何を隠すかに関する指針は、対象範囲が異なります。すべてのUIで常時表示と詳細表示の境界を定める共通規則ではありません。

## 出典とこの案内の範囲

各概念の出典と確認箇所は、それぞれの `KNOWLEDGE.md` から参照する `references/sources.md` に記載します。部品の説明は、上記のCarbonとGOV.UKの該当節に基づきます。
段階的な表示の考え方と作業順との違いは、Jakob Nielsen、2006-12-03の上記記事の定義、Usability Criteria for Progressive Disclosure、Staged Disclosure: One Step at a Timeに基づきます。NN/GとGOV.UKの該当箇所は2026-10-24に確認しています。

概念をつなぐ章立てはMimicの編集上の整理です。複数の出典が、一つの情報選定手法としてまとめて提唱したものではありません。
