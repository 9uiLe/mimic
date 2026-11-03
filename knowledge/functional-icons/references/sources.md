# 出典と説明の範囲

本文は、機能アイコンの意味と状態を説明するために、各組織の公式指針とライブラリの仕様を照合したものです。
一つの原典に共通する正式な分類や、特定のライブラリを採用するための比較評価ではありません。
Webで確認した提供内容の確認日は2026-11-03です。提供範囲や利用条件は更新され得ます。

## 原典と本文の対応

| ID | 原典と確認箇所 | 本文を支える範囲と注意 |
| --- | --- | --- |
| S1 | Apple HIG [Icons](https://developer.apple.com/design/human-interface-guidelines/icons)。Discussion、Best practices。Markdown版も確認。 | interface iconとapp iconの用途、認識しやすい比喩、簡潔さ、線の太さと隣接テキストとの一貫性、代替テキスト、標準部品では独自の選択版が不要な場合。Appleのプラットフォーム向け指針であり、全製品で全状態の画像を手作業する要求ではない。 |
| S2 | GNOME HIG [UI Icons](https://developer.gnome.org/hig/guidelines/ui-icons.html)。Finding UI Icons、When to Use UI Icons。 | 既存記号の再利用、慣習と周囲の文脈、認識できる場合にアイコンを使うこと、疑わしい場合のテキストラベル。ラベルとアイコンを原則として併用しない指針と、サイドバーなどの例外はGNOMEの立場であり、全製品へ強制しない。 |
| S3 | W3C WAI-ARIA APG [Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)。About This Pattern、WAI-ARIA Roles, States, and Properties。 | ミュートの名前を固定するトグルと、操作名を変更するボタンの違い。アクセシブルな名前、`aria-pressed`と`aria-disabled`の区別。Webのパターンであり、ネイティブの属性指定ではない。 |
| S4 | W3C WAI-ARIA APG [Disclosure (Show/Hide) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)。About This Pattern、WAI-ARIA Roles, States, and Properties。 | 閉じているときの右向き、開いているときの下向きの矢印・三角形という慣習と、`aria-expanded`による展開状態。矢印の向きをすべての言語・製品共通の必須条件にはしない。 |
| S5 | Google [Material Symbols guide](https://developers.google.com/fonts/docs/material_symbols)。What are Material Symbols?、FILL axis、Variable font with Google Fonts。 | 同じ記号の線・塗り、FILL軸の状態遷移への利用とアニメーション。任意のSVG同士の変形、AI制作の容易さ、すべてのオン・オフへの意味付けを保証する資料ではない。 |
| S6 | Lucide [What is Lucide?](https://lucide.dev/guide/)。Available Icons、Complete Set of Icons。[Filled Icons](https://lucide.dev/guide/react/advanced/filled-icons)。 | 状態・バリエーションの提供と、認識性・一貫性。Filledは公式にサポートせず、一部の図形にfillを指定できること。全記号の塗り版の提供へ拡大しない。 |
| S7 | Lucide [Design language](https://lucide.dev/contribute/icons/design-principles)。Keep at least 2 pixels between elements、Reuse established shapes。[bell-off.svg](https://github.com/lucide-icons/lucide/blob/main/icons/bell-off.svg)の公開SVGパス。 | 要素間の間隔と基本形の再利用。SVGは斜線と途切れた輪郭の実例として読む。斜線付近の隙間による理解の改善を実証した研究ではなく、寸法を他の体系へ流用しない。 |
| S8 | ServiceNow Horizon [Creating icons](https://horizon.servicenow.com/workspace/foundations/icons/creating-icons)。Modifiers、Other DetailsのOff Slash。 | 付加記号が状態などの意味を加えること、オフの斜線の向き・長さ、基本の図形と同方向の場合の例外。Horizonの制作規則であり、全ライブラリ共通の斜線方向ではない。 |
| S9 | Hugeicons [Icon styles](https://hugeicons.com/styles)。Stroke icons、Solid icons、Twotone icons、Duotone icons、Bulk icons。 | 線・塗りを含むスタイルの提供例。全スタイルの無償利用、全記号の全状態、他ライブラリより優れるという評価は確認範囲に含めない。 |
| S10 | Remix Design [Remix Icon公式Repository](https://github.com/Remix-Design/RemixIcon)。READMEの冒頭、Webfont UsageのUse。 | OutlinedとFilled、24×24グリッド、`-line`と`-fill`の命名。スタイルの対を、全機能の全状態を表す組と同一視しない。 |
| S11 | W3C [Understanding SC 2.3.3: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)。Success Criterion、Intent、Key Terms。 | WebのレベルAAAで、操作に応じる不要なモーションアニメーションを無効化できること。機能・情報に不可欠な動きの例外があり、形・位置・大きさの知覚を変えない色や不透明度のみの変化まで同じ対象とはしない。 |

## 説明上の整理と未確認事項

「テキストの意味の延長」は、図形が言葉と対応する機能・状態を伝える役割を説明する言い換えです。
AppleやGNOMEの文言の引用、文字の併記を必須にする規格として扱っていません。
状態の表はS3からS5、S8の対象を比較するためのMimicの整理です。
線・塗りを全製品共通のオン・オフへ割り当てる規則ではありません。

本文の`bell-off`の読み取りは公開SVGの構成の説明です。
斜線と元の形の分離を説明できても、その隙間の効果を利用者で測定した結果ではありません。
「表現力が美観より重要」は意味の伝達を設計の条件として説明し、美観を不要とする一般則にはしていません。

「ほとんどのアイコンライブラリが状態を組で提供する」という割合は確認していません。
AIによる制作時間や品質の比較も行っていません。
これらを確定した知識にせず、確認できたバリエーションと状態遷移の仕組みを記載しています。

[本文に戻る](../KNOWLEDGE.md)
