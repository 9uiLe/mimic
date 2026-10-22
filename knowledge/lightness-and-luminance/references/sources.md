# 出典と説明の範囲

本概念の採用状態・版は[本文](../KNOWLEDGE.md)で確認します。2026年10月22日に以下の箇所を確認しました。

| 出典・箇所 | 本文で支える説明 | 範囲・注意 |
| --- | --- | --- |
| [CSS Color 4 §7 HSL Colors](https://www.w3.org/TR/2026/CRD-css-color-4-20261020/#the-hsl-notation) | HSLのH・S・Lと、RGBを調整する際の背景 | HSLのLを知覚的な均等尺度と解釈しない |
| [同 §9.1 CIE Lab and LCH](https://www.w3.org/TR/2026/CRD-css-color-4-20261020/#cie-lab) | Labの明度と相対輝度の間隔の違い | 当該節は非規範的説明。CIE原典そのものではない |
| [同 §9.4 Oklab and OkLCh](https://www.w3.org/TR/2026/CRD-css-color-4-20261020/#specifying-oklab-oklch) | Oklab・OkLChのL、OkLChのC・H | CSSの表現仕様。HSLのSとCを同じ尺度にしない |
| [Understanding Contrast Minimum — relative luminance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html#dfn-relative-luminance) | 正規化した相対輝度、sRGBの線形化と係数 | WCAG公式参考解説。sRGBの式を他の色空間へ直適用しない |

CSS Color 4はCandidate Recommendation Draft（2026年10月20日版）です。
知覚的な明度・HSLのL・WCAGの相対輝度を並べる構成はMimicの説明上の整理です。
原典から普遍的な色心理や配色規則を導いていません。具体的な名前と配色は[共通の作例](../../design-tokens/examples/color-presentation.md)に集約しています。
