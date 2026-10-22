# 開発・公開ガイド

横断的な案内と利用ガイドからGitHub Pagesの閲覧用HTMLを生成し、ローカルで検査する手順です。掲載と公開操作の許可は[Repositoryの方針と利用ガイド](README.md)に従います。

## 編集する場所

- デザイン知識の正本は `knowledge/<概念ID>/KNOWLEDGE.md` とそこから参照する補足資料です。[知識の入口](../knowledge/README.md)から参照できます。配置は[知識の構造ガイド](knowledge-structure.md)に従います。
- 複数の概念を横断して読むための案内は `topics/` を編集します。
- Repositoryの運用方針は[利用ガイド](README.md)、AIの作業指示は[AI向けガイド](ai.md)を編集します。
- 閲覧ページは生成物です。Markdownの正本を変更してから再生成します。

「判断材料の選定」の案内は `topics/decision-material-selection.md` を正本とし、Pagesでは `topics/decision-material-selection.html` を生成して関連する5概念のHTMLへ案内します。個別概念の本文・出典・例は案内へ取り込みません。Pagesでは別途、明示した14概念と補足資料を個別のHTMLとして生成し、Markdown原文も配信します。

旧 `prototypes/decision-material-selection/index.html` の人向けURLには短い移動案内を生成します。旧研究資料の全文はPagesへ配信しません。

変更理由や確認結果の報告はPRに記載し、READMEへ変更履歴や作業記録を追記しません。

## 環境と基本手順

生成と検査にはBunとTypeScriptを使います。[Nix設定](../flake.nix)と `flake.lock` でBunの版を、`bun.lock` で依存ライブラリの版を固定します。対象はApple SiliconのmacOSと、GitHub Actionsで使うx86_64のLinuxです。

Nixを導入した環境で、Repositoryのルートから実行します。

```sh
nix develop path:.
bun install --frozen-lockfile --ignore-scripts
bun run build:pages
bun run verify
```

`path:.` を指定すると、Gitに未追加のNix設定も使えます。`nix-command` または `flakes` が無効の場合は、最初のコマンドを `nix --extra-experimental-features 'nix-command flakes' develop path:.` に置き換えます。開発環境に入る操作だけでは、依存の導入・生成・公開は行いません。

`build:pages` はMarkdown正本からHTMLを生成し、公開対象を `_site/` に組み立てます。`verify` はTypeScriptの型検査と、生成・公開の振る舞いを確かめるテストを実行します。`_site/` とローカルプレビューなどの `output/` はGit管理対象外で、知識・案内・ガイドのMarkdown原文をGitで管理します。

題目別案内を任意にローカルプレビューする場合は次のコマンドを使います。

| 対象 | 生成 | 鮮度確認 |
| --- | --- | --- |
| 題目別案内のローカルプレビュー（`output/knowledge-preview/`） | `bun run build:prototype` | `bun run check:prototype` |

以前の `_site/` に旧研究ページなど現行の公開一覧にないファイルがある場合、組み立ては安全のため停止します。中身を確認してから、既存の `_site/` を `output/` 以下の別名へ退避し、新しい `_site/` を生成してください。生成器は一覧外のファイルを自動削除しません。

既存のmarkedモジュールを使う場合は、生成スクリプトの `--marked-module` に絶対パスを指定できます。`MARKED_MODULE` 環境変数でも指定でき、生成・鮮度確認・テストに共通して使います。

## 生成の規則

人向けページの表示構造は[表示規約](knowledge-view.md)、実装は[知識の生成器](../scripts/build-knowledge.ts)と[共通CSS](../scripts/knowledge-view.css)で管理します。内容を更新するたびに別の配色や配置を作らず、必要な構造の変更は表示規約と生成器に反映します。

横断的な案内のページは通常のMarkdownから生成し、H2見出しと本文の順序を保持します。生成器がリンク先の概念を読み込んだり、独自の判断手順を知識へ追加したりすることはありません。閲覧表示には正本の版を示します。8役割を指定するMarkdownの生成契約は表示規約とテストで確認します。

ローカルプレビューの生成Markdownは正本の本文とメタデータを保持し、相対リンクだけを出力位置から同じ参照先へ届く形に補正します。段落・見出し・表にあるインライン形式のリンク `[名前](相対パス)` に対応し、コード中の文字は変更しません。参照形式のリンクや、位置を確実に特定できない複雑な構文は、誤変換せず生成を止めます。HTMLの埋め込みと外部画像は受け付けません。説明用の画像は、公開一覧に明示した自己完結のSVGだけを扱います。Markdownの代替テキストと通常のリンクを保持し、画像と編集元を同じ相対位置で配信します。

## GitHub Pagesへの公開

公開先はPublic Repository `9uiLe/mimic` の標準URL [https://9uile.github.io/mimic/](https://9uile.github.io/mimic/) です。入口は全14概念の一覧です。各概念のHTMLから関連概念・出典・例へ進めます。題目別案内はPages専用のHTMLから関連概念へ進めます。色の知識とAI Slopに関する案内も別の読書経路として表示します。文書の版と対象範囲は正本のメタデータで確認し、出典は本文からたどります。

[公開ファイルの組み立て](../scripts/build-pages.ts)と[概念・閲覧先の一覧](../scripts/pages-catalog.ts)に明示したファイルだけを `_site/` に組み立てます。知識ディレクトリやその `scripts/` を追加しても、Pagesへ自動的に公開したり、スクリプトを実行したりしません。公開済みガイドから、この開発ガイドや知識の構造ガイドへはGitHub上のMarkdownへリンクします。

出力先に一覧外のファイル、シンボリックリンク、想定外の構造があれば生成を止め、自動削除せず内容を確認します。作業ログ、PDF、Moletta、Git履歴は配信しません。Public Repositoryへコミットしたファイルは、Pagesの対象外でもGitHub上で閲覧できます。

PRでは[検査処理](../.github/workflows/ci.yml)が同じ生成・検査を行います。[公開処理](../.github/workflows/pages.yml)は `main` へのpushをきっかけに実行し、検査に成功した `_site/` を配信します。**`main` への反映は公開操作を伴います。** 公開対象と操作の許可を確認し、既に明示的に許可された範囲では同じ許可を聞き直しません。

GitHub側の設定ではPagesのSourceをGitHub Actionsに、`github-pages` 環境を `main` からの公開に限定します。設定を変更する場合も、対象と操作の許可を確認します。[GitHub公式の設定手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 確認すること

生成・検査では、配信対象、原文との対応、リンク、生成物の鮮度を確認します。知識の原典への忠実さや説明の明確さは、本文と出典を照合して確認します。生成に成功したことを、知識の正しさや実画面の使いやすさの証明にしません。

閲覧ページの見た目、狭い幅での表示、文字拡大、操作、読み上げは、その実物と対象環境で確認します。実施した対象と結果、未確認の環境はPRに記載します。

## 変更の品質検査

通常セットアップで `bun run setup:hooks` を実行します。全体検査・ステージ済み検査・基準の扱いとテストの根拠は[品質検査ガイド](quality-checks.md)に従います。
