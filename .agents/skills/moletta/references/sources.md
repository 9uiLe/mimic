# 設計の出典と適用限界

確認日: 2026-10-17。以下は設計判断の参考資料であり、この package が NASA / SEI の正式な工程、評価、認証に準拠するという主張ではない。各資料の考え方を、この実装向けに独自の短い手順へ構成した。

| 一次資料 | 取り入れた考え方 | この package での限界 |
| --- | --- | --- |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) / [figure-it-out](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md) | 入口から必要な技能を選び、実物を確かめ、判断の経緯を残す | 設計の着想として参照。本文・工程表は転記せず独自に作成し、製品固有の操作・モデル指定・一律の試作数を引き継がない |
| [NASA SWE-052: Bidirectional Traceability](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695427/SWE-052%2B-%2BBidirectional%2BTraceability) | 上位要求、設計、検証の関係をたどり、変更影響を確認する | 成果・制約・要求・案・実験・証拠の ID 関係を扱う。引用やリンクが正しくても意味上の完全性は証明しない |
| [NASA SEH 2.0: Fundamentals of Systems Engineering](https://www.nasa.gov/reference/2-0-fundamentals-of-systems-engineering/) | 各専門領域の部分最適に偏らず、運用目標に届く全体を考える | 全体構成と端から端までの成果確認に使う。NASA の組織・工程を再現しない |
| [NASA SEH 4.0: System Design Processes](https://www.nasa.gov/reference/4-0-system-design-processes/) | 期待、運用概念、導出要求、構成を反復して整合させる | 人の意図を保持し、こちらの分解や方式を再検討する。意図の変更は人の判断に戻す |
| [NASA ESTO: Technology Readiness Levels](https://esto.nasa.gov/trl/) | 部品・統合システムと、実験室・関連環境・運用環境の証拠を区別する | 実験の範囲・環境・省略条件を明示するための着想。独自の NASA 成熟度や TRL 点数を付けない |
| [SEI: Quality Attribute Workshop Collection](https://www.sei.cmu.edu/library/quality-attribute-workshop-collection/) | 構成が決まる前に、事業目標から重要な品質要求を具体化する | 必要な条件だけを成果・受入条件・シナリオへ表す。正式な QAW の実施とは呼ばない |
| [SEI: Architecture Tradeoff Analysis Method Collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/) | 構成の品質目標に対するリスクと相互作用・トレードオフを調べる | 実現方式全体を比較し、未知と再考条件を残す。正式な ATAM 評価や訓練済み評価チームを代替しない |

調査では、この背景資料だけで個別技術の結論を出さない。対象の公式仕様・論文・実物へ当たり、`notes` に読んだ出典と事実を、`research` に出典 ID、結論、その課題への適用条件を残す。実装の構造検査と、エージェントが原文の意味を理解して行動できるかの評価は別に行う。
