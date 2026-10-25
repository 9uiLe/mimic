---
title: プロダクトデザインの進め方と定義
---

# プロダクトデザインの進め方と定義

デジタルプロダクトについて、誰のどの問題を扱い、何を達成するために構築するかを考えるための読書案内です。
設計の流れ、必要な情報、目的・要求・評価の違いから、各概念の本文へ進みます。
章立てと表はMimicの編集上の整理です。単一の理論の公式手順や、全案件共通の必須書類ではありません。
各概念の定義と出典はリンク先で読み、版は各本文の先頭で確認します。
情報構造・操作・画面構成・共通の指針へ進むときは、[プロダクト全体のUI設計](product-ui-design.md)も参照できます。

## 設計の流れを読む

[人間中心設計](../knowledge/human-centered-design/KNOWLEDGE.md)は、人への理解を設計に結び付ける考え方の入口です。
[Double Diamond](../knowledge/double-diamond/KNOWLEDGE.md)は、課題と解決案について探索と絞り込みを行うプロセスを説明します。
ここから具体的な活動を読む際には、次のつながりがあります。

| 考えること | 読む本文 | 判断の材料になる内容 |
| --- | --- | --- |
| 利用する人と現在の状況を理解する | [ユーザーリサーチ](../knowledge/user-research/KNOWLEDGE.md) | 行動、目標、現状の方法、障壁、調査の根拠 |
| 取り組む問題と必要を説明する | [ユーザーニーズ](../knowledge/user-needs/KNOWLEDGE.md) | 誰が何を達成する必要があるか、解決案との違い |
| 案を具体化し、仕事として扱う | [ユーザーストーリーと受入条件](../knowledge/user-stories/KNOWLEDGE.md) | 必要との対応、機能・内容、期待する成果の条件 |
| 案を試し、利用後も評価する | [ユーザビリティテスト](../knowledge/usability-testing/KNOWLEDGE.md)、[HEART](../knowledge/heart-framework/KNOWLEDGE.md) | 課題を試す行動、目標に対応する兆候と指標 |

これは活動を一度ずつ終える工程表ではありません。
調査や試作から得た理解で問題の捉え方が変わり、先の判断へ戻ることがあります。
Double Diamondの四活動と、この表の概念を一対一に対応させる分類でもありません。

## 構築を考える際に必要な情報と定義

