---
id: ecological-interface-design
title: Ecological Interface Design
status: accepted
version: "1.0.0"
scope: complex-human-machine-systems
related:
  - external-representations
---

# Ecological Interface Design

## 概念

VicenteとRasmussenのEcological Interface Design（EID）は、複雑な人間機械システムのための設計枠組みです。原典は、インターフェースに含める情報の内容・構造と、その情報を人へ伝える表現の問題を区別します。

EIDで用いる抽象化階層は、同じ作業領域を異なる抽象度で記述し、各層を目的と手段の関係で結びます。上位ではシステムの目的に関わる関係を、下位では物理的な実装に関わる要素を表します。

表現を考える際には、習熟した動作、手掛かりから既知の規則を選ぶ行動、知識を用いた問題解決を区別するSRK（技能・規則・知識）の枠組みを用います。課題が必要とする以上に高い水準の処理を強いず、三つの水準すべてを支えることを目指します。

## 背景と対象範囲

背景には、運転者が想定外の異常にも対処できるよう、作業領域の制約を表現するという課題があります。一般のUIで表示項目を減らす手順や、適切な項目数を定めた理論として扱いません。

## 関連する概念

[外的表象](../external-representations/KNOWLEDGE.md)も情報の表し方に関わりますが、そちらは内部と外部に情報が分散する認知課題における、両者の相互作用を扱います。EIDと同一の枠組みではありません。この関連づけは本書の説明上の整理です。

複数の概念から情報の内容と提示の仕方を読む入口として、[判断材料の選定](../../topics/decision-material-selection.md)があります。

## 出典

[原典と説明の範囲](references/sources.md)に、参照した論文と対応箇所を記載します。
