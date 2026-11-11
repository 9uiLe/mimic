# 注文APIの架空計測からグラフを作る

これはグラフの入力と集計を説明するため、Mimicが作成した小さな例です。
注文APIを実行した実測値、性能改善の実証、合格基準ではありません。

## 測定対象を定義する

架空の`POST /orders`について、サーバが応答を完了した要求ごとに処理時間をミリ秒で記録したと仮定します。
対象期間は2026年11月1日09:00:00 UTC以上09:03:00 UTC未満です。
各`minute`は、その分の開始時刻であり、行はその1分区間内に応答が完了した1要求を表します。
成功はHTTP 200、エラーはHTTP 503と定義し、両方を応答時間の集計対象にします。
この例には未完了要求、タイムアウト、クライアント側の通信時間、リトライを含めていません。

区間ごとの件数は5件と少なく、裾の分位数を安定して評価できる測定設計ではありません。
実際の性能報告では環境、負荷の生成方法、ウォームアップ、対象要求の範囲も記録します。

## 標準ライブラリで集計する

Python 3で次のコードを実行します。外部ライブラリ、ファイル入力、ネットワーク接続は不要です。
入力はコード内の架空CSVで、出力は1分ごとの集計と全期間の度数分布です。
例ではp分位数を、昇順に並べたn個の値の`ceil(p × n)`番目と定義します。
補間する計算法やヒストグラムからの推定とは値が異なる場合があります。

```python
import csv
import io
import math
from collections import defaultdict


measurements_csv = """minute,duration_ms,status
09:00,80,200
09:00,90,200
09:00,100,200
09:00,120,200
09:00,700,503
09:01,85,200
09:01,95,200
09:01,110,200
09:01,140,200
09:01,800,503
09:02,82,200
09:02,100,200
09:02,125,200
09:02,180,200
09:02,950,503
"""


def nearest_rank(observations, proportion):
    ordered = sorted(observations)
    if not ordered or not 0 < proportion <= 1:
        raise ValueError("Require observations and 0 < proportion <= 1")
    return ordered[math.ceil(proportion * len(ordered)) - 1]


requests_by_minute = defaultdict(list)
for record in csv.DictReader(io.StringIO(measurements_csv)):
    requests_by_minute[record["minute"]].append(
        (int(record["duration_ms"]), int(record["status"]))
    )

print("minute_UTC,count,errors,error_pct,p50_ms,p95_ms")
all_durations = []
for minute, requests in sorted(requests_by_minute.items()):
    durations = [duration for duration, status in requests]
    errors = sum(status == 503 for duration, status in requests)
    p50 = nearest_rank(durations, 0.50)
    p95 = nearest_rank(durations, 0.95)
    print(
        f"{minute},{len(requests)},{errors},"
        f"{100 * errors / len(requests):.1f},{p50},{p95}"
    )
    all_durations.extend(durations)

print("histogram_ms: lower <= duration < upper; # = 1 request")
for lower in range(0, 1000, 200):
    upper = lower + 200
    count = sum(lower <= duration < upper for duration in all_durations)
    print(f"[{lower:4},{upper:4}): {count:2} {'#' * count}")

print(f"total_count={len(all_durations)}")
print(f"overall_p95_ms={nearest_rank(all_durations, 0.95)}")
```

出力は次のようになります。ヒストグラムの区間は下限を含み、上限を含みません。
この架空入力の値はすべて0ミリ秒以上1000ミリ秒未満です。別の入力では範囲外の値も数えられるよう区間を変えます。

```text
minute_UTC,count,errors,error_pct,p50_ms,p95_ms
09:00,5,1,20.0,100,700
09:01,5,1,20.0,110,800
09:02,5,1,20.0,125,950
histogram_ms: lower <= duration < upper; # = 1 request
[   0, 200): 12 ############
[ 200, 400):  0
[ 400, 600):  0
[ 600, 800):  1 #
[ 800,1000):  2 ##
total_count=15
overall_p95_ms=950
```

## 集計を図に対応させる

| 見たい内容 | 入力と作成方法 | 読み取りの限界 |
| --- | --- | --- |
| 時間変化 | 集計表の時刻を横軸、p50とp95をミリ秒の縦軸にする。3点なので観測点を表示する | 各点は1分集計で、区間内の変動を示さない。3点の例から長期傾向を判断しない |
| 分布 | 最後の度数表を横軸200ミリ秒幅・縦軸件数のヒストグラムにする | 800ミリ秒は800以上1000未満の区間。区間内の個々の値は図から分からない |
| 内訳 | 1分ごとに成功4件・エラー1件を積み上げる | 全要求の20%が503という例であり、利用者20%の失敗ではない |
| 時間ごとの分布 | 各分の生の値から同じ200ミリ秒区間の件数を数え、横軸時刻・縦軸区間・セル件数のヒートマップにする | p95だけから分布のセルを復元することはできない |

各分のp95の単純平均は約816.7ミリ秒ですが、全15要求から求めたこの例のp95は950ミリ秒です。
期間やインスタンスをまとめるとき、分位数の平均を全体の分位数として報告しない理由を示しています。
また、この例では各分のp95が最大値になります。標本数と計算法を省略すると、数字の精度を誤読します。

グラフには「架空データ」「サーバ側・完了応答」「成功と503を含む」「UTC・1分集計」「n=15」を添えます。
レイテンシに用いた集団とエラー率の分母が同じことを確認し、実際の報告では除外した観測も記載します。

[本文に戻る](../KNOWLEDGE.md)
