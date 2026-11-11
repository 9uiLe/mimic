# 原典と説明の範囲

UMLの定義・意味と、描画ツールの構文を区別して参照します。
用途を開発資料の問いに対応させた表と、日本語の架空注文例はMimicによる説明です。

| 出典 | 確認箇所 | 本文との対応・注意 |
| --- | --- | --- |
| OMG, [What is UML?](https://www.omg.org/uml/what-is-uml.htm) | Raising the Level of Abstraction、Models vs. Methodologies、What can you Model with UML? | UMLの目的、方法論からの独立、構造・振る舞い・相互作用の区別。UML 2.0当時の導入文なので、図種の件数を現行仕様へ転用しない |
| OMG, [UML 2.5.1仕様の入口](https://www.omg.org/spec/UML/2.5.1/About-UML)・[仕様PDF](https://www.omg.org/spec/UML/2.5.1/PDF) | 11.6 Components、14.2.3.4 States、14.2.4.8 Transition、15.2 Activities、17.1.3 Partial ordering、18.1 Use Cases、19.1 Deployments | 部品・状態・遷移・活動・相互作用・要求・配置の意味。特に、図の縦の距離を実時間としないこと、トリガー・ガード・効果の区別。作例のMermaid構文そのものを定義する資料ではない |
| PlantUML, [Class diagram](https://plantuml.com/class-diagram) | Relations between classes、Label on relations、Adding methods | クラスの属性・操作・関連の表現。ツールの短い説明を、集約等の完全なUML意味論には置き換えない |
| PlantUML, [Component diagram](https://plantuml.com/component-diagram)・[Deployment diagram](https://plantuml.com/deployment-diagram) | 冒頭の定義、Interfaces、Declaring element、Link or arrow | 部品・インターフェースと実行場所を描き分けるための構文例 |
| PlantUML, [Use case diagram](https://plantuml.com/use-case-diagram) | 冒頭の定義、Usecases、Actors | アクターと対象の機能を表す入口。詳細なシナリオの完全性を図だけで保証しない |
| PlantUML, [Activity diagram](https://plantuml.com/activity-diagram-beta) | Conditional、Repeat loop、Parallel processing、Swimlanes | 分岐・反復・並行処理・担当を表す構文。一般のフローチャートとUMLの意味の区別に注意する |
| Mermaid, [Sequence diagrams](https://mermaid.js.org/syntax/sequenceDiagram.html) | Participants、Messages、Notes、Alt | 作例の参加者・メッセージ・注記・分岐の書き方 |
| Mermaid, [State diagrams](https://mermaid.js.org/syntax/stateDiagram.html) | States、Transitions、Start and End | 作例の状態名・遷移・初期点の書き方。ガード等のラベルは説明文として示し、実行可能な条件式とは扱わない |

作例は公式サンプルの複製ではありません。決済結果の照会、再試行、取消、返金などの実装方針を決めるものではありません。
