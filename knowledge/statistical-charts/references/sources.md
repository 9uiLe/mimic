# 統計グラフの出典と説明の範囲

確認日は2026年11月11日です。下記の公式資料の本文を確認しました。
図種別の説明は日本語による要約であり、開発資料への用途例と章立てはMimicの編集上の整理です。

| 資料 | 確認箇所 | 本文との対応・範囲 |
| --- | --- | --- |
| [ONS: Line chart](https://service-manual.ons.gov.uk/data-visualisation/chart-types/line-chart) | Irregular and missing data、Provide context、Alternatives | 時間推移、不規則な観測時刻、欠測の空白、注記、小分割、積上げ面の用途 |
| [ONS: Bar chart](https://service-manual.ons.gov.uk/data-visualisation/chart-types/bar-charts) | When to use a bar chart、Axis、Category order | 分類間比較、ゼロ基準、意味のある並び順。ONSの制作指針として参照 |
| [ONS: Stacked bar charts](https://service-manual.ons.gov.uk/data-visualisation/chart-types/stacked-bar-charts) | When to use、Types of stacked bar charts | 全体と内訳、通常と100%積上げの違い、中間区分には共通基準線がないこと |
| [NIST/SEMATECH: Histogram](https://www.itl.nist.gov/div898/handbook/eda/section3/histogra.htm) | Purpose、Definition | 一変数の分布、区間ごとの件数、相対度数、区間幅を使った密度の定義 |
| [NIST/SEMATECH: Box Plot](https://www.itl.nist.gov/div898/handbook/eda/section3/boxplot.htm) | Definition、Box plots with fences | 中央値・四分位数・箱、ひげの方式が一つではないこと。図だけを統計的有意差の検定にはしない |
| [NIST/SEMATECH: Scatter Plot](https://www.itl.nist.gov/div898/handbook/eda/section3/scatterp.htm) | Definition、Questions、Causality Is Not Proved By Association | 対応する二変数の観測、線形以外の関係、関連が因果を証明しないこと |
| [Matplotlib: Annotated heatmap](https://matplotlib.org/stable/gallery/images_contours_and_fields/image_annotated_heatmap.html) | A simple categorical heatmap | 行・列カテゴリと二次元の値を対応させ、セルに値を注記する表現。実装例は転載しない |
| [Grafana: Heatmap](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/heatmap/) | 冒頭、Heatmap options、Colors options | 時間ごとの分布、時間・値の区間、セル値と色の対応、色尺度の最小・最大設定 |
| [Prometheus: Histograms and summaries](https://prometheus.io/docs/practices/histograms/) | Overview、Count and sum of observations、Quantiles、Errors of quantile estimation | 合計と件数による平均、事前計算した分位数の集約制約、ヒストグラム集約と分位数推定誤差 |

ONSは統計の伝達、NISTは探索的データ解析、GrafanaとPrometheusはそれぞれの製品の表現・計測機能を説明しています。
これらの資料を一つの標準規格や、開発プロセス全体の必須手順としてまとめてはいません。
製品の機能対応や画面の項目は版に依存します。本稿では全環境への対応を保証せず、図や計測値を解釈する際の相違を扱います。

測定点、対象期間、成功・失敗の範囲、比較条件を添える説明は、出典の定義を開発計測へ当てはめた編集上の補足です。
注文APIの数値、CSV、PythonコードはMimicが作成した説明例であり、上記の資料の実験結果や推奨値ではありません。
[HEART本文](../../heart-framework/KNOWLEDGE.md)との接続は、目標に対応する指標の選択と、その値の表現の役割を区別した編集上の説明です。

[本文に戻る](../KNOWLEDGE.md)
