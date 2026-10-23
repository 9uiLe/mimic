# UIのレイヤー構造の出典

## 出典と対応する説明

| 本文の主張 | 出典・版・該当箇所 | 対象範囲と注意 |
| --- | --- | --- |
| 重なりの下は利用者から遠く、上は近い側を指す。 | [W3C CSS 2.2 Appendix E](https://www.w3.org/TR/CSS22/zindex.html#painting-order)：E.1 Definitions、E.2 Painting order。 | CSSの描画規則。「上＝手前」の説明に用い、全プラットフォームの実装契約や重要度の定義へ広げない。 |
| 不透明な前景では下地の寄与がなく、半透明なら下地も寄与する。下地は、それ以前の要素を合成した結果である。 | [W3C Compositing and Blending Level 1](https://www.w3.org/TR/2024/CRD-compositing-1-20240321/#simplealphacompositing)：2024年3月21日候補勧告草案。5.1、5.1.1、7 Backdrop calculation、9.1.4 Source Over、10.1.1 normal blend mode。 | 本項の「通常合成」はnormal・source-overを前提とする。別のブレンド方式にも同じ色になるとはしない。 |
| 要素をまとめて合成する場合は、まずまとまりの内容を合成し、その結果を下地へ合成する。 | [同資料の8 Compositing Groups](https://www.w3.org/TR/2024/CRD-compositing-1-20240321/#compositinggroups)：8、8.2、8.3。 | 個々の塗りの透明度と、文字・輪郭を含むまとまりへの透明度を区別する背景。グループの全機能や端末別APIは説明しない。 |
| 影と光で面の間の見かけの距離を表す。同じ影の値でも、下地の色により同じ高さの印象にならない場合がある。 | [Fluent 2 — Elevation](https://fluent2.microsoft.design/elevation)：冒頭、Depth, shadow, and light、Shadow system、Shadows on color surfaces。 | Fluentの設計指針。影の値を普遍的な距離・重要度・効果の保証にしない。 |
| 半透明とぼかしは異なる処理である。 | [W3C Filter Effects Module Level 1](https://www.w3.org/TR/2018/WD-filter-effects-1-20181218/#supported-filter-functions)：2018年12月18日作業草案。5 Graphic filters、6.1のblur()・opacity()。 | blur()はGaussian blur、opacity()は透明度を適用する。端末やブラウザーの対応状況の根拠にはしない。 |
| モーダルの背後は操作対象外で、通常は視覚的にも隠すか暗くする。キーボードのフォーカスもダイアログ内で扱う。 | [W3C WAI APG — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)：About This Pattern、Keyboard Interaction、WAI-ARIA Roles, States, and PropertiesのNote。 | Webの実践指針。暗い幕の静止画だけでモーダル動作を実装したとはいえない。 |

CSSと合成仕様は描画の規則、Fluentは設計指針、APGはアクセシビリティの実践指針です。本項の章立てと日本語の説明はMimicの整理であり、原典共通の正式な分類ではありません。

## 式から導いた説明と作成した例

- 不透明な下地へ不透明度50%の単色を通常合成したときの「半分ずつ」は、5.1の式に前景のアルファ0.5、下地のアルファ1を代入した結果です。知覚される明るさの比ではありません。
- 同じ黒・不透明度50%の幕を、同じ範囲の不透明な下地へ2枚、個別に通常合成すると、元の下地の色の寄与は0.25、黒の寄与は0.75、結果のアルファは1です。画像全体を「不透明度75%」とは呼びません。2枚を不透明に重ねてから、まとまりへ50%を適用する例とも区別します。
- [二つの面の比較](../examples/overlap.md)は、5.1の関係を格子と斜線で示す作図例です。位置を保った順序変更だけでは拡大や影が生じないこと、描かれる範囲が重ならなければ順序の差が現れない場合があることは、通常合成からの説明です。
- [幕とダイアログの比較](../examples/layer-order.md)は、7と9.1.4を適用し、幕を挟む位置で合成の対象が変わることを示す作図例です。
- 半透明の面を通して前後の文字や線が競合し、読み分けにくくなる場合があるという説明は、合成の仕組みと作例からの条件付きの推論です。

図は原典図の転載ではなく、見た目の改善、理解度、読解性能、知覚される高さ、アクセシビリティ適合性を実証しません。各図の設定は説明用で、推奨Token体系や製品の採用値ではありません。

[本文に戻る](../KNOWLEDGE.md)
