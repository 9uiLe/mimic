# AI Slopの出典

2026-10-22に以下の本文の該当箇所を確認しています。
語の用法、企業の実務指針、研究は、根拠の種類と対象範囲が異なります。

| 本文・作例の説明 | 出典と該当箇所 | 範囲と解釈上の注意 |
| --- | --- | --- |
| slopは、通常AIによって大量に作られる低品質なデジタルコンテンツを指す。 | [Merriam-Webster — 2025 Word of the Year: Slop](https://www.merriam-webster.com/wordplay/word-of-the-year)：Slop。 | 語の定義・用法。UIの品質判定理論ではない。 |
| 方向を指定しない生成での画一化と、指示を変えた作例。 | [Anthropic — Improving frontend design through Skills](https://claude.com/resources/articles/improving-frontend-design-through-skills)：2025-11-12、冒頭、A general-purpose prompt、作例。 | 同社の実務知見と作例。全モデルでの発生頻度や介入効果の比較実証には広げない。 |
| 意味を持つ構造や順序に番号を使う。定型的な様式も依頼内容に必要なら使う。 | [Anthropic — frontend-design](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md)：Design principles、Process: plan, review against the brief, build, critique。 | 2026-10-22閲覧の可変なmain版。同社のデザイン指針。Mimicの実行契約や禁止部品表として採用しない。 |
| 画一化のリスクと介入案を扱う研究。 | [Shin et al. — Interrogating Design Homogenization in Web Vibe Coding](https://arxiv.org/html/2603.13036v1)：§3–5、§7。 | v1、2026-03-13。文献・ツール分析とリスク分析、介入の提案。介入効果の実証ではない。 |
| 静止画のUXの知覚評価と、作者性だけでは説明できない差。 | [Romero et al. — Usable but Conventional](https://arxiv.org/html/2605.15124v1)：§3、§4、§6。 | v1、2026-05-14。学生92名、10案、単一シナリオ、人間5案の作者1人。操作性能や日本語UIへの一般化をしない。 |
| 近接と余白によるまとまり。 | [Fluent 2 — Layout](https://fluent2.microsoft.design/layout#spacing-and-proximity)：Spacing and proximity。 | デザインシステムの配置指針。余白だけで分類の意味を伝えられるとは述べていない。 |
| カードは関連する情報の概念単位をまとめ、詳細へ導く。 | [NN/G — Cards: UI-Component Definition](https://www.nngroup.com/articles/cards-component/)：定義、4 properties、When Cards Are Useful。 | Page Laubheimer、2016-11-06。UIカードの用途。すべての囲みやAI生成物への一律の規則にはしない。 |

不要情報の競合と必要情報の保全については、独立した[Aesthetic and Minimalist Designの出典](../../aesthetic-and-minimalist-design/references/sources.md)を参照します。
入力ラベル・hint・Webの構造を保つ条件も、同出典表に対応を記載しています。

本文の「不要な要素／画一的な見た目」の区別と、既存デザインシステムを尊重する適用条件はMimicの説明上の整理です。
出典に共通する単一理論ではありません。説明例と短い指示はMimicが作成したもので、生成比較や利用者テストの結果ではありません。

[本文に戻る](../KNOWLEDGE.md)
