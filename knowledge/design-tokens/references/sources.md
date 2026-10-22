# 出典と説明の範囲

本概念の版は[本文](../KNOWLEDGE.md)で確認します。2026年10月22日に以下の箇所を確認しました。

## Token一般の定義と交換形式

| 出典・箇所 | 本文で支える説明 | 範囲・注意 |
| --- | --- | --- |
| [DTCG Format 2025.10 §2・§3.1](https://www.designtokens.org/tr/2025.10/format/#x3-terminology) | 名前と値、設計ツールと開発ツールの相互運用という背景 | Final Community Group Report。W3C Standardではない |
| [同 §3.6・§4・§5](https://www.designtokens.org/tr/2025.10/format/#x5-design-token) | 型、JSONの交換形式、名前・型・値 | 型はTokenまたは所属グループから指定できる。本文はファイル構文の網羅解説ではない |
| [同 §3.8・§7](https://www.designtokens.org/tr/2025.10/format/#x7-aliases-references) | 他のTokenを参照するalias、意味の関係 | 表のドット区切りをそのまま単一Token名の構文と解釈しない |
| [同 §8・§9](https://www.designtokens.org/tr/2025.10/format/#x8-types) | 色以外の寸法・時間・影・文字なども対象、余白・文字サイズのdimension型の作例 | 複合Tokenも含む。対応実装や変換の完成を意味しない |
| [同 §9.8 Typography](https://www.designtokens.org/tr/2025.10/format/#x9-8-typography)、[§8.2 Dimension](https://www.designtokens.org/tr/2025.10/format/#x8-2-dimension)、[§8.3 Font family](https://www.designtokens.org/tr/2025.10/format/#x8-3-font-family)、[§8.4 Font weight](https://www.designtokens.org/tr/2025.10/format/#x8-4-font-weight)、[§7.1 References](https://www.designtokens.org/tr/2025.10/format/#x7-1-reference-syntax) | typography複合Tokenの必須五項目、各値の型と単位、基礎Tokenへの参照 | `lineHeight`は単位なしのnumberでfontSizeの倍率として解釈することが推奨される。役割名と値の妥当性は仕様の対象外 |

## 色への適用例の根拠

| 出典・箇所 | 適用例で支える説明 | 範囲・注意 |
| --- | --- | --- |
| [Carbon — Color overview](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview) Implementing color・Themes・Interaction states | 役割と値の区別、themeで役割を保つ考え方、状態 | Carbon固有の立場。Carbonのpaletteや命名を一般則にしない |

基礎値（primitiveまたはreference）・semantic・componentの区別、余白・文字サイズの名前と値、説明表の書式はMimicによる整理・作例です。
色のpalette・役割Token、学習用の名前・配色は[色への適用例](../examples/color-presentation.md)に置いています。
DTCGの必須階層やCarbonのToken一覧ではありません。theme・stateの実装方式も本記事では決めません。
[適用例の数値確認](../examples/color-presentation.md#色対の数値確認)は、相対輝度・コントラスト比と判定についてリンク先のWCAG公式解説に基づき、Carbonの推奨配色の検証ではありません。
CSS出力とDTCG交換形式を区別し、交換形式への準拠を配色のアクセシビリティ保証と混同しません。