GOV.UKの[Discoveryの指針](https://www.gov.uk/service-manual/agile-delivery/how-the-discovery-phase-works)は、構築を決める前に問題、利用者の状況、制約、政策上の目的を理解すると説明します。
提示済みの解決案を問題として捉え直すことや、対象外を合意することも含みます。
以下は、その指針と各概念をつないだ確認観点です。情報をすべて確定できるとは限らず、根拠が増えると定義も見直されます。

| 観点 | 把握・定義する内容 | 詳しく読む |
| --- | --- | --- |
| 利用者と状況 | 実際・想定する利用者、目標、現在の手段、利用環境、支援する人、障壁 | [ユーザーリサーチ](../knowledge/user-research/KNOWLEDGE.md) |
| 問題とニーズ | 起きている困難と、望む成果のために満たす必要。根拠の所在も含む | [ユーザーニーズ](../knowledge/user-needs/KNOWLEDGE.md) |
| プロダクトの目的 | 利用者の必要にどう応え、組織のどの成果に寄与するか | 下記の「目的・成果物・評価基準を分ける」 |
| 対象範囲 | 利用過程のどこを扱い、何を対象外にするか。他のサービスや窓口との関係 | Discovery指針のDefine the problem、Understanding users and their context |
| 制約 | 法・契約、既存技術、業務やシステム。変えにくい条件と変更を検討できる条件 | Discovery指針のUnderstanding constraints |
| 不確実なこと | 未検証の仮定、確かめる調査質問、必要な根拠、対象者と方法 | [ユーザーリサーチ](../knowledge/user-research/KNOWLEDGE.md) |
| 実現する内容 | 利用者の必要につながる機能・内容、依存する仕事、優先順位 | [ユーザーストーリー](../knowledge/user-stories/KNOWLEDGE.md) |
| 受入条件 | 個々の仕事が、必要な成果を満たしたと確認する条件 | [受入条件](../knowledge/user-stories/KNOWLEDGE.md#受入条件) |
| 評価の定義 | 何を誰とどの課題で調べるか。何の兆候をどの指標で追うか | [ユーザビリティテスト](../knowledge/usability-testing/KNOWLEDGE.md)、[HEART](../knowledge/heart-framework/KNOWLEDGE.md) |

利用過程には、画面の前後にある作業や、電話・対面などの接点も含まれます。
Discoveryの期間や段階名は英国政府の運用であり、すべての製品への共通要件として採用しません。
この表も、セキュリティ、運用、技術仕様を含む要件定義全体を網羅するものではありません。

## 目的・成果物・評価基準を分ける

GOV.UKの[指標設計の指針](https://www.gov.uk/service-manual/measuring-success/how-to-set-performance-metrics-for-your-service)は、利用者の必要と意図する政策成果を踏まえてサービスの目的を説明し、寄与する成果から測定を考えます。
製品や機能の目標を指標へつなぐ考え方は、[HEARTと目標・シグナル・指標](../knowledge/heart-framework/KNOWLEDGE.md)で読めます。
利用者の成果、組織の成果、個々の仕事の完了は、同じ評価対象ではありません。

以下は区別のためのMimicの架空例です。調査で確認した目的・要求・効果ではありません。

| 種類 | 予約サービスを想定した記述例 |
| --- | --- |
| 利用者の必要 | 都合に合う日時を把握し、利用する予定を確定したい |
| プロダクトの目的 | 利用者が予約を完了でき、運営側の予約調整も進められる状態を目指す |
| 解決案・成果物 | 空き枠を選び、予約内容を確認する画面を作る |
| 受入条件の例 | 確定前に日時・場所を確認でき、確定後に予約内容が分かる |
| 評価の問い | 想定する利用者が、希望日時を選び、予約結果を理解できるか |
| 指標の定義例 | 予約を開始した対象利用者のうち、完了した利用者の割合。開始・完了の判定、対象、計測期間も定める |

画面の完成と目的への到達は、確認する内容が異なります。
指標の比較にも基準時点や対象の区分などの文脈が必要です。
数値目標はこの例では定めません。根拠のない目標値を一般的な推奨値に置き換えないためです。
GOV.UKの[評価対象を分ける指針](https://www.gov.uk/service-manual/measuring-success/measuring-the-success-of-your-service)は、取引、利用過程全体、組織の目標への寄与を別々に説明しています。

## 試作・情報構成・表現へつなぐ

GOV.UKの[プロトタイプの指針](https://www.gov.uk/service-manual/design/making-prototypes)は、案を探索・共有・検証するための試作を説明します。
試作で何を調べるかと、その結果から何を判断できるかは、[ユーザビリティテスト](../knowledge/usability-testing/KNOWLEDGE.md)へ進みます。

構成や表現の検討には、次の既存知識がつながります。
活動の説明から要求・機能候補・画面構成へ進む考え方は、[シナリオから機能と画面構成を考える](scenario-to-screen.md)で読み分けられます。

| 考えること | 読む本文 |
| --- | --- |
| どの情報を判断に使い、どう提示するか | [判断材料の選定](decision-material-selection.md) |
| 構成要素・仕組み・動作をどう理解できるか | [概念モデル](../knowledge/conceptual-models/KNOWLEDGE.md) |
| 情報をどう分類し、名称や配置で関係を示すか | [グルーピング](../knowledge/grouping/KNOWLEDGE.md) |
| 内容の階層と相対的な強調をどう表すか | [視覚的な優先順位](../knowledge/visual-hierarchy/KNOWLEDGE.md) |
| 文字をどう組み、拡大時にも内容を保つか | [Typography](../knowledge/typography/KNOWLEDGE.md) |
| 設計情報を名前と値でどう共有するか | [Design Token](../knowledge/design-tokens/KNOWLEDGE.md) |

各概念は異なる問いを扱います。この並びは、実施順や、外観を整えれば目的へ到達できるという保証ではありません。
具体的なUIへ適用する際の判断と、その画面での検証は、知識の説明と区別します。

## 出典とこの案内の範囲

個別概念の主張と出典の対応は、各本文の `references/sources.md` にあります。
構築前の情報はDiscovery指針のDefine the problem、What to find out in discovery、How you'll measure successを参照しています。
目的と測定は指標設計指針のBase your metrics on a sound understanding of your service's purpose、Define goals, or 'benefits', for your service、Give context to your measurementsを参照しています。
各資料をつなぐ表と予約の例は、Mimicの説明上の整理です。原典の必須書式ではありません。

[知識の索引](../knowledge/README.md)から、収録するすべての概念へ進めます。
