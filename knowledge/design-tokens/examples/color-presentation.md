# Design Tokenの色への適用例

[Design Token本文](../KNOWLEDGE.md)の説明用にMimicが作成した例です。
名前とpaletteは作例であり、製品への推奨値やDTCG必須の階層ではありません。
以下の表は参照関係の読み方を示し、DTCG JSONやCSS出力のコードではありません。

## Carbonの立場：値より役割を共有する

[CarbonのColor overview](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview)は、Tokenを役割の識別子、themeをその役割に値を割り当てる仕組みとして説明しています。
Carbonではtheme間で役割を変えず、値を変えます。
この考え方では「どの色か」とともに「UIの何を担うか」を保つことが中心になります。

これはCarbonの色設計の思想です。すべてのTokenをこの役割構造にする普遍的な規則ではありません。
Carbonの主要操作色や具体的なpaletteを、どの製品にも共通の正解としては扱いません。
以下の作例にも、CarbonのToken名や配色をそのまま採用してはいません。

## 色の役割・theme・state

本例ではpaletteを色値の候補、役割Tokenを文字・背景などの用途を表す名前として分けます。
これはTokenの一般的な定義に必須の区分ではありません。
部品固有の割り当てが必要ならcomponent Tokenを設ける整理もできますが、本例では設定しません。

themeは、同じ役割に割り当てる値のまとまりを変える文脈です。
stateは、通常・hover・focus・disabledなど、部品の状態を表します。
Carbonは状態の名前を含む色Tokenも説明していますが、命名や実装方式をすべてのシステムへ強制するものではありません。
themeとstateは別の軸であり、ライトテーマの通常状態で確かめた色対から、他の組み合わせまで評価できません。

Mimicの[色提示方針](https://github.com/9uiLe/mimic/blob/main/guideline/README.md#uiの色を具体的に示すとき)に従い、役割Token、値または参照先、背景、状態、テーマ、透明度を結び付けます。
名前だけを示しても、その場で描画される前景と背景の組み合わせは分かりません。

## 条件と参照関係

用途は本文、テーマはlight、状態はnormalです。
前景と背景はすべてsRGBの不透明な単色で、alpha・要素のopacityともに1を前提とします。

| 役割Token | paletteへの参照 | 参照先の値 | 組み合わせと用途 |
| --- | --- | --- | --- |
| `color.surface.canvas` | `palette.neutral.0` | `#FFFFFF`（sRGB） | 本文が載る背景 |
| `color.text.primary` | `palette.neutral.900` | `#1A1A1A`（sRGB） | canvas上の主要本文 |
| `color.text.secondary` | `palette.neutral.600` | `#595959`（sRGB） | canvas上の補助文 |

`color.text.primary → palette.neutral.900 → #1A1A1A`の順に役割から値をたどります。
primaryとsecondaryは用途の名前で、業務上の優先度や読みやすさの測定結果を表しません。
paletteの段階番号は、知覚明度・相対輝度・コントラスト比の等間隔を意味しません。

## 色対の数値確認

[相対輝度のsRGB式](../../lightness-and-luminance/KNOWLEDGE.md)と[コントラスト比の式](../../color-contrast/KNOWLEDGE.md)で計算しました。

| 前景 / 背景 | 表示用の比 | 丸め前の計算結果 |
| --- | --- | --- |
| `color.text.primary` / `color.surface.canvas` | 約17.40:1 | 17.404327532742:1 |
| `color.text.secondary` / `color.surface.canvas` | 約7.00:1 | 7.004729208036:1 |

両色対とも、丸め前の値で通常文字の4.5:1以上という数値条件を満たします。
これはこの条件の色対に限った確認です。画面全体やWCAG全体の適合評価ではありません。

## 条件を変えるとき

ダークテーマへ変える場合も、主要本文という役割は保ちながら別の値を割り当てられます。
値を変えた色対は改めて確認します。本例にはdarkの具体値を設定していません。
hover・focus・disabledの状態や、透過・画像背景を持つ場合も、本例の計算結果をそのまま使いません。
補助文を別の背景に置くときも、`color.text.secondary`という名前だけから同じ比とは判断しません。

## 未評価と原典との対応

文字サイズ・太さ、実画面の読みやすさ、各操作状態、dark、透過や画像背景、色覚差・表示環境は未評価です。
色だけに頼らない情報伝達についても、この色表だけでは評価できません。
式と数値判定の扱いは[W3Cの公式参考解説](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html#key-terms)に基づきます。
役割とthemeの考え方は[Carbonの説明](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview)を参照しています。
この作例の具体的な値・名前・三つの役割を、原典の推奨配色として扱いません。
