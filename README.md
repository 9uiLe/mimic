# Mimic

方針の見直しに伴い、リポジトリを再構成しています。新しい仕様と実装は、これから定義します。

残しているのは、Moletta 一式、`README.md`、`.gitignore` です。

## Moletta

AI に作業を依頼するときに `moletta` を指定してください。目的と必須制約から必要な能力を確かめ、方式の検討と実物の確認を進めます。成功条件が明確な小変更は、変更と相応の確認で完了できます。

| スキル                                                     | 用途                           |
| ---------------------------------------------------------- | ------------------------------ |
| [moletta](.agents/skills/moletta/SKILL.md)                 | 目的の確認と、必要な作業の選択 |
| [moletta-explore](.agents/skills/moletta-explore/SKILL.md) | 必要な能力と実現方法の調査     |
| [moletta-compare](.agents/skills/moletta-compare/SKILL.md) | 全体案の比較と採否の判断       |
| [moletta-verify](.agents/skills/moletta-verify/SKILL.md)   | 実物の結果と目的の照合         |
| [moletta-learn](.agents/skills/moletta-learn/SKILL.md)     | 実際の失敗に基づく手順の改善   |

スキル本体、参照資料、実行スクリプトを `.agents/skills/` に保存しています。

構造化記録を扱うスクリプトは Python 3.11 以上と POSIX 環境で使用します。コマンドの一覧は次で確認できます。

```sh
python3 .agents/skills/moletta/scripts/moletta.py --help
```

必要な場合だけ、[実行と再開の手順](.agents/skills/moletta/references/workflow.md)に従って記録を作成してください。記録は worktree ごとの `.moletta-runs/` に保存され、Git の管理対象から除外されます。
