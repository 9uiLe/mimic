---
id: design-tokens
title: Design Token
version: "1.1.0"
scope: general-digital-ui
related:
  - lightness-and-luminance
  - color-contrast
  - typography
---

# Design Token

## 概念

Design Tokenは、デザインに関する情報を人が読める名前に結び付けたものです。
DTCG（Design Tokens Community Group）は、最小限の構成を名前と値の組として説明しています。
値が何を表すかを示す型や、説明なども伴います。
色だけでなく、寸法、文字、影、アニメーションの時間なども対象になります。

Tokenは、画面に何度も現れる数値の一覧を作るだけの仕組みではありません。
値に名前を与え、設計や実装で同じ判断を参照できるようにします。
ただし、どの名前を使い、何を同じ判断として共有するかは、各デザインシステムの設計です。

## 背景：ツール間で設計情報を共有する

DTCG Formatは、異なるツール間でTokenを交換するファイル形式を定めます。
デザインツールの情報を実装向けの形式へ変換する、といった接続を対象にします。
一つの製品の配色や、画面の構成を規定する仕様ではありません。

参照する2025.10版はFinal Community Group Reportです。
W3C Standardではなく、W3C Standards Track上の仕様でもありません。
仕様の公開版と、Mimicにおける本説明文の版も別です。

## 名前・型・値・alias

| 要素 | 意味 | 説明用の読み方 |
| --- | --- | --- |
| 名前 | 人やツールが情報を参照する識別名 | `space.content.gap`という余白の用途を指す |
| 型 | 値の種類 | 余白や文字サイズならdimension型として扱う |
| 値 | そのTokenが表す内容 | 寸法、色値、他のTokenへの参照など |
| alias | 別のTokenの値を参照する関係 | 用途を表すTokenから基礎の寸法を参照する |

aliasは、値の重複を減らすとともに、Token同士の意味の関係を表せます。
参照元と参照先を分けることで、用途を保ちながら割り当てを変更できます。
同じ値を使うことと、同じ用途であることは同義ではありません。
同じ値を持つ別の用途も、将来同時に変える必要があるとは限りません。

## 色以外での説明例

次の名前と値はMimicの説明用の作例です。製品への推奨値ではありません。

| Token | 型 | 値または参照先 | 表している判断 |
| --- | --- | --- | --- |
| `dimension.step.4` | dimension | 16px | 共有する基礎の寸法 |
| `space.content.gap` | dimension | `dimension.step.4`へのalias | 内容の間隔に使う寸法 |
| `font.size.body` | dimension | 16px | 本文の文字サイズ |

`space.content.gap`は基礎の寸法を参照し、`font.size.body`は独立して値を持つ例です。
同じ16pxでも、余白の変更に合わせて本文の文字サイズも変える、という判断は含めていません。
名前は説明用のドット区切りのパス表記であり、DTCG JSONの単一Token名の構文ではありません。
表の16pxも寸法を読むための表記で、交換ファイルの値の構文を示してはいません。

## Typographyへの適用

文字サイズ一つもTokenにできますが、具体的なUIの本文・見出しを共有するには、書体、文字サイズ、太さ、行高、字間を役割ごとの組で扱えます。DTCG Format 2025.10の`typography`複合Tokenでは、この五つのsub-valueがすべて必須です。`fontFamily`は書体名または優先順の配列、`fontSize`と`letterSpacing`は`dimension`、`fontWeight`は`fontWeight`、`lineHeight`は単位なしの`number`で表します。`dimension`の単位は`px`か`rem`です。基礎Tokenの値を各sub-valueからaliasで参照できます。

この形式は交換用JSONの型を定めますが、本文・見出しという役割名、基礎値と役割の分け方、対象言語や表示環境に適した値までは定めません。Mimicで具体的なTypographyを示すときは、役割の組を中心に、既存Tokenと基礎値の参照関係、書体とfallback、言語、幅、文字設定の変更条件を添えます。[Typographyの本文](../typography/KNOWLEDGE.md)と[和欧混植UIの説明例](../typography/examples/mixed-ui-copy.md)に適用範囲を示します。

## 基礎値・用途・部品ごとの割り当て

Tokenは、次の観点で分けて説明できます。
これは説明上の整理であり、DTCGが必須とする三階層ではありません。

- **primitiveまたはreference：** 寸法などの基礎値を名前で参照する観点。色への適用ではpaletteが一例になります。
- **semantic：** 内容の間隔や本文の文字サイズなど、用途や意味を表す観点。基礎値を参照する場合もあります。
- **component：** 個々の部品に特有の割り当てを表す観点。必要な場合に設けます。

何を基礎値として共有し、どの用途や部品を独立させるかは、管理したい設計判断によって異なります。
層の数が多いことを、それだけで設計の良さの証拠にはしません。

## 交換形式と実装出力の違い

DTCGの交換形式はJSONです。CSSカスタムプロパティは、Web向けの実装で使える出力の一つです。
CSS変数を宣言したことだけで、DTCGの交換形式に準拠したとは判断しません。
型やaliasをどう実装へ変換するかは、利用するツールや実装によって異なります。
本文の表は参照関係を読むための説明であり、交換ファイルや変換器の実装例ではありません。

## 対象範囲と色への適用

Token化は、値と設計判断の共有・管理を助けますが、共有する判断自体の適切さを自動では保証しません。
色への適用では、[明度と相対輝度](../lightness-and-luminance/KNOWLEDGE.md)が色の数値が表す量を、
[色コントラスト](../color-contrast/KNOWLEDGE.md)が前景と背景の関係を説明します。
これらは色を判断する知識であり、Tokenの定義とは別に学べます。

[色への適用例](examples/color-presentation.md)に、Carbonの役割・themeの考え方と、Mimicの説明用配色を記載します。
Mimicで具体的なUI色を示すときは、[利用ガイドの色提示方針](https://github.com/9uiLe/mimic/blob/main/guideline/README.md#uiの色を具体的に示すとき)を適用します。
Tokenの一般的な定義が、この色提示の書式をすべての用途へ要求しているわけではありません。
[出典と説明の範囲](references/sources.md)で、DTCGの形式と色への適用例の根拠を区別します。
