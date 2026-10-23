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
出典に共通する単一理論ではありません。説明例と関連概念を読むための問いはMimicが作成したもので、生成比較や利用者テストの結果ではありません。

## 改善指示を読むための追加資料

以下は2026-10-24に本文の該当箇所を確認した資料です。冒頭の2026-10-22の確認記録とは区別します。
これらはそれぞれの体系・対象における指針や達成基準であり、10処方全体の効果を検証した資料ではありません。
元のX投稿のURLと文脈は未確認です。以下の資料を投稿者の意図の根拠にはしません。

| 説明を支える範囲 | 出典と確認箇所 | 対象と注意 |
| --- | --- | --- |
| 利用者の言葉、短い文案、説明追加前のUI改善 | [GOV.UK — Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)：Think about alternatives before you add more words、Keep copy short and direct、Tone。 | 英国行政サービスの指針。語り口を全ブランド・娯楽へ一般化しない。 |
| 色の段階と用途・状態の対応 | [Radix — Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)：Use cases、Steps 3–12。 | Radix Colorsの体系。例外と背景条件があり、任意の組合せのWCAG適合を保証しない。accent bordersも用途に含む。 |
| 既製の色体系とブランド色の併用 | [Radix — Composing a color palette](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette)：Custom brand colors、Choosing semantic scales。 | 独自ブランドscaleをgray・semantic scaleと並置する選択肢。全色を既製scaleに置き換える必須則ではない。 |
| 識別に必要な境界等のコントラストと細線の限界 | [W3C — Understanding SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：Success Criterion、IntentのNote、Boundaries。 | WCAG 2.2のAA基準の参考解説。必要な視覚情報と隣接色は原則3:1。装飾線すべてへの要求ではなく、0.5px固定を支持しない。 |
| 操作に伴う非本質的な動きの無効化 | [W3C — Understanding SC 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)：Success Criterion、Intent、Examples。 | WCAG 2.2のAAA基準の参考解説。操作起因のmotion animationが対象で本質的な動きは例外。250msで負担が解消する保証ではない。 |
| 重大な結果を伴う操作の誤り防止 | [W3C — Understanding SC 3.3.4 Error Prevention (Legal, Financial, Data)](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html)：Success Criterion、Intent。 | WCAG 2.2のAA基準の参考解説。法的義務・金銭取引、利用者が操作できる保存データの変更・削除、試験回答の送信が対象。取消可能、入力検査と修正機会、確定前の見直し・確認・修正の少なくとも一つ。すべての保存や単純な作成・編集への確認要求ではない。 |
| 必要な文字スタイルの選択と形・影の役割 | [Android Developers — Material Design 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3)：Typography、Shapes、Emphasis、Elevation。 | Android／Composeの実装指針。15文字スタイルの全使用は求めない。形は部品・状態・ブランド、影とトーンは階層も表す。sp・dpとpxは別。 |
| 整列や余白等による関連と段階的開示 | [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout.md)：Visual hierarchy、Adaptability。 | Appleプラットフォーム向けの公式Markdown本文。表示・文字サイズ・言語で確認する。操作数の最少化を定めない。 |
| 非対称アイコンの視覚的重心の補正 | [Apple HIG — Icons](https://developer.apple.com/design/human-interface-guidelines/icons.md)：Custom icons、optical alignment。 | 主にカスタムUIアイコン。全要素へ同じずらし量を当てはめる規則ではない。公式Markdown本文で確認。 |
| 窓や入れ子の容器と形状の調和 | [Apple WWDC25 — Build an AppKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/310/)：公式transcriptのApp structure、Controls。 | macOS Tahoe／Liquid Glassの文脈。同心性を全環境の角丸規則へ一般化しない。 |
| 変化に応じた時間・曲線の使い分け | [Material Design 1 — Duration and easing](https://m1.material.io/motion/duration-easing.html)：Dynamic durations、Common durations、各curve。 | 旧版の歴史的資料。距離や変化により調整し、進入・退出等を区別する。具体値を現行の推奨値へ転用しない。 |

「目的・必要情報・伝えたい印象を確かめ、役割を一貫して表す」という橋渡しと、10処方の条件・反例はMimicの編集上の整理です。
中点の一律禁止、0.5px、250ms、12px、3〜4種の普遍的最適性、AI生成特有の原因や削除による効果を確認したものではありません。

[本文に戻る](../KNOWLEDGE.md)
