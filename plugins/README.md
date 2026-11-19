# Claude CodeとCodexからMimicを使う

どちらのPluginも、呼び出すたびに[GitHub上の共通手順](https://raw.githubusercontent.com/9uiLe/mimic/refs/heads/main/agent/README.md)を読みます。共通手順・索引・知識はMimicの `main` から取得します。読み取りに使えるWeb、GitHubまたはシェルの接続が必要です。Pluginの同梱ファイルは呼び出し口なので、知識の更新を取り込むための再インストールは不要です。Pluginを使わない場合は、共通手順のURLと対象のUIをAIに渡します。

## Claude Code

Claude Codeのセッションで次のコマンドを実行します。

```text
/plugin marketplace add 9uiLe/mimic
/plugin install mimic@mimic-marketplace
/reload-plugins
```

対象のプロジェクトで、たとえば `/mimic:mimic-ui 設定画面で保存できたか分かりづらい` と入力します。Plugin自体の更新を自動化したい場合は、`/plugin` のMarketplacesで `mimic-marketplace` の自動更新を有効にできます。[Claude Code公式ガイド](https://code.claude.com/docs/en/discover-plugins)

## Codex

Plugin対応版のCodex CLIで、マーケットプレイスを登録してインストールします。

```sh
codex plugin marketplace add 9uiLe/mimic
codex plugin add mimic@mimic-marketplace
```

対象のプロジェクトでCodexを開き、たとえば `$mimic-ui 設定画面で保存できたか分かりづらい` と入力します。候補が表示される環境では一覧からMimicのスキルを選べます。CodexデスクトップのPluginsから使う場合は、Mimicマーケットプレイスを選び、Mimicをインストールします。配布元の更新は `codex plugin marketplace upgrade mimic-marketplace` で行えます。[CodexのPlugin配布ガイド](https://developers.openai.com/codex/plugins/build/)・[CLIリファレンス](https://developers.openai.com/codex/cli/reference/#codex-plugin)

## 参照の確認

[保存の作例](../agent/saving-example.md)に近い相談で呼び出し、索引を経てシステム状態とエラー回復の本文・版・出典を読めるかを確認します。参照先が更新されたら、新しい相談で同じPluginを呼び出し、更新後の版を読み取れるかを見ます。呼び出し時のネットワーク制限や読取権限は各環境に従います。
