# デザインシステムの出典

2026年10月22日に以下の本文を確認しました。

| 出典URL | 実読した節・箇所 | 本文で支える主張 | 対象範囲・注意 |
| --- | --- | --- | --- |
| [GOV.UK Design System — Home](https://design-system.service.gov.uk/) | 冒頭 / Styles / Components / Patterns / Principles we follow / Community / Support | 他チームの知見を共有し反復作業を減らす目的。原則とスタイル・再利用部品・作業のパターンの関係、保守チームとコミュニティ。 | GOV.UKの政府サービス向けDesign Systemの構成と運営。全デザインシステムの必須構成ではない。 |
| [GOV.UK Design System — Patterns](https://design-system.service.gov.uk/patterns/) | 冒頭の定義 / Ask users for… / Help users to… / Pages | パターンは特定の利用者の作業やページの種類を扱い、部品の組み合わせと文脈への適応を文章と実装例で説明する。 | GOV.UKのパターンの定義と具体的な項目。本文は各パターンの細則や効果を説明したものではない。 |
| [GOV.UK Design System — Get started](https://design-system.service.gov.uk/get-started/) | Using styles, components and patterns / GitHub discussions about styles, components and patterns | 調査した条件を利用・適応の判断へ使うこと、議論中の案には未検証のものがあること、利用するサービスでの調査。 | GOV.UKの利用者向けガイド。既存の知見と個別サービスでの確認を区別する根拠。 |
| [GOV.UK Design System — Contribution criteria](https://design-system.service.gov.uk/community/contribution-criteria/) | Proposing a component or pattern / Developing a component or pattern | 有用性と重複の確認、使いやすさ・一貫性・適応性を確認して共有物を公開すること、調査した文脈を明示すること。 | GOV.UKへの貢献と公開の基準。同組織のコード規約、承認手順や調査条件を一般の製品に一律要求しない。 |

原則・スタイル・部品・パターンの表は、GOV.UKの構成を説明するMimicの整理です。
デザインシステムの唯一の定義や、普遍的な四層構造として扱いません。
必要に応じて共有物を育てる説明、例外の理由、更新が使う側の判断に関わるという説明は、同事例の利用・貢献・保守を結び付けた読み方です。
特定の成長手順の有効性を実証したものではなく、すべての組織に同じ運用を求めるものでもありません。

Tokenの定義や交換形式は、独立した[Design Tokenの本文](../../design-tokens/KNOWLEDGE.md)と出典に委ねます。
GOV.UKの構成にTokenが必須の層として定められている、という説明ではありません。

## 製品の複雑化と保守の出典

2026年11月19日に以下の該当箇所を確認しました。

| 資料と箇所 | 支える判断と限界 |
| --- | --- |
| [DTCG Format 2025.10](https://www.designtokens.org/tr/2025.10/format/) の Translation tool、Alias、Composite、および [Resolver 2025.10](https://www.designtokens.org/tr/2025.10/resolver/) の Introduction | Tokenの交換表現、参照、複合値と、適用文脈による値の切り替え。実装言語や必要なテーマ数を決める製品要件ではない。 |
| Atlassian Design System の [Color](https://atlassian.design/foundations/color)、[Spacing](https://atlassian.design/foundations/spacing)、[Radius](https://atlassian.design/foundations/radius) | 配色の役割・強調度・操作状態とテーマ、8px基準の分数倍を含む尺度、用途別の角丸。Atlassian製品の具体例として扱う。 |
| [GOV.UK — Button, Warning buttons](https://design-system.service.gov.uk/components/button/#warning-buttons)、上表のPatternsとContribution criteria | 重大で容易に取り消せない操作に警告ボタンを限定する例。利用条件は部品の資料にも置ける。課題・ページの粒度と共有候補の採否はPatternsとContribution criteriaに基づく。 |
| [Atlassian — Release phases](https://atlassian.design/release-phases) | Early Access、Beta、General Availability、Intent to Deprecate、Deprecated。成熟度の伝達、廃止前の告知、代替と移行の案内。名称や版の運用は同社固有。 |
| [USWDS — Maturity model](https://designsystem.digital.gov/maturity-model/) | 原則・ガイダンス・コードの段階的採用と、利用者の観察による評価。既存システムを導入する組織への指針として読む。 |
| [Seckler et al., Designing Usable Web Forms（CHI 2014、Table 3）](https://doi.org/10.1145/2556288.2557265)・[著者版](https://edoc.unibas.ch/server/api/core/bitstreams/a4d3ea7f-518a-4ca4-b13a-f799f6781740/content) | 元のフォームと複数の改善を組み合わせた版で初回送信を比較。特定の部品や保守体制の因果効果には分解できない。 |

赤いボタンを分類して移行する例と、局所修正・ガイド改訂・共通部品拡張を選ぶ手順は、これらの資料をもとにしたMimicの適用例です。

[本文に戻る](../KNOWLEDGE.md)
