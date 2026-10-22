# レイアウトの余白の出典

## 出典と対応する説明

| 本文の主張 | 出典と該当箇所 | 出典が扱う範囲 |
| --- | --- | --- |
| 近接と間隔の反復は知覚上の関係を伝え、空き領域はまとまりや相対的な焦点を表す。Fluentは固有の間隔尺度と例外値を持つ。 | [Fluent 2 — Layout](https://fluent2.microsoft.design/layout)：Spacing and proximity、Creating hierarchy with empty space、Global spacing ramp。 | Microsoft Fluentの配置指針。尺度や強調の説明を普遍的な数値規則にしない。 |
| 要素・部品間の空き領域は関係、階層、密度に関わる。内側・外側の間隔を扱い、画面の一部が密であることも許容する。Carbonは独自の段階的な尺度を持つ。 | [Carbon — Spacing](https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview)：Introduction、Spacing、Designing with space。 | IBM Carbonの設計指針。CarbonのToken値や密度の扱いを、すべての製品の最適解としない。 |
| 同じデザインシステム内に、画面幅で変わる余白尺度と固定の余白尺度がある。 | [GOV.UK Design System — Spacing](https://design-system.service.gov.uk/styles/spacing/)：Responsive spacing、Static spacing。 | GOV.UKの設計・実装指針。尺度の具体値を一般のUIへ移さない。 |
| CSSのboxには内容・padding・border・marginがあり、paddingは内容と境界の間、marginは境界の外側にある。 | [CSS Box Model Module Level 4（2024-08-04）](https://www.w3.org/TR/2024/WD-css-box-4-20240804/)：§2 The CSS Box Model、§3 Margins、§4 Padding。 | W3C Working Draft。WebのCSS boxの定義であり、デジタルUI全般の設計分類ではない。 |
| CSSの`gap`はコンテナ内の項目間の溝を指定する。margin、padding、配置によって見た目の距離はさらに広がりうる。 | [CSS Gaps Module Level 1（2026-06-24）](https://www.w3.org/TR/2026/WD-css-gaps-1-20260624/)：§2.1 Row and Column Gutters、§2.2 Gap Shorthand。 | W3C Working Draft。grid・flex・multi-columnなどのWebレイアウトについての仕様。 |

コンポーネント間・グループ間・セクション間・外周という区別と[予定一覧の例](../examples/component-spacing.md)は、Mimicによる説明用の整理と作例です。単一の原典が提唱した分類や、間隔の効果を測定した結果ではありません。

[本文に戻る](../KNOWLEDGE.md)
