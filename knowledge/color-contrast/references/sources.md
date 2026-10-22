# 出典と説明の範囲

本概念の版は[本文](../KNOWLEDGE.md)で確認します。2026年10月22日に以下の箇所を確認しました。

| 出典・箇所 | 本文で支える説明 | 範囲・注意 |
| --- | --- | --- |
| [WCAG 2.2 §1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG22/#contrast-minimum) | 通常文字4.5:1、大きな文字3:1と例外 | レベルAA。補助文という理由だけで除外しない |
| [同 §1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast) | 識別に必要なUI・状態、理解に必要な図と隣接色の3:1 | 全境界を対象とする規則ではない。各例外も本文で説明 |
| [同 §1.4.1 Use of Color](https://www.w3.org/TR/WCAG22/#use-of-color) | 色を唯一の視覚的な伝達手段にしない | レベルA。コントラスト比とは別の要求 |
| [Understanding Contrast Minimum — Intent](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html#intent) | 対象となる知覚上の困難、丸め前での判定 | WCAGの公式参考解説であり、達成基準本体と区別する |
| [同 — Key Terms](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html#key-terms) | contrast ratioとlarge scaleの定義 | 18pt・14pt太字、CJK同等サイズを含む。役割名では決まらない |

WCAG 2.2はW3C Recommendationです。本記事は一部の達成基準の説明であり、適合評価の完全な手順ではありません。
「情報を受け取る条件も扱う」という見出し上の整理と入力エラーの例はMimicの説明です。
具体的な色対と計算値は[共通の作例](../../design-tokens/examples/color-presentation.md)に集約しています。
