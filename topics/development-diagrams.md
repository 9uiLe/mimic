# 開発資料の図とグラフを選ぶ

アーキテクチャ説明、設計レビュー、データ設計、性能評価で、何を伝えたいかから図とグラフを選ぶための案内です。
関係や振る舞いを表す図と、観測した数量を表すグラフを読み分けます。
以下の分類はMimicによる読書案内であり、一つの規格が定める図の体系ではありません。
定義・対象範囲・出典はリンク先の本文で、版は各本文の先頭で確認します。

## 画像で見比べる

この案内で扱う図種と、DFD・ERの主要な粒度の違いを31枚の作例として示します。
この枚数は掲載例の範囲であり、UMLや統計図の全分類を意味しません。各図は架空の注文システム・データによる説明例です。

| 画像一覧 | 含むパターン |
| --- | --- |
| [C4の6図](../knowledge/c4-model/examples/visual-guide.md) | Context、Container、Component、Code、Deployment、Dynamic |
| [UMLの7図](../knowledge/uml/examples/visual-guide.md) | ユースケース、クラス、コンポーネント、配置、シーケンス、アクティビティ、状態 |
| [DFDの4図](../knowledge/data-flow-diagrams/examples/visual-guide.md) | コンテキスト、論理、物理、信頼境界 |
| [ERの3図](../knowledge/entity-relationship-diagrams/examples/visual-guide.md) | 概念、論理、物理 |
| [統計グラフの8図](../knowledge/statistical-charts/examples/visual-guide.md) | 折れ線、棒、ヒストグラム、箱ひげ、散布、ヒートマップ、積上げ棒、積上げ面 |
| [手順・画面・計画の3図](../knowledge/uml/examples/development-flows.md) | フローチャート、画面遷移、ガント |

画像は拡大できるSVGです。各画像の下に、用途、読むポイント、前提・省略範囲を添えています。

## 問いから選ぶ

| 資料で答えたい問い | 図・グラフと読む本文 | 作るときに決めること |
| --- | --- | --- |
| 誰が使い、外部の何と連携するか | [C4のSystem Context図](../knowledge/c4-model/KNOWLEDGE.md) | 対象システムの境界、利用者、外部システム、関係の目的 |
| アプリやデータストアの責務をどう分けるか | [C4のContainer・Component図](../knowledge/c4-model/KNOWLEDGE.md) | 一枚の抽象度、責務、技術、関係の向き。ContainerをDockerだけの意味にしない |
| 何をどの実行環境へ配置するか | [UML配置図](../knowledge/uml/KNOWLEDGE.md)、[C4配置図](../knowledge/c4-model/KNOWLEDGE.md) | 環境、ノードと配置物、通信経路。論理的な責務と物理配置を分ける |
| 誰が何を達成するか | [UMLユースケース図](../knowledge/uml/KNOWLEDGE.md) | アクター、対象の境界、目的。手順や例外条件は文章で補う |
| 参加者がどの順でやり取りするか | [UMLシーケンス図](../knowledge/uml/KNOWLEDGE.md) | 対象シナリオ、要求と応答、分岐・失敗・タイムアウト |
| 分岐や並行処理を含む手順は何か | [UMLアクティビティ図](../knowledge/uml/KNOWLEDGE.md) | 条件、責任範囲、開始・終了、合流と同期の違い |
| どのイベントで状態が変わるか | [UML状態機械図](../knowledge/uml/KNOWLEDGE.md) | 状態、イベント、ガード条件、遷移時の処理 |
| 型の責務や依存関係は何か | [UMLクラス図・コンポーネント図](../knowledge/uml/KNOWLEDGE.md) | 必要な型・部品・関連と多重度。実装の全項目を転記しない |
| データがどこを通り、どこへ保存されるか | [データフロー図（DFD）](../knowledge/data-flow-diagrams/KNOWLEDGE.md) | 外部実体、処理、データストア、流れるデータ。脅威分析では信頼境界も確認 |
| 何を保持し、何件と関連できるか | [ER図](../knowledge/entity-relationship-diagrams/KNOWLEDGE.md) | 概念・論理・物理の粒度、キー、多重度、ゼロ件を許すか |
| 画面間の移動と画面内の状態はどう違うか | [インタラクションデザイン](../knowledge/interaction-design/KNOWLEDGE.md) | 操作、応答、戻り先、入力の保持。画面遷移と業務状態を同一視しない |
| 時間に伴って値がどう変わるか | [統計グラフ：折れ線](../knowledge/statistical-charts/KNOWLEDGE.md) | 時刻・単位・集計幅・欠測、変更やリリースの時点 |
| カテゴリ間の大小や内訳は何か | [統計グラフ：棒・積み上げ](../knowledge/statistical-charts/KNOWLEDGE.md) | 共通尺度、並び順、全体の定義。件数と構成比を分ける |
| 値の分布やばらつきはどうか | [統計グラフ：ヒストグラム・箱ひげ](../knowledge/statistical-charts/KNOWLEDGE.md) | 標本数、期間、ビン幅、四分位数・ひげの定義 |
| 二つの量に関係があるか | [統計グラフ：散布図](../knowledge/statistical-charts/KNOWLEDGE.md) | 一点の観測単位、両軸の単位。相関だけで因果を結論しない |
| 時間帯や分類のどこに値が集中するか | [統計グラフ：ヒートマップ](../knowledge/statistical-charts/KNOWLEDGE.md) | 行・列、色尺度、件数か率か、欠測の表示 |

