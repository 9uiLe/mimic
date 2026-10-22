# Typographyの出典と説明の範囲

本項目の版は[本文](../KNOWLEDGE.md)で確認します。以下の原典・公式資料を2026年10月22日に確認しました。本文の論点の並びはMimicによる編集であり、どれか一つの資料の正式な分類ではありません。

| 本文の主張 | 出典と該当箇所 | 範囲・留意点 |
| --- | --- | --- |
| 同じ`font-size`でも書体によって字面の見かけの大きさが異なる。ラテン文字ではx-heightが一因。 | [W3C CSS Fonts Module Level 4、2026-10-16 Working Draft §2.5・§2.6](https://www.w3.org/TR/2026/WD-css-fonts-4-20261016/#font-size-adjust-prop) | CSSの仕様草案。§2.6の説明は主に大小文字を区別する文字体系に関する。x-heightを日本語字体の万能な評価尺度としない。 |
| 和欧混植で使う欧字の選択、字間、単語の分割、約物や改行位置の扱い。 | [W3C JLREQ、2020-08-11 Working Group Note §3.2.1–3.2.2](https://www.w3.org/TR/2020/NOTE-jlreq-20200811/#japanese_and_western_mixed_text_composition)、[§3.2.6](https://www.w3.org/TR/2020/NOTE-jlreq-20200811/#handling-of-western-text-in-japanese-text-using-proportional-western-fonts)、[§3.1.10](https://www.w3.org/TR/2020/NOTE-jlreq-20200811/#unbreakable-character-sequences) | 主な対象は一般書籍。技術固有の実装方法は扱わない。四分アキなどの記述を全UIに義務付けない。 |
| 文字サイズと太さを考慮する。text styleで役割を表し、Dynamic Typeで文字拡大に応じる。拡大時には切り詰めや重なりを確かめる。 | [Apple Human Interface Guidelines — Typography、Ensuring legibility / Conveying hierarchy / Using system fonts / Supporting Dynamic Type](https://developer.apple.com/design/human-interface-guidelines/typography.md) | Apple向けの公式指針。リンク先は公式のMarkdown版。Dynamic Typeの対象はiOS、iPadOS、tvOS、visionOS、watchOSであり、同資料はmacOSを対象外とする。掲載サイズは他環境の最小値ではない。 |
| 短文用と長文用のbody stylesで行高を分け、作業用と表現用のtype setsを用意する。 | [Carbon Design System — Typography、Overview / Body styles](https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets)、[Style strategies](https://www.carbondesignsystem.com/building-blocks/foundations/typography/style-strategies) | IBM PlexとCarbonの設計体系。productiveの基準14px、expressiveの基準16pxは各用途の設定例で、本文一般の推奨値ではない。 |
| 役割ごとの文字スタイルを組として扱い、各値から基礎Tokenを参照できる。DTCGのtypography複合値は書体・サイズ・太さ・字間・行高の五項目を持つ。 | [DTCG Format 2025.10 §9.8 Typography](https://www.designtokens.org/tr/2025.10/format/#x9-8-typography)、[§7.1 Aliases / References](https://www.designtokens.org/tr/2025.10/format/#x7-1-reference-syntax) | 交換形式の仕様。役割名やToken階層、数値、対象環境の決定はMimicの提示方針または個別設計。書体とfallbackの選定や可読性は形式準拠からは決まらない。 |
| 作例の`rem`はWebではroot要素の文字サイズを基準にする。AppleのDynamic Typeはtext styleを通じて文字サイズ変更に対応する。 | [W3C CSS Values and Units Module Level 4 §6.1.1](https://www.w3.org/TR/css-values-4/#font-relative-lengths)、[Apple — Scaling fonts automatically](https://developer.apple.com/documentation/uikit/scaling-fonts-automatically) | Webの単位とAppleのプラットフォーム機能は対象が異なる。作例の固定値をDynamic Typeへそのまま移す指示ではない。 |
| 行高と行長を文章の読み方に関わる要素として扱う。 | [IBM Design Language — Type basics、Leading / Comfortable reading](https://www.ibm.com/design/language/typography/type-basics/) | IBMの文字設計指針。行長の記述から日本語UI全般の最適字数を導かない。 |
| テキストは例外を除き200%まで拡大しても内容・機能を失わない。 | [WCAG 2.2、2024-12-12 Recommendation、SC 1.4.4 Resize Text](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#resize-text) | WebコンテンツのLevel AA達成基準。キャプションと文字画像は同基準の例外。 |
| 利用者による行高・段落後・字間・単語間の変更で内容・機能を失わない。指定値は作者の初期値の義務ではない。 | [WCAG 2.2 SC 1.4.12 Text Spacing](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#text-spacing)、[Understanding SC 1.4.12、Note 1 / Author Responsibility](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html#author-responsibility) | 対象属性を扱うマークアップ言語のWebコンテンツについてのLevel AA基準。行高1.5倍、段落後2倍、字間0.12倍、単語間0.16倍の四属性だけを同時に変更する条件。言語・文字体系で使用しない間隔属性には例外。Understandingは規範でない解説資料。 |

WCAG 2.2の[SC 1.4.8 Visual Presentation](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#visual-presentation)は、Webのテキストブロックを利用者が調整できる仕組みについて、CJKの40字幅や行間などをLevel AAAの条件として挙げます。作者の初期値を指定する条件ではなく、日本語UIの普遍的な最適行長として本文には採用しません。

[申請画面の例](../examples/mixed-ui-copy.md)はMimicの作例です。原典の実験や、個別UIに対する利用者テストではありません。
