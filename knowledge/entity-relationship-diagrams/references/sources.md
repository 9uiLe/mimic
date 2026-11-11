# 出典と説明の範囲

| 出典 | 確認した箇所 | 本文との対応・対象範囲 |
| --- | --- | --- |
| [Chen (1976): The Entity-Relationship Model—Toward a Unified View of Data](https://csc.lsu.edu/~chen/pdf/erd-5-pages.pdf) | Abstract、1、2.1、2.2 | 実世界の意味を含むモデル、エンティティ・関係・属性の背景。著者が公開する先頭5ページのみを確認。論文全体の確認とはしない |
| [IBM: What is an entity relationship diagram?](https://www.ibm.com/think/topics/entity-relationship-diagram) | Types of ER models | 概念・論理・物理という用途と詳細度の区別。本文の表は説明上の整理であり、全手法共通の厳密な境界ではない |
| [Mermaid: Entity Relationship Diagrams](https://mermaid.js.org/syntax/entityRelationshipDiagram.html) | Entities and Relationships、Relationship Syntax、Attributes、Attribute Keys and Comments | Crow's Footの多重度、識別・非識別の線、属性・PK・FKの構文。ERモデルの原典やDB制約の実装仕様ではない |
| [PostgreSQL 18: Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) | 5.5.2、5.5.3、5.5.4、5.5.5 | NULL禁止・一意・主キー・外部キー、多対多を中間テーブルで表す例。特定DBの制約を説明する根拠であり、他DBでの挙動を一律に保証しない |

論文の書誌は [Chenの論文一覧](https://csc.lsu.edu/~chen/papers.html)でも確認できます。
本文の使い分けと注文システムの例はMimicの説明上の整理です。出典の図を転載せず、業務の仮定を明示して作成しています。
