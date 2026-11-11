# 出典と説明の範囲

| 出典 | 確認した箇所 | 本文との対応・対象範囲 |
| --- | --- | --- |
| [IBM: What is a data flow diagram?](https://www.ibm.com/think/topics/data-flow-diagram) | Components、Types、Levels、Rules | 四要素、論理・物理の違い、段階的な詳細化、フロー・処理の命名。一般的な解説であり、全記法の規範ではない |
| [OWASP: Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html#system-modeling) | System Modeling | システムの把握にDFDを使い、信頼境界・データフロー・ストア・処理・外部実体を確認すること |
| [OWASP: Threat Modeling Process (Historical)](https://owasp.org/www-community/Threat_Modeling_Process#data-flow-diagrams) | Data Flow Diagrams、Privilege Boundary | 矢印はデータの移動方向、信頼境界は信頼レベルの変化を示すという記号の説明。歴史的な文書として参照し、現行の唯一の手順とはしない |
| [Mermaid: Flowcharts](https://mermaid.js.org/syntax/flowchart.html) | Node、Direction、Links、Subgraphs | 作例のノード・矢印・囲みの構文。DFDの意味や安全性を定める仕様ではない |

本文の図の選び方、注文を題材にした名称、上位図との対応を追う説明は、上記の定義に基づくMimicの説明上の整理です。
注文システムの作例は本書が作成したもので、出典の図の転載、実システムの構成、安全性の検証結果ではありません。
