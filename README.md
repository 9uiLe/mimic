# Mimic

デジタルUIに関するデザインの知識・概念・思想・哲学を言語化し、人とAIが理解できるように説明する知識データベースです。

このREADMEは人向けの入口です。AIは [AI向けの入口](knowledge/README.md) から、詳細な知識の正本を読みます。判断の条件・手順・根拠・限界は正本に定義し、このREADMEはその説明として扱います。

Repositoryの掲載・編集・採用方針は [人向けの利用ガイド](guideline/README.md) に、AIの参照・編集・確認の手順は [AI向けの作業ガイド](guideline/ai.md) に記載しています。

## 全体像

利用者の目的と条件から判断材料を選び、まとまりと視覚的な優先順位を考えます。まとまり方によって必要な情報が変わるため、3件は往復して使います。

| 知識の正本 | 扱う判断 | 参照ID / 版 / 状態 |
| --- | --- | --- |
| [判断材料の選定](knowledge/decision-material-selection.md) | 目的に必要な情報と、常時表示・必要時表示・詳細の分け方 | `decision-material-selection` / `0.1.1` / `proposed` |
| [グルーピング](knowledge/grouping.md) | 何をひとまとまりとして扱い、関係や文脈を伝えるか | `grouping` / `0.1.0` / `proposed` |
| [視覚的な優先順位](knowledge/visual-hierarchy.md) | どこから読み、関係や重要度をどう理解できるようにするか | `visual-hierarchy` / `0.1.0` / `proposed` |

例えば、検索結果が同じフォルダだけなら保存先を見出しにまとめる案があります。別フォルダの同名資料も含まれるなら、識別に必要な保存先を各行に戻す案を検討します。これは条件による判断の違いを示す説明例で、実際の使いやすさは未検証です。

## 知識の範囲と確かさ

Web（PC・モバイル）、iOS、Androidなどに使う共通のUI知識を扱います。案件固有の仕様・設計書・レビュー資料は各案件に置きます。ブランディング、個別のDesign System、個人の好みは対象外です。

3件はいずれも仮案（`proposed`）です。出典が支える指針、Mimicの提案、説明用の仮定を正本で区別しています。出典の現行内容の再照合、実画面での有効性、各工程への自動参照の組み込みは未確認です。

知識の採用では、原典への忠実さと説明の明確さを確認します。画面での効果測定や自動参照の動作確認は、対象機能の品質として別に扱います。採用の基準は [利用ガイド](guideline/README.md) に従います。ガイドの公開によって、既存3件の採用状態は変わりません。

３件の説明文を整理した [採用候補と出典の確認記録](prototypes/knowledge-adoption/README.md) を、本文レビュー用の編集資料として置いています。正本とGitHub Pagesへの反映は、本文の採用判断後に行います。

過去の参照比較では、記録された全件成功の誤報は両版とも0件で、追加手順による低減効果の差は未実証でした。保存記録はGitの `fc54bf0` から確認できます。

## 判断材料の選定の試作品

[新しい研究案の閲覧ページ](prototypes/decision-material-selection/research/index.html)では、目的から判断材料を導く5つの軸と、複数の提示案の採否を試しています。[研究案の編集元](prototypes/decision-material-selection/draft.md)は `0.2.0-draft` の採用前更新案です。[研究案のAI向け全文](prototypes/decision-material-selection/research/ai.md)も、同じ編集元から生成します。研究内容は現行の共通知識へまだ採用していません。

[現行正本の閲覧ページ](prototypes/decision-material-selection/index.html)と[AI向けの全文](prototypes/decision-material-selection/ai.md)は、[現行正本](knowledge/decision-material-selection.md)から生成します。現行版と更新案は比較のために区別して置き、同じ状態の正本を二重管理するものではありません。

知識を編集する場所は各版の編集元だけです。閲覧ページとAI向け全文は生成物として扱い、直接編集しません。AI向け全文は編集元の本文とメタデータを保持し、相対リンクだけを出力位置から同じ参照先へ届く形に補正します。人向けの知識文も編集元から取り出します。生成物が古くなっていないかは再生成結果との比較で確認します。

両方のページは、共通の[表示規約](prototypes/knowledge-view.md)・部品・CSSを使います。知識の更新と、見た目の改定を分けて扱います。題名や情報量に合わせて毎回別のデザインを生成しません。

生成・検査にはBunとTypeScriptを使います。[Nix環境](flake.nix)と`flake.lock`でBunの版を、`bun.lock`でmarked・TypeScript・型定義の版を固定します。開発環境の対象はApple SiliconのmacOSと、GitHub Actionsで使うx86_64のLinuxです。Nix以外にNode.jsやnpmを個別導入する必要はありません。

Nixを導入済みの環境で、Repositoryのルートから実行します。`path:.`を指定すると、まだGitに追加されていないNix設定も使えます。

```sh
nix develop path:.
bun install --frozen-lockfile --ignore-scripts
bun run build:pages
bun run verify
```

