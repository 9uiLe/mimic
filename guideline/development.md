# 開発・公開ガイド

知識本文・横断的な案内・利用ガイド・関係グラフからGitHub Pagesの閲覧ページを生成し、ローカルで検査する手順です。掲載と公開操作の許可は[Repositoryの方針と利用ガイド](README.md)に従います。

## 編集する場所

- デザイン知識の正本は `knowledge/<概念ID>/KNOWLEDGE.md` とそこから参照する補足資料です。[知識の入口](../knowledge/README.md)から参照できます。配置は[知識の構造ガイド](knowledge-structure.md)に従います。
- 構造化した関係は `relations/graph.json`、関係型・方向・推移規則は `relations/vocabulary.json` を編集します。[関係グラフの案内](../relations/README.md)に従い、本文内の説明と根拠を照合します。
- 複数の概念を横断して読むための案内は `topics/` を編集します。
- Repositoryの運用方針は[利用ガイド](README.md)、AIの作業指示は[AI向けガイド](ai.md)を編集します。
- 本文の表示構造は `scripts/` と既存の `scripts/knowledge-view.css`、グラフのブラウザ表示は `web/graph.js`・`web/graph.css` を編集します。配布フォントは `assets/` に保持します。
- 閲覧ページは生成物です。Markdown・JSONの正本と表示実装を変更してから再生成します。

「判断材料の選定」の案内は `topics/decision-material-selection.md` を正本とし、Pagesでは `topics/decision-material-selection.html` を生成して関連する5概念のHTMLへ案内します。個別概念の本文・出典・例は案内へ取り込みません。Pagesでは別途、明示した14概念と補足資料を個別のHTMLとして生成し、Markdown原文も配信します。

旧 `prototypes/decision-material-selection/index.html` の人向けURLには短い移動案内を生成します。旧研究資料の全文はPagesへ配信しません。

変更理由や確認結果の報告はPRに記載し、READMEへ変更履歴や作業記録を追記しません。

## 環境と基本手順

生成と検査にはBunとTypeScriptを使います。[Nix設定](../flake.nix)と `flake.lock` でBunの版を、`bun.lock` で依存ライブラリの版を固定します。対象はApple SiliconのmacOSと、GitHub Actionsで使うx86_64のLinuxです。

Nixを導入した環境で、Repositoryのルートから実行します。

```sh
nix develop path:.
bun install --frozen-lockfile --ignore-scripts
bun run relations:check
bun run quality:check
bun run quality:test
bun run build:pages
bun run verify
```

`path:.` を指定すると、Gitに未追加のNix設定も使えます。`nix-command` または `flakes` が無効の場合は、最初のコマンドを `nix --extra-experimental-features 'nix-command flakes' develop path:.` に置き換えます。開発環境に入る操作だけでは、依存の導入・生成・公開は行いません。

`relations:check` は関係データの構造と本文の識別情報・版・SHA-256・根拠参照を検査します。`build:pages` はMarkdownと関係データからHTMLを生成し、公開対象を `_site/` に組み立てます。`verify` はTypeScriptの型検査と、生成・公開の振る舞いを確かめるテストを実行します。`_site/` とローカルプレビューなどの `output/` はGit管理対象外で、知識・案内・ガイドのMarkdown原文をGitで管理します。

題目別案内を任意にローカルプレビューする場合は次のコマンドを使います。

| 対象 | 生成 | 鮮度確認 |
| --- | --- | --- |
| 題目別案内のローカルプレビュー（`output/knowledge-preview/`） | `bun run build:prototype` | `bun run check:prototype` |

以前の `_site/` に旧研究ページなど現行の公開一覧にないファイルがある場合、組み立ては安全のため停止します。中身を確認してから、既存の `_site/` を `output/` 以下の別名へ退避し、新しい `_site/` を生成してください。生成器は一覧外のファイルを自動削除しません。

既存のmarkedモジュールを使う場合は、生成スクリプトの `--marked-module` に絶対パスを指定できます。`MARKED_MODULE` 環境変数でも指定でき、生成・鮮度確認・テストに共通して使います。

## 本文と関係の更新

本文の定義・版・見出し・引用を変更したときは、その本文をノードまたは根拠として参照する関係を確認します。型・方向・statement・依存する範囲・根拠が引き続き本文の意味に一致するかを人またはAIが再照合し、必要な辺を編集します。本文の全文SHA-256が変わるため、見た目だけの修正も鮮度確認の対象になります。

再照合後に実行します。

```sh
bun run relations:sync
bun run relations:check
```

`relations:sync` はノードの本文メタデータとSHA-256を同期するだけで、意味辺を追加・修正・再判定しません。同期を本文の意味の確認の代わりにしません。`relations:check` の成功は構造・参照・鮮度の検査結果であり、意味上の正しさの保証ではありません。

新しい概念は本文と必要な補足を作成し、ノードを登録します。関係は本文に根拠があるものだけを記載し、階層や依存の網羅を目標に推測で埋めません。関係型の追加・意味変更では語彙を更新し、既存の辺と閲覧表示への影響を確認します。

