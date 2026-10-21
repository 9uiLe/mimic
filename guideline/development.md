# 開発・公開ガイド

横断的な案内と利用ガイドから閲覧用の生成物を更新し、ローカルで検査してGitHub Pagesへ公開するための手順です。掲載・採用・操作の許可は[Repositoryの方針と利用ガイド](README.md)に従います。

## 編集する場所

- デザイン知識の正本は `knowledge/<概念ID>/KNOWLEDGE.md` とそこから参照する補足資料です。[知識の入口](../knowledge/README.md)から参照できます。配置は[知識の構造ガイド](knowledge-structure.md)に従います。
- 複数の概念を横断して読むための案内は `topics/` を編集します。
- Repositoryの運用方針は[利用ガイド](README.md)、AIの作業指示は[AI向けガイド](ai.md)を編集します。
- 閲覧ページと参照用Markdownは生成物です。Markdownの編集元を変更し、再生成します。

「判断材料の選定」の案内は、`topics/decision-material-selection.md` から `prototypes/decision-material-selection/index.html` と `ai.md` を生成します。個別概念の本文・出典・例を自動的に取り込むものではありません。各概念には個別のHTMLを生成せず、Markdownへリンクします。

`prototypes/decision-material-selection/draft.md` は旧版 `0.1.1` を基にした別の研究資料です。研究資料から生成する `research/` の出力を、現在の正本の更新案や採用済みの共通知識として扱いません。

出典との照合記録は[採用レビュー用の資料](../prototypes/knowledge-adoption/README.md)から参照できます。変更理由や確認結果の報告はPRに記載し、READMEへ変更履歴や作業記録を追記しません。

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

`build:pages` は案内ページとガイドの生成物を更新し、公開対象を `_site/` に組み立てます。`verify` はTypeScriptの型検査、案内ページの生成物の鮮度確認、生成と公開の振る舞いのテストを実行します。

案内ページと研究資料を個別に扱うコマンドは次のとおりです。

| 対象 | 生成 | 鮮度確認 |
| --- | --- | --- |
| 横断的な案内 | `bun run build:prototype` | `bun run check:prototype` |
| 研究資料 | `bun run build:research-prototype` | `bun run check:research-prototype` |

既存のmarkedモジュールを使う場合は、生成スクリプトの `--marked-module` に絶対パスを指定できます。`MARKED_MODULE` 環境変数でも指定でき、生成・鮮度確認・テストに共通して使います。

## 生成の規則

人向けページの表示構造は[表示規約](../prototypes/knowledge-view.md)、実装は[知識の生成器](../scripts/build-knowledge.ts)と[共通CSS](../scripts/knowledge-view.css)で管理します。内容を更新するたびに別の配色や配置を作らず、必要な構造の変更は表示規約と生成器に反映します。

横断的な案内のページは通常のMarkdownから生成し、H2見出しと本文の順序を保持します。生成器がリンク先の概念を読み込んだり、独自の判断手順や採用操作を知識へ追加したりすることはありません。研究資料は従来の意味役割を使う構成で生成します。表示上の `proposed` は「採用前の文書」、`draft` は「研究資料（未採用）」です。

参照用Markdownは編集元の本文とメタデータを保持し、相対リンクだけを出力位置から同じ参照先へ届く形に補正します。段落・見出し・表にあるインライン形式のリンク `[名前](相対パス)` に対応し、コード中の文字は変更しません。参照形式のリンクや、位置を確実に特定できない複雑な構文は、誤変換せず生成を止めます。HTMLや画像の埋め込みも受け付けません。

## GitHub Pagesへの公開

公開先はPublic Repository `9uiLe/mimic` の標準URL [https://9uile.github.io/mimic/](https://9uile.github.io/mimic/) です。入口は「判断材料の選定」の横断的な案内から生成したページです。公開されたことから、文書が正式採用済みだとは判断しません。

[公開ファイルの一覧](../scripts/build-pages.ts)にあるファイルだけを `_site/` に組み立てます。知識ディレクトリやその `scripts/` を追加しても、Pagesへ自動的に公開したり、スクリプトを実行したりしません。公開済みガイドから、この開発ガイドや知識の構造ガイドへはGitHub上のMarkdownへリンクします。

出力先に一覧外のファイル、シンボリックリンク、想定外の構造があれば生成を止め、自動削除せず内容を確認します。作業ログ、PDF、Moletta、Git履歴は配信しません。`_site/` とローカル出力の `output/` はGit管理対象外です。Public Repositoryへコミットしたファイルは、Pagesの対象外でもGitHub上で閲覧できます。

PRでは[検査処理](../.github/workflows/ci.yml)が同じ生成・検査を行います。[公開処理](../.github/workflows/pages.yml)は `main` へのpushをきっかけに実行し、検査に成功した `_site/` を配信します。**`main` への反映は公開操作を伴います。** 公開対象と操作の許可を確認し、既に明示的に許可された範囲では同じ許可を聞き直しません。

GitHub側の設定ではPagesのSourceをGitHub Actionsに、`github-pages` 環境を `main` からの公開に限定します。設定を変更する場合も、対象と操作の許可を確認します。[GitHub公式の設定手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 確認すること

生成・検査では、配信対象、原文との対応、リンク、生成物の鮮度を確認します。知識の原典への忠実さや説明の明確さは、本文と出典を照合して確認します。生成に成功したことを、知識の正しさや実画面の使いやすさの証明にしません。

閲覧ページの見た目、狭い幅での表示、文字拡大、操作、読み上げは、その実物と対象環境で確認します。実施した対象と結果、未確認の環境はPRに記載します。