Nixが`nix-command`または`flakes`を無効としている場合は、最初のコマンドを`nix --extra-experimental-features 'nix-command flakes' develop path:.`に置き換えます。環境に入るだけでは依存の導入・生成・公開を行いません。

`verify`はTypeScriptの型検査、両版の生成物の鮮度確認、生成と公開の振る舞いのテストを実行します。TypeScriptとして実行できるだけでは型検査済みと扱いません。片方だけ更新する場合は`bun run build:prototype`または`bun run build:research-prototype`、対応する鮮度確認には`bun run check:prototype`または`bun run check:research-prototype`を使います。

既に利用できるmarkedモジュールを使う場合は、生成スクリプトの`--marked-module`で絶対パスを指定できます。`MARKED_MODULE`環境変数でも指定でき、生成・鮮度確認・テストに共通して使えます。この試作は「判断材料の選定」に対応し、8つの意味役割を編集元で明示します。見出し文言・本文量・例の数の変更は受け付け、未知の役割や重複IDは生成を止めます。HTMLや画像の埋め込みは受け付けません。

相対リンクの補正は、段落・見出し・表のインライン形式 `[名前](相対パス)` に対応します。コード中の文字は変更しません。参照形式のリンクや、複雑なブロック内の相対リンクなど、確実に位置を特定できない書き方は、誤変換せず生成を止めます。

閲覧ページは生成後、ローカルで開けます。公開や外部への送信は不要です。研究案では4出典の該当箇所を再照合していますが、理論の一般UIへの応用、実際の使いやすさ、人向けページの実画面での仕上がりは未検証です。

## GitHub Pagesでの閲覧

公開先には、Public Repository `9uiLe/mimic` の標準URL [https://9uile.github.io/mimic/](https://9uile.github.io/mimic/) を使います。一般公開のサイトとして扱い、独自ドメインや有料ランナーは使いません。

入口は「判断材料の選定」の研究案です。ページ上で「更新案（未採用）」と表示し、公開したことを共通知識への採用とは扱いません。現行版と研究案のHTML・AI全文、対応する編集元と関連知識を配信します。

[人向けの利用ガイド](https://9uile.github.io/mimic/guideline/) と [AI向けの作業ガイド](https://9uile.github.io/mimic/guideline/ai.html) も公開します。両知識ページの上部から利用ガイドへ移動できます。編集元は `guideline/README.md` と `guideline/ai.md` で、両方のMarkdownと生成HTMLを配信します。

```sh
nix develop path:. --command bun run build:pages
nix develop path:. --command bun run verify
```

`build:pages`は同じ正本・生成器から両知識ページを再生成し、ガイドのMarkdownからHTMLを生成して、[公開ファイルの一覧](scripts/build-pages.ts)にある14ファイルだけを `_site/` へ組み立てます。PDF、作業ログ、Moletta、Git履歴はPagesの配信対象に含めません。`_site/` とローカル出力の `output/` はGit管理対象から除外します。Public Repositoryにコミットしたファイルは、GitHub上では閲覧可能です。

出力先に一覧外のファイルやリンクがあれば生成を止めます。自動で削除して続行せず、内容を確認します。HTMLとMarkdownの相対リンクは、Repository名を含む `/mimic/` 配下でも同じ資料へ届く構成です。

初回の公開では、確認済みの成果を最新の `main` に追加し、GitHubのSettings → Pages → SourceをGitHub Actionsに設定します。`github-pages` 環境も `main` からの公開に限定します。[GitHub公式の設定手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

[公開処理](.github/workflows/pages.yml)は標準の `ubuntu-latest` 上で同じNix環境に入り、固定した依存の導入、生成、型検査、鮮度確認とテストを行い、成功した `_site/` だけを配信します。`main` へのpushのみをきっかけに再公開します。PRでは[検査処理](.github/workflows/ci.yml)が同じ生成と検査を行います。**有効化後、`main` への反映は公開操作になります。** 公開・送信前に許可を確認し、既に明示的な許可がある範囲では再確認せず進めます。

ローカル検査は、配信対象・内容・リンクと更新手順の整合性を確認するものです。Bun・TypeScript・Nixの構成はApple SiliconのmacOSで、依存未導入の一時フォルダーから生成と全検査まで確認しています。Linuxでの生成・検査はPRの自動処理で、公開はmainの自動処理で確かめます。iPhone／iPadの実機での閲覧と操作は、ローカル検査だけでは判断できません。見た目の記録にはHTMLのフルページ画像を使い、PDFは採用しません。

## 人が確認すること

新しい知見について、AIは根拠・適用条件・限界を添えた更新案を作ります。既存知識で説明できるか、共通知識にできるかを確かめ、採用を確認してから正本へ反映します。正本の変更時には、この説明と表の参照ID・版・状態も見直します。

## 開発支援

[Moletta](.agents/skills/moletta/SKILL.md) は、このRepositoryを調査・変更・確認するための作業支援です。UI知識の正本は `knowledge/` に置きます。

## ライセンス

このRepositoryは[MITライセンス](LICENSE)で提供します。参照先の資料と依存ライブラリには、それぞれの権利・ライセンス条件が適用されます。
