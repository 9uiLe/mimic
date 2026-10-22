# 日本語と英数字が混じる申請画面の説明例

Webの横組、表示幅375 CSS px、ブラウザーの標準文字サイズとroot要素の文字サイズを16 CSS pxと仮定した架空の申請画面です。見出し「申請内容」、短い表示「申請番号 AB-120」、説明文「AB-120 の内容を確認し、必要なら担当者に連絡してください。」を置きます。日本語と英数字には日本語対応書体を優先し、利用できないときはブラウザーのsans-serifへfallbackする条件です。実際の字形や行の折返しは、端末と書体の有無によって変わります。

## 役割Tokenと基礎値

次のDTCG Format 2025.10形式のJSONはMimicの作例です。`type.body`と`type.heading`はそれぞれ五つの設定を組にした役割Tokenです。グループの`type`や`base`は説明用の名前で、実在する製品の正式なToken体系ではありません。

```json
{
  "base": {
    "family": {
      "ui": { "$type": "fontFamily", "$value": ["Noto Sans JP", "sans-serif"] }
    },
    "size": {
      "body": { "$type": "dimension", "$value": { "value": 1, "unit": "rem" } },
      "heading": { "$type": "dimension", "$value": { "value": 1.25, "unit": "rem" } }
    },
    "weight": {
      "regular": { "$type": "fontWeight", "$value": 400 },
      "semibold": { "$type": "fontWeight", "$value": 600 }
    },
    "tracking": {
      "default": { "$type": "dimension", "$value": { "value": 0, "unit": "px" } }
    }
  },
  "type": {
    "body": {
      "$type": "typography",
      "$value": {
        "fontFamily": "{base.family.ui}",
        "fontSize": "{base.size.body}",
        "fontWeight": "{base.weight.regular}",
        "letterSpacing": "{base.tracking.default}",
        "lineHeight": 1.5
      }
    },
    "heading": {
      "$type": "typography",
      "$value": {
        "fontFamily": "{base.family.ui}",
        "fontSize": "{base.size.heading}",
        "fontWeight": "{base.weight.semibold}",
        "letterSpacing": "{base.tracking.default}",
        "lineHeight": 1.4
      }
    }
  }
}
```

ここでは`type.body → base.size.body → 1rem`のように役割から基礎値へたどれます。`lineHeight`の`1.5`と`1.4`は単位なしの倍率で、行高のCSS px値をTokenへ直接書いたものではありません。上の標準文字サイズの仮定でWeb向けに変換すれば、本文は文字サイズ約16 CSS px・行高約24 CSS px、見出しは約20 CSS px・約28 CSS pxに相当します。CSSでは`rem`がroot要素の文字サイズを基準にするため、その設定が違えば表示寸法も変わります。JSONの`$type`・aliasを解釈してCSSなどへ変換する工程が必要です。

## 表示条件を変えるとき

この組は、和欧混植の字形、約物の間、長い英数字列の折返しを自動で保証しません。日本語と英数字で異なる書体を選ぶ場合、fallbackが使われる場合、表示幅が狭い場合には、実際の文字列で改行位置と切り詰めを確かめます。文字の拡大や字間・行間の変更時には、固定の高さによる欠落、重なり、配置の崩れを確認します。AppleのDynamic Typeを使う環境なら、そのtext styleと拡大への対応を別途設計します。この固定の数値をそのまま適用してDynamic Typeを妨げる意図はありません。

行高と字間は文字の組み方、コンポーネントやグループを離す間隔は[レイアウトの余白](../../layout-spacing/KNOWLEDGE.md)です。両者が結果に関わっても、行高Tokenをレイアウトのgapとして流用する判断はこの例に含めません。文字の大きさだけで意味上の見出しが成立するわけではない点は、[視覚的な優先順位](../../visual-hierarchy/KNOWLEDGE.md)で説明します。

文章、書体、幅、数値、Token名はMimicが作成した説明用の仮定です。製品への推奨値や普遍的な最適値、表示結果の実測、読みやすさの効果実験、原典の作例ではありません。

[Typographyの本文に戻る](../KNOWLEDGE.md)