たとえば「注文が遅い」という問いでも、依存先を知るには構成図、呼出し順序にはシーケンス図、遅い要求の分布にはヒストグラムを使います。
構成図の矢印だけから実行順序や処理時間を読み取らず、必要な観点を別の図で補います。

## 説明例から作り方を読む

各例はMimicが作成した架空の注文システムの説明で、実在サービスの設計や性能測定ではありません。
個別例の前提・省略範囲を確認して読みます。全例をそのまま組み合わせた完成仕様ではありません。

| 例 | 確認するポイント |
| --- | --- |
| [注文システムの構成](../knowledge/c4-model/examples/order-system.md) | 境界と抽象度をそろえ、責務と通信を説明する |
| [注文のやり取りと状態](../knowledge/uml/examples/order-lifecycle.md) | 一つのシナリオの順序と、対象が取り得る状態を描き分ける |
| [注文データの流れ](../knowledge/data-flow-diagrams/examples/order-data.md) | 処理と保存先を結び、データの名前を矢印へ書く |
| [注文と明細のデータ関係](../knowledge/entity-relationship-diagrams/examples/orders.md) | 両端の多重度と任意性を読み、テーブル制約との対応を考える |
| [注文APIの計測値](../knowledge/statistical-charts/examples/performance.md) | 生データ、集計条件、図の読み取りを対応させる |

図のタイトルには対象と観点を示し、現状・提案・説明例を区別します。
要素の名称、矢印の意味、凡例、対象範囲を本文と合わせ、数値グラフには単位・期間・データの出所を添えます。
これらは各本文の注意点を資料編集へまとめたもので、図を描くだけで設計の正しさを保証するチェックリストではありません。

## 作図手段を選ぶ

| 手段 | 使い所と作成の入口 |
| --- | --- |
| [Mermaid](https://mermaid.js.org/intro/) | Markdownとともに小さな図のソースを管理する。図種を宣言し、要素と関係を記述する。例のソースから名称・条件を変更できる |
| [PlantUML](https://plantuml.com/) | シーケンス・クラス・状態・配置などのUML図をテキストから作る。目的の図種の公式記法を選ぶ |
| [Structurizr](https://structurizr.com/) | 共通のC4モデルから複数のビューを作る。要素と関係をモデルに定義してから、図に含める対象を選ぶ |
| [Matplotlib](https://matplotlib.org/stable/plot_types/index.html) | 計測データからグラフを再生成する。列・単位・集計条件を決め、図種に応じた描画関数へ渡す |

ツールの対応図種と、記法が表す意味は別に確認します。Mermaidの`flowchart`で箱と矢印が描けても、それだけでUMLやDFDの正式記法に準拠するとは限りません。
[GitHubの図の作成ガイド](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)は、`mermaid`コードブロックでの描画と、利用中の版の確認方法を示しています。
MimicのPagesでは作図用コードをコードとして保持し、上の画像一覧では自己完結のSVGを表示します。GitHubや別の描画環境では対応版を確認し、文字の重なりや矢印の接続先も確かめます。
画像だけでなく編集元を残し、図の内容を説明する文章を添えると、変更時の確認と図を直接読めない場合の参照に使えます。

## 手順や日程を補う場合

単純な条件分岐の説明には、[Mermaidのフローチャート](https://mermaid.js.org/syntax/flowchart.html)も使えます。
処理を箱、判断を分岐として置き、分岐の条件と行き先を記します。並行処理の同期など厳密な意味を扱う場合は、UMLの本文で記法を確認します。

開発計画の期間と依存関係には、[Mermaidのガントチャート](https://mermaid.js.org/syntax/gantt.html)の説明を参照できます。
タスクID、開始日または先行タスク、期間、マイルストーンを記述します。予定と実績、休日を含むかを資料上で区別します。
ガントチャートの日付は計画の表現であり、設計の妥当性や納期の確実さを示すものではありません。

## 関連する知識へ

図を読む人が何を理解する必要があるかは、[概念モデル](../knowledge/conceptual-models/KNOWLEDGE.md)や[外的表象](../knowledge/external-representations/KNOWLEDGE.md)の説明とも関わります。
画面を設計する資料は[プロダクト全体のUI設計](product-ui-design.md)、指標を選ぶ目的は[HEARTと目標・シグナル・指標](../knowledge/heart-framework/KNOWLEDGE.md)から確認できます。
図の見栄え、モデルが表す意味、測定値から言えることを、それぞれの本文で区別して読みます。
