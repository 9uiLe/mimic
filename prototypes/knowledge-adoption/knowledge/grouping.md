---
id: grouping
title: グルーピング
status: proposed
version: "0.2.0"
scope: general-digital-ui
related:
  - decision-material-selection
  - visual-hierarchy
---

# グルーピング

グルーピングは、関連する情報や要素をひとまとまりとして扱うことです。この項目では、デジタルUIにおける意味上の分類、配置によって知覚されるまとまり、まとまりを表す名称を区別して説明します。

## 意味に沿って情報を組織する

意味上の分類は、情報のどの関係を取り上げてまとめるかという構成の問題です。GOV.UKのコンテンツ指針は、利用者が特定のトピックや作業を調べられるように、似た内容をまとめると説明しています。トピックは階層的に組織され、下位へ進むほど内容が具体的になります。これはGOV.UKのコンテンツを組織する指針です。[GOV.UK：冒頭・Topic tagging](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/organise-group-govuk-content/#topic-tagging)

同指針の文書コレクションは、ある一組の内容を一か所で閲覧する利用者の必要があり、他の形式では満たせない場合に使うものです。関連があるという理由だけで、すべてを同じ形式の集合にするという指針ではありません。[GOV.UK：Document collections](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/organise-group-govuk-content/#document-collections)

## 近接と余白で関係を伝える

Fluent 2のレイアウト指針では、近くにある要素は意味のある関係を持つものとして知覚され、間隔が広がると、その関係が弱く知覚されると説明しています。余白は、関連する情報のまとまりを表し、線などの区切りを使わずに内容を分節する手掛かりになります。[Fluent 2：Spacing and proximity](https://fluent2.microsoft.design/layout#spacing-and-proximity)

近接は、画面上で関係を感じ取るための表現です。どの項目が同じトピックに属するかという意味上の分類と、近くに配置することは役割が異なります。配置によって関係を示せても、それだけで分類の意味を説明したことにはなりません。

## 名称と見出しで内容を説明する

まとまりの名称は、その集合が何を表すかを言葉にします。W3CのWCAG 2.4.6は、見出しとラベルが主題または目的を説明することを求めています。その解説では、明確な見出しは内容と構成の理解を助け、ラベルは個々の構成要素を識別する手掛かりになると説明しています。グループ名を見出しとして使う場合も、含まれる内容を適切に表す言葉が関わります。[W3C：Success Criterion・Intent](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html#intent)

この達成基準は、見出しやラベルが存在する場合の説明内容を扱います。すべてのまとまりへの見出しの追加や、正しいマークアップ自体を定めるものではありません。

## 説明用の例と関連概念

架空の予定を「今日・明日」でまとめると日時の関係を、「仕事・私用」でまとめると活動の区分を表します。各まとまりの間隔は視覚的な関係を、見出しは分類の意味を伝えます。これは三つの役割を説明する例であり、どちらの分類が探しやすいかを示すものではありません。

[判断材料の選定](decision-material-selection.md)は何を伝えるかを、[視覚的な優先順位](visual-hierarchy.md)は何を相対的に強く見せるかを扱います。情報をまとめること自体は、情報を除くことや重要度を決めることとは異なります。

## 出典と説明の範囲

2026年10月22日に、本文でリンクしたGOV.UK、Fluent 2、W3Cの公式資料の該当節を確認しました。GOV.UKは政府サイトのコンテンツ指針、Fluent 2は同デザインシステムの配置指針、W3CのUnderstanding文書は達成基準の解説です。三つの役割への整理と予定の例は、この項目の説明用に編集したもので、単一の原典にある分類ではありません。
