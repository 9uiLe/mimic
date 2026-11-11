# 出典と説明の範囲

[C4モデルの本文](../KNOWLEDGE.md)は、提唱者Simon Brownによる公式サイトを基にした日本語の説明です。
本文の資料用途の例と、注文システムの作例はMimicによる整理です。公式図の複製ではありません。

| 出典 | 確認箇所 | 支える説明・注意 |
| --- | --- | --- |
| [C4 model](https://c4model.com/) | About this website、冒頭の概要 | Simon Brownによるモデルであること、抽象度・図・記法・ツールの関係 |
| [Introduction](https://c4model.com/introduction) | Common diagramming problems、Maps of your code | 抽象度や名前の不統一という問題、構造を異なる詳細度で共有する目的 |
| [Diagrams](https://c4model.com/diagrams) | Static structure diagrams、Supporting diagrams | 四段階と補助図の区別、全段階を必須としない立場 |
| [System context diagram](https://c4model.com/diagrams/system-context) | 冒頭、Scope、Primary / Supporting elements | 対象システム、利用者、外部システムの範囲。技術の細部を中心にしないこと |
| [Container diagram](https://c4model.com/diagrams/container) | 冒頭、Notes | 責務、技術、通信の説明と、環境別配置との区別 |
| [Container](https://c4model.com/abstractions/container) | 冒頭、Why “container”? | アプリケーション／データストアを指す抽象であり、Dockerとの同一視を避けること |
| [Component diagram](https://c4model.com/diagrams/component) | Scope、Primary / Supporting elements、Recommended? | 一つのContainer内部を扱うことと、必要に応じて作る立場 |
| [Code diagram](https://c4model.com/diagrams/code) | 冒頭、Scope | 実装要素を扱うこと、UMLなどの使用、論点に必要な情報と生成の検討 |
| [Deployment diagram](https://c4model.com/diagrams/deployment) | 冒頭、Scope、Primary and supporting elements | 環境ごとの配置ノード・インスタンス・インフラ要素 |
| [Dynamic diagram](https://c4model.com/diagrams/dynamic) | 冒頭、Scope、Notes | 一つの機能の相互作用と順序。静的構造とは異なる観点 |
| [Notation](https://c4model.com/diagrams/notation) | Diagrams、Elements、Relationships | タイトル、凡例、種類、責務、技術、方向付きラベル |
| [Tooling](https://c4model.com/tooling) | 冒頭の選択観点、Diagramming、Modelling | 個別の図を描くことと、共通モデルからビューを作ることの違い |
| [Mermaid: Flowcharts](https://mermaid.js.org/syntax/flowchart.html) | A node with text、Unicode text、Links between nodes、Subgraphs | 作例のノード・矢印ラベル・囲みの構文。C4の意味や設計品質の根拠ではない |

公式資料が推奨する図の使い方と、個別システムが満たすべき要求は別です。
本書は認証方式、冗長化構成、性能目標の標準をC4から導いていません。
