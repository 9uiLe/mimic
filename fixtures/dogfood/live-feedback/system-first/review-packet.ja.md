# 9UI-159 判断用メモ

## 何を判断するか

Riverbend の**合成された画面・データ一覧**に限り、「作業指示を一覧で見て、1件の詳細を開き、そこから1班を割り当てられる」というS04の記述を、今後の設計で使うsourceとして承認するかを判断する。実運用のbackendや利用者調査が確認された、という判断ではない。

新しいRun `run_9ui159_source_review` の `task_source_review` は、157と同じ `inputs/input-packet.json` だけをrouted evidenceとして受け取った。旧Runのpending artifactは新Runのbaseではない。CLIが受理した候補は `art_rb157_current_inspection@2`、digest `sha256:0c8180500def077593d3b0bb11ffabeda44504b39a3dea3a7f618a9925f9d0c0`。`packet_rb159_source` の `proposal_rb159_source` はready/pendingで、canonicalは0件のまま。

## 根拠と分からないこと

合成入力の一覧には作業指示ID、区域、重大度、経過時間、担当班がある。画面一覧から1件の詳細を開き、その詳細で1班の割当操作をする想定がある。これは構築済みinventoryについての事実で、配備されたサービスの実測ではない。

詳細画面が重大度・経過時間・担当班を更新するか、更新時刻をどう示すかは不明。認可、エラー、割当結果の永続性、本番での挙動、利用者の観察結果も不明。旧requestが求めるdetail freshnessに「保証なし／不明」と答えることも有効な結果である。比較APIや一括割当APIを新たな事実として置いていない。

## 選択肢と影響

| 選択                   | 影響                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| このexact sourceを承認 | 実際の人間の確認とHuman Commit Pointを別途行うと、予定上はsource @3だけがcanonicalになる。detail freshnessは未解決のまま。 |
| 修正を依頼             | 追加の実証または文言修正から新候補を作り、revision・digest・判断資料を更新する。                                           |
| 却下                   | 正規の人間判断で拒否を記録し、再提案はその拒否を参照するさらに新しいrevisionにする。                                       |

`planning/decision.preview.json` は、承認された場合の `art_rb157_current_inspection@3`（`sha256:f39c8286a87bb8d4e71c8934e99230e93ed81e51f99fffd68945bda4e716dc60`）をexactに記述する。scopeは `organization/org_local`、依存lockは空。`planning/commit.preview.json` はそのproposalとdecisionだけを指す。両ファイルの人間actorと時刻は**仮のreview値**で、確認を受けた証拠ではない。実判断時にactor・時刻・候補・packet・output・commitを再照合し、値が変わればdigestを作り直す。この作業ではdecide/commitを実行していない。

旧 `art_rb157_current_inspection@1` はprovisionalでproposalなし。旧 `packet_rb157_product` のS01候補と `art_rb157_detail_freshness_request@1` はその@1をlockしている。新sourceを承認しても旧@1や旧requestは書き換わらず、S01も自動承認されない。後続Runでapproved source @3を明示的に受け、product/task/contract/requestの新revisionとlockを作って評価する必要がある。全System Feedback周回や9UI-124完了は今回の結果ではない。

## 158統合後に確認したこと

157元workspaceの同一pathで、旧S05の同一package/workを正規CLIへretryした。v1 markerのpackageDigest `f12b10c940e150e231bc02a6544cdf301ebfdd248669a1c299049383cfd4b934` とworkDigest `f13d76f0b92ad68e2c3e55435434c03c514fce4d1599cfef3104ff9103c35373` は一致した。CLIはexit 0・accepted、1件のrequestを `pending-source-approval` と読戻した。同一retryもexit 0、変更workはexit 5で拒否された。元のworkspace state、v1 marker、旧workのhashおよびイベント・artifact件数は不変で、新しくimmutable recovery sidecar、CLI出力、別名の負例workファイルが増えた。旧work本体は不変。sourceは承認されておらず、上流routing、回答、下流再評価は起きていない。

別rootへコピーしたworkspaceでは、同じpackage bytesでもabsolute directoryを含むpackageDigestが `3b37c293b3375dbb1289452ad9ada37c7c8275e28d650dc81e4ddfc5608ee213` に変わり、旧v1 markerとのretryはexit 5で拒否された。別rootで行うなら新しいRun・新しいexact artifactsの**replay**として記録し、v1 recoveryと混同しない。markerの手編集や旧pendingを承認済みとして持ち込む方法は使わない。

候補の `meta.createdAt=2026-10-07T23:25:00.000Z` はauthoring時に固定したenvelope値で、実測生成時刻ではない。CLIのproduce/packet eventは `23:23:54.004Z` で約66秒早い。保存済みartifactやイベントを遡及修正していない。

実入力、stdout/exit、元path recoveryのsidecar、別root失敗、digest照合は `execution/` に保存した。planned approved artifactのCLI検証は**schema-only**でexit 0であり、人間のauthorityや最終publicationが通る証明ではない。

新source proposalの実行状態は159の隔離コピー、旧requestのrecovery side-channelは157元workspaceにある。2つのworkspaceのcanonicalやrequest状態は自動で共有されない。後続の承認と新しいS01/S02/S05/requestのrebindは、選んだ同一workspaceで正規CLIから行う。元workspaceを選ぶ場合は新source Run自体を正規CLIで再現する必要があり、今回は実行していない。