## 生成の規則

人向けページの表示構造は[表示規約](knowledge-view.md)、実装は[知識の生成器](../scripts/build-knowledge.ts)と[共通CSS](../scripts/knowledge-view.css)で管理します。内容を更新するたびに別の配色や配置を作らず、必要な構造の変更は表示規約と生成器に反映します。

横断的な案内のページは通常のMarkdownから生成し、H2見出しと本文の順序を保持します。生成器がリンク先の概念を読み込んだり、独自の判断手順を知識へ追加したりすることはありません。閲覧表示には正本の版を示します。8役割を指定するMarkdownの生成契約は表示規約とテストで確認します。

ローカルプレビューの生成Markdownは正本の本文とメタデータを保持し、相対リンクだけを出力位置から同じ参照先へ届く形に補正します。段落・見出し・表にあるインライン形式のリンク `[名前](相対パス)` に対応し、コード中の文字は変更しません。参照形式のリンクや、位置を確実に特定できない複雑な構文は、誤変換せず生成を止めます。HTMLの埋め込みと外部画像は受け付けません。説明用の画像は、公開一覧に明示した自己完結のSVGだけを扱います。Markdownの代替テキストと通常のリンクを保持し、画像と編集元を同じ相対位置で配信します。

## GitHub Pagesへの公開

公開先はPublic Repository `9uiLe/mimic` の標準URL [https://9uile.github.io/mimic/](https://9uile.github.io/mimic/) です。入口は全14概念の一覧と関係グラフへの案内です。`graph/index.html` では検索・関係型フィルタ・概念選択を使い、辺の型・方向・根拠から本文へ進めます。JavaScriptを使わない場合も静的一覧から概念・関係・根拠を読めます。各概念のHTMLから関係グラフ・関連概念・出典・例へ進めます。題目別案内はPages専用のHTMLから関連概念へ進めます。色の知識とAI Slopに関する案内も別の読書経路として表示します。文書の版と対象範囲は正本のメタデータで確認し、出典は本文からたどります。

[公開ファイルの組み立て](../scripts/build-pages.ts)と[概念・閲覧先の一覧](../scripts/pages-catalog.ts)に明示したファイルだけを `_site/` に組み立てます。関係データの配布対象は `relations/graph.json`・`relations/vocabulary.json`・`relations/README.md`、グラフの表示対象は `graph/index.html` と `web/` の指定したJavaScript・CSSです。知識ディレクトリやその `scripts/` を追加しても、Pagesへ自動的に公開したり、スクリプトを実行したりしません。公開済みガイドから、この開発ガイドや知識の構造ガイドへはGitHub上のMarkdownへリンクします。

出力先に一覧外のファイル、シンボリックリンク、想定外の構造があれば生成を止め、自動削除せず内容を確認します。作業ログ、PDF、Moletta、Git履歴は配信しません。Public Repositoryへコミットしたファイルは、Pagesの対象外でもGitHub上で閲覧できます。

PRでは[検査処理](../.github/workflows/ci.yml)が同じ生成・検査を行います。[公開処理](../.github/workflows/pages.yml)は `main` へのpushをきっかけに実行し、検査に成功した `_site/` を配信します。**`main` への反映は公開操作を伴います。** 公開対象と操作の許可を確認し、既に明示的に許可された範囲では同じ許可を聞き直しません。

pushに対応する公開実行を確認できない場合は、公開対象と操作の許可を確認したうえで `main` を指定して手動実行できます。手動実行に対応したworkflowがdefault branchに反映されている必要があり、build・deployはpushと手動実行のいずれも `main` に限定します。

```sh
gh workflow run pages.yml --ref main
```

実行対象の `main` のSHAを確認し、そのSHAに一致する公開runのbuild・deployの成功と、配信された内容を確認します。起動要求の成功だけでは公開完了と扱いません。[GitHub公式の手動実行手順](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

GitHub側の設定ではPagesのSourceをGitHub Actionsに、`github-pages` 環境を `main` からの公開に限定します。設定を変更する場合も、対象と操作の許可を確認します。[GitHub公式の設定手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 確認すること

生成・検査では、配信対象、原文との対応、リンク、生成物の鮮度、関係データと本文の対応を確認します。グラフの検索・型フィルタ・選択詳細・根拠と本文へのリンク、JavaScriptなしの静的一覧も対象にします。知識の原典への忠実さや説明の明確さは、本文と出典を照合して確認します。生成に成功したことを、知識の正しさや実画面の使いやすさの証明にしません。

閲覧ページの見た目、狭い幅での表示、文字拡大、操作、読み上げは、その実物と対象環境で確認します。実施した対象と結果、未確認の環境はPRに記載します。

## 変更の品質検査

通常セットアップで `bun run setup:hooks` を実行します。全体検査・ステージ済み検査・基準の扱いとテストの根拠は[品質検査ガイド](quality-checks.md)に従います。
