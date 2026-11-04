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

## 削除と判断委任の指示を読むための資料

以下は2026-11-04に該当箇所を確認した資料です。
[2つのプロンプトの説明例](../examples/ui-decisions.md#削除と判断委任のプロンプトを読む)は、依頼者が提示した文を題材にしています。
紹介元のURL、作者、文脈は未確認であり、以下の資料をその出典や作者の意図の根拠にはしません。

| 説明を支える範囲 | 出典と確認箇所 | 対象と注意 |
| --- | --- | --- |
| 説明追加前にUI自体を改善すること、短く直接的な文案 | [GOV.UK — Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)：Think about alternatives before you add more words、Keep copy short and direct。 | 英国行政サービスの文案指針。タグライン、補助文、ラベルの一括削除を求めるものではない。 |
| 入力条件の提示と、補助情報の入力欄への関連付け | [W3C WAI — Form Instructions](https://www.w3.org/WAI/tutorials/forms/instructions/)：Overview、Overall instructions、In-line instructions。 | Webフォームの実践的な解説。必須・任意や入力形式等を扱う。配置の整理だけで必要な説明を省けるという根拠にはしない。 |
| 利用者の目的、提供者・支援者のニーズ、仮定と調査の区別 | [GOV.UK — Learning about users and their needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs)：Understanding user needs、Researching users and their needs、Validating user needs。 | 英国政府のサービス開発指針。DX・AXの定義や、エージェントの判断性能を扱う資料ではない。 |
| 問題と目標の明確化、利用文脈、変更に関わる制約 | [GOV.UK — How the discovery phase works](https://www.gov.uk/service-manual/agile-delivery/how-the-discovery-phase-works)：Set a goal for your discovery、Understanding users and their context、Understanding constraints。 | 英国政府のdiscoveryの指針。全製品に同じ優先順位を定めたり、すべての利点の同時達成を保証したりするものではない。 |
| 具体的な課題を試す利用者の観察と、その対象条件 | [GOV.UK — Using moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)：冒頭、Plan the sessions、Design the tasks。 | 進行役のいる利用者調査。自動テストとの比較実験や、回帰不具合がないことの保証ではない。 |

改善文例と優先順位、通知設定の確認対象はMimicが説明用に作成したものです。
UX・DX・AXの対象の整理も、この文例を読むためのもので、確立した分類や尺度として提示しません。
原典による推奨プロンプト、比較実験済みの生成手順、Repositoryやエージェントの実行契約にはしません。

[本文に戻る](../KNOWLEDGE.md)
