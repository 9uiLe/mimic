# 適用契約の入力と期待結果

このディレクトリは、[契約のモデル](../model.md)を読むための架空例です。実案件の評価記録や実験結果ではありません。実案件の記録は `output/contracts/<run-id>/` に置きます。

[fixture.json](fixture.json)に、数値境界と意味判断の入力を置いています。観測値を仮定として与えた場合の期待結果を、[通常文字の評価記録](normal-text.assessment.json)と[見出しの評価記録](group-heading.assessment.json)に示します。`mode: illustration` と証拠の `limitations` は、実測・実審査と区別するために必要です。

[製品の設計判断台帳](product-design.record.json)は、[架空の目的と確認計画](product-design-basis.md)を根拠にしています。製品が担う範囲、結果の意味、操作と伝達、他の接点との受け渡しを登録します。対象の種類や論点は固定分類ではなく、この案件の言葉です。

この台帳にはデザインシステムも形式化済み契約もありません。それでも判断を登録でき、選択済みの案と未検証、未決定、確認方法の未選定を区別します。目的・利用者・範囲は仮定であり、対象範囲のレビューは `pending`、すべての確認の実施記録は空です。スキーマが受け付けても、全UI/UXの検討完了や品質を保証する例ではありません。

## 読み比べる

| 条件 | 適用可能性 | 検査範囲 | 適用記録 | 充足 |
| --- | --- | --- | --- | --- |
| 通常文字の例のまま | `applicable` | `supported` | `not-demonstrated` | `satisfied` |
| 比の区間を `449/100` の一点にする | `applicable` | `supported` | `not-demonstrated` | `violated` |
| 比の区間が閾値をまたぐ | `applicable` | `supported` | `not-demonstrated` | `undetermined` |
| 比の観測がない | `applicable` | `supported` | `not-demonstrated` | `undetermined` |
| 例外の認定が未確認 | `undetermined` | `undetermined` | `undetermined` | `undetermined` |
| 大きな文字へ変える | `applicable` | `unsupported` | `undetermined` | `undetermined` |
| 原典に沿って例外と確定する | `not-applicable` | `undetermined` | `undetermined` | `not-applicable` |
| 見出しの例のまま | `applicable` | `supported` | `not-demonstrated` | `undetermined` |
| 見出しの空文字を観測し、権限ある判断者が主題・目的を説明しないと根拠付きで認定する | `applicable` | `supported` | `not-demonstrated` | `violated` |
| 同じ版と対象について、権限ある判断者が根拠付きでacceptを承認する | `applicable` | `supported` | `not-demonstrated` | `satisfied` |
| 採用前の実案件を `screening` で確認し、対象・検査範囲に合うと確定する | `applicable` | `supported` | `undetermined` | `undetermined` |
| 通常文字の例に、全要件を判断へ使った有効な証拠を追加する | `applicable` | `supported` | `recorded` | `satisfied` |
| 本文や契約の指紋が違う | `undetermined` | `undetermined` | `undetermined` | `undetermined` |

値や証拠ファイルを変更する場合、対応付けと証拠のハッシュも、その変更を認めたうえで更新する必要があります。最後の行では `execution: stale` です。未対応演算や型の不一致は `execution: invalid` であり、通常の要件違反ではありません。

## スキーマを検査する

JSON Schema Draft 2020-12に対応する検査器へ、`schemas/` のスキーマを同じローカルディレクトリから渡します。評価記録と台帳のスキーマは `contract.schema.json` の定義を相対参照します。ネットワークからスキーマやコードを取得する必要はありません。

`definitions/*.json` を契約スキーマへ、`*.assessment.json` を評価記録スキーマへ、`*.record.json` を台帳スキーマへ渡します。`fixture.json` は説明例の入力であり、契約や評価記録ではありません。

構造検査では、未知フィールド、未知演算子、空の要件集合、不正なハッシュ、分母ゼロ、古い実行状態での合格、未採用の実評価などを拒否することを確かめます。検査器が例を受け付けることだけを、式・根拠・判定の正しさの検査にしません。

表の期待結果には、意味検査と判定規則の実装が必要です。現在のJSON例は期待結果を保存したもので、評価器が出力した実行結果ではありません。
