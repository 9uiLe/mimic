---
id: color
title: 色の知識
status: proposed
version: "0.1.0"
scope: general-digital-ui
related:
  - lightness-and-luminance
  - color-contrast
  - visual-hierarchy
  - design-tokens
---

# 色の知識

## この案内について

UIの色について、明るさ、前景と背景の関係、視覚的な強調を学ぶための案内です。関心のある問いから、必要な本文へ進めます。章立てはMimicの編集上の整理であり、一つの確立した色彩理論の分類ではありません。

この案内は採用前（`proposed`）です。各概念の定義・背景・対象範囲は、リンク先の `KNOWLEDGE.md` と、そこから参照する出典や説明例を読みます。版と採用状態も各本文で確認します。

## 「明るい」が何を表すかを確かめる

[明度と相対輝度](../knowledge/lightness-and-luminance/KNOWLEDGE.md)では、色の明るさに関する表現と、コントラスト計算に用いる量の違いを読みます。「明るくする」という説明で何を変えるかを明確にし、異なる色表現の数値を同じ意味で扱わないための入口です。この本文は採用前（`proposed`）です。

## 前景と背景を組み合わせて読む

[色コントラスト](../knowledge/color-contrast/KNOWLEDGE.md)では、前景と背景の組み合わせや、文字・UIを識別する条件を読みます。数値の対象と適用範囲を確かめ、色の差を計算したことと、実画面の読みやすさやアクセシビリティの確認を区別するために参照します。この本文は採用前（`proposed`）です。

## 強調と情報の重要度を区別する

[視覚的な優先順位](../knowledge/visual-hierarchy/KNOWLEDGE.md)は、色を含む相対的な強調と、情報の階層や業務上の優先度を区別するために読みます。明るさやコントラストの数値だけで、何を目立たせるべきかが決まるわけではありません。この本文は正式採用済み（`accepted`）です。

## 具体的なUIへ適用・共有するとき

[Design Token](../knowledge/design-tokens/KNOWLEDGE.md)は、色に限らず設計上の値を名前や参照で共有する独立した概念です。色の基礎を学ぶための必須の前提ではなく、具体的なUIの値や役割を共有するときの関連知識として参照します。この本文は採用前（`proposed`）です。

Mimicで具体的なUI色を提案・提示するときは、[利用ガイドの色の提示方針](../guideline/README.md#uiの色を具体的に示すとき)に従います。[Design Tokenの色への適用例](../knowledge/design-tokens/examples/color-presentation.md)から、条件を伴う提示の例を読めます。作例を、そのまま製品の正式なToken体系や普遍的な推奨配色として扱いません。

## この案内の範囲

色の対比と文脈、色による意味、色空間と色域、歴史上の思想や色彩教育の体系は、今後の候補です。現在の本文が、それらすべてを説明するとは扱いません。各概念の出典と確認箇所は、本文から参照する `references/sources.md` で確認します。
