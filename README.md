# Mimic

デジタルUIに関するデザインの知識・概念・思想・哲学を言語化し、人と AI が理解できるように説明する知識データベースです。

## 知識を読む

[知識の入口](knowledge/README.md)には概念の一覧と、本文から独立した[意味付き関係グラフ](relations/README.md)があります。AIは関係の型・向き・根拠を使って索引し、目的に応じて読む順序と範囲を決めます。

概念の説明は `knowledge/<概念ID>/KNOWLEDGE.md`、構造化した関係は `relations/graph.json`、関係型の意味は `relations/vocabulary.json` が正本です。説明に使う本文の版・対象範囲と必要な出典・例を確認します。索引やグラフだけを本文の代わりにしません。

[プロダクト全体のUI設計](topics/product-ui-design.md)は、必要な情報、情報構造、画面・遷移、共通の指針、確かめ方を関連付けて読むための案内です。

## 人向けの閲覧

[GitHub Pages](https://9uile.github.io/mimic/) 向けの閲覧ページには、概念一覧と[関係グラフ](https://9uile.github.io/mimic/graph/)を用意します。グラフで概念を探し、関係の根拠と本文・出典・例へ進めます。

## Repositoryの構成

| 場所 | 役割 |
| --- | --- |
| `knowledge/` | 概念ごとの本文・出典対応表・説明例 |
| `relations/` | 意味付き関係グラフ・関係型の語彙と利用案内 |
| `topics/` | 目的や題目に応じた横断的な案内 |
| `guideline/` | 利用・編集・表示・開発・品質検査の方針 |
| `scripts/` | 正本からの生成と検査。本文表示の既存CSSも保持 |
| `web/` | 人向け関係グラフのブラウザ用JavaScriptとCSS |
| `assets/` | Pagesで配布するフォント資産とライセンス |
| `tests/`・`.quality/` | 振る舞いの検査と、その条件・根拠 |
| `.github/` | GitHub Actionsの検査・公開処理 |
| `output/`・`_site/` | Git管理外の下書き・作業出力とPages生成物 |

概念のIDと本文の配置を保ち、知識の説明・関係の構造・閲覧表示をそれぞれの正本で管理します。詳しい境界は[知識の構造ガイド](guideline/knowledge-structure.md)に記載します。

## Repositoryの保守

内容・機能・運用を変更または点検するときは、以下を参照する。

- [Repositoryの方針と利用ガイド](guideline/README.md)
- [AI向けの作業ガイド](guideline/ai.md)
- [知識の構造ガイド](guideline/knowledge-structure.md)
- [開発・公開ガイド](guideline/development.md)

## ライセンス

この Repository は [MITライセンス](LICENSE) で提供します。

参照先の資料と依存ライブラリには、それぞれの権利・ライセンス条件が適用されます。
