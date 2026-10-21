---
id: decision-material-selection
title: 判断材料の選定
status: proposed
version: "0.2.0"
scope: general-digital-ui
related:
  - grouping
  - visual-hierarchy
---

# 判断材料の選定

## 何を提示するかを考えるための概念

この文書は、利用者が判断に使う情報の内容と提示の仕方を、既存の概念から説明します。「判断材料の選定」は複数の考え方を扱う題目であり、一つの理論の名称ではありません。以下では、それぞれの立場と対象範囲を区別します。

## 情報内容と表現

VicenteとRasmussenのEcological Interface Design（EID）は、複雑な人間機械システムのための設計枠組みです。原典は、インターフェースに含める情報の内容・構造と、その情報を人へ伝える表現の問題を区別します。

EIDで用いる抽象化階層は、同じ作業領域を異なる抽象度で記述し、各層を目的と手段の関係で結びます。上位ではシステムの目的に関わる関係を、下位では物理的な実装に関わる要素を表します。背景には、運転者が想定外の異常にも対処できるよう、作業領域の制約を表現するという課題があります。一般のUIで表示項目を減らす手順や、適切な項目数を定めた理論ではありません。

## 外的表象と、意味を理解する枠組み

ZhangとNormanは、認知的な課題を、頭の中の情報と外部環境の情報の相互作用として捉えます。図や物の配置などの外的表象は、記憶を助けるだけでなく、直接知覚できる情報や可能な操作を変え、課題の進め方にも関わるという立場です。原典ではハノイの塔を分析・実験の対象にしています。

一方、Normanの著者解説は、デザインを通じた意味の伝達を論じます。同じ物でも、置かれた文脈によって役割の解釈が変わります。概念モデルは、構成要素を結び、仕組みと動作の理由を理解する枠組みです。製品そのものや説明が伝える情報を通じて、利用者がその理解を組み立てると説明しています。外に情報があることと、その意味を理解できることは、区別して考えられます。

## 情報を段階的に示す

情報を最初からすべて見せず、操作に応じて詳細を示す部品もあります。Carbonのデータテーブル指針は、行の展開領域を補足情報や追加の取得時間が必要なデータに使うとしています。展開領域が窮屈なら、専用ページやサイドパネルなども選択肢に挙げています。

GOV.UKのアコーディオン指針は、隠れた内容に気づかない人や操作を理解しない人がいることを説明し、全員が見る必要のある内容には使わないとしています。これらは、それぞれの部品で何を隠すかに関する指針です。すべてのUIで常時表示と詳細表示の境界を定める共通規則ではありません。

## 短い説明例

外的表象と文脈の説明例として、架空の温度表示を考えます。地点AとBの温度を並べる表示では、差を知るために二つの値を照合します。「AとBの温度差」を示す表示では、差が外に表されています。後者でも、比較する地点や単位は意味の理解に関わります。これは表示と頭の中の処理の違いを説明する例であり、どちらの表示が優れているかを示すものではありません。

## 関連する知識

[グルーピング](grouping.md)は、情報をどのような意味のまとまりとして構成し、表すかを扱います。[視覚的な優先順位](visual-hierarchy.md)は、提示する情報の相対的な強調や関係の表し方を扱います。情報の内容、まとまり、強調は関連しますが、同じ概念ではありません。

## 出典と説明の範囲

- [Vicente & Rasmussen — Ecological Interface Design: Theoretical Foundations（1992）](https://backend.orbit.dtu.dk/ws/files/158017888/SMC.PDF)：§II.B、§III.A–B。EIDにおける情報内容と表現の区別、抽象化階層とその背景。
- [Zhang & Norman — Representations in Distributed Cognitive Tasks（1994年プレプリント）](https://worrydream.com/refs/Zhang_2004_-_Representations_in_Distributed_Cognitive_Tasks.pdf)：The Nature of External Representations、原稿29–30頁。外的表象の役割。
- [Don Norman — Design as Communication](https://jnd.org/design-as-communication/)：Communication & Context、Conceptual Modelsの各節。文脈、概念モデル、製品を介した意味の伝達に関する著者の説明。
- [Carbon — Data table guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)：Expandable。データテーブルの展開領域の用途。
- [GOV.UK Design System — Accordion](https://design-system.service.gov.uk/components/accordion/)：When not to use this component。内容を隠す問題と、この部品を使わない条件。

章立てと温度表示の例は、この文書の説明用の整理です。上記の出典が、一つの情報選定手法としてまとめて提唱したものではありません。
