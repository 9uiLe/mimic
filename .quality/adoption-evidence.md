# 品質検査の導入確認

この記録は2026-10-22のローカル導入時の結果です。現在の実行手順・判定条件は [品質検査ガイド](../guideline/quality-checks.md)、数値・例外の正本は [policy.json](policy.json) を参照します。

## 目的と完了条件

変更したコードと根拠を対応付け、客観的な条件を共通検査にし、実装・テスト・検査条件の変更を別途レビューできるようにしました。機械検査の合格から、知識本文や業務仕様の正しさを推定しません。

ローカルで全対象を検査し、ステージ済みの版だけを使うhookを実際に設置・起動することを完了条件としました。公開・push・PR・リモート設定変更は実施していません。

## 導入前の確定版

- 固定コミット：`85f3962e0c17680782574403785121a4b2f194f6`。
- 作業開始時の未コミット変更：なし。
- 既存環境：Bun 1.4.2、TypeScript 7.0.2、既存Nix環境・verify・Pages workflowを使用。
- 導入前の `nix develop path:. --command bun run verify`：成功。型検査・生成物2組の鮮度・既存16テストが成功し、導入前から失敗する検査は見つかりませんでした。
- 有効な既存pre-commit：なし。Gitが示した実配置先にsampleだけがありました。
- 固定版から計測した旧違反：800行超0ファイル、200文字超15行、限定禁止識別子1件。場所・計測値・原文は [baseline.json](baseline.json) に保持しています。

## 変更と根拠

- `scripts/quality/`：共通判定、固定基準、根拠対応、Git snapshot、hook導入、CI比較、故障検出の入口。
- `.quality/`：利用者指定の条件、固定版の旧違反、変更と根拠・検証方法の対応、代表処理の具体的な期待値。
- `.githooks/pre-commit`：検査専用。整形・stage・stash・reset・依存導入をしません。
- `.github/workflows/quality.yml`：PRの確定head/base SHAから全体検査とテストを実行する設定。取り込み先の入口と検査器を優先します。
- `flake.nix`・`package.json`：既存のセットアップへPythonと共通コマンドを追加。
- `scripts/knowledge-paths.ts`：既存の相対リンク処理を独立させ、文書の規則を具体的なテストで検証。
- `tests/knowledge-output.test.ts`：関数分割で増えた依存ファイルも隔離fixtureへコピー。既存assertionを維持し、分割モジュールの変更でも鮮度検査が失敗する条件を追加。
- 生成HTML2件：分割したモジュールも含めた生成器ハッシュへ更新。知識本文や表示内容の変更ではありません。
- `AGENTS.md`・開発ガイド：コマンドと定義への案内を追加。READMEに変更履歴は追加していません。

導入中、一時的に既存テスト1件が依存ファイル不足で失敗しました。これは今回の分割による失敗であり、導入前の失敗ではありません。fixtureを修正し、期待値やassertionを弱めず再検証しました。

## 実行した検査

| コマンド・対象 | 期待した結果 | 実際の結果 |
| --- | --- | --- |
| `bun run quality:check`：全対象 | 旧違反の維持を許し、新規・悪化・根拠不足を拒否 | 41ファイル、違反なし |
| `bun run quality:test`：検査器・hook・CIの検証用repo | 正常を通し、違反と検査不能を拒否 | 62テスト成功 |
| `bun run test:effectiveness --case knowledge-relative-link` | 固定テストで正常成功→意味のある誤実装失敗→復元成功 | 0→1→0、同一test SHA |
| `bun run verify` | 型・生成物鮮度・既存テストを維持 | 17テストと型・鮮度検査が成功 |
| `bun run build:pages` | 許可済みの配信用ファイルだけをローカル生成 | 28ファイルの組み立て成功 |
| `bun run setup:hooks` と実hook起動 | このrepoで有効化し、通常index・作業ファイルを保持 | 設置成功、別indexでexit 0、前後のバイト列一致 |
| `python3 scripts/quality/ci_check.py --repository <一時repo> --base 85f3962… --commit <候補SHA>` | 全候補を確定コミットとして検査 | 全95ファイルを一時repoへ登録し、全41コード対象が成功 |
| `git diff --check` | 空白の差分エラーなし | 成功 |

境界は800/801行、200/201コードポイント、Unicode・CRLFを確認しました。旧違反の維持・縮小・悪化・縮小後の再悪化、移動・連続改名、コピーによる例外増殖、未知形式の対象漏れ、同名同数の別宣言への置換を確認しています。

850行の既存ファイルを使った実コミットでは、840行へ縮めても基準未更新なら拒否、`quality:ratchet`で上限840を保存・stageすると成功、845行への再増加は拒否しました。初期記録850は維持しています。

## indexとコミットの確認

専用の検証用repoで、実際のhookとGit commitを使用しました。

- indexが201文字違反・作業ファイルだけ修正済み：拒否。
- indexが適合・未ステージ部分だけ違反：成功。
- 部分stageでも全文の行数を判定。未stageの設定・hook・checker修正では判定が変わらないことを確認。
- 初回commit、追加・削除・改名・コピー・種別変更、空白・日本語・改行を含むパス、別indexを確認。
- 設定変更や、検査設定を管理パス外へ改名した場合は全体再検査。競合、必要ファイルや依存の欠落、検査エラーは拒否。
- 成功・失敗・SIGINT中断の前後で、indexと作業ファイルの内容が一致。
- hookを迂回して違反をcommitし、作業ファイルだけ直してもCI相当の確定コミット検査は拒否。
- 候補のcheckerを成功終了だけに改変しても、取り込み先版の検査器が違反を拒否。候補自身が作った旧違反免除や閾値緩和も拒否。

実repoには `/Users/t.kobayashi/orca/mimic/.git/hooks/pre-commit` を設置しました。全候補を一時的な別indexへ登録して起動し、exit 0、約5秒でした。通常index・別index・非ignoreの作業ファイルの内容は前後で一致し、通常indexには変更をstageしていません。Gitのグローバル設定は変更していません。

同じGit共通ディレクトリを使う他のworktreeにもこのhookが及びます。導入ファイルがindexにない古いブランチでは検査不能として拒否します。

## 期待値の根拠と故障検出は別の確認

根拠：`guideline/development.md` の「生成の規則」に、相対リンクが出力先から同じ参照先へ到達する規則があります。入力 `/repo/prototypes/decision-material-selection` と `/repo/knowledge/grouping/KNOWLEDGE.md` に対し、期待値を `../../knowledge/grouping/KNOWLEDGE.md` と先に固定しました。実装から計算していません。

効き目：隔離コピーで相対パスの起点と参照先を逆にすると、同じテストの `generated knowledge link must preserve the documented concept destination` が失敗しました。誤出力は `../../../prototypes/decision-material-selection`。構文や読込エラーを検出の証拠には数えていません。復元後は同じテストで成功しました。

追加で、CIが取り込み先ではなく候補の検査器を選ぶ誤変更も隔離コピーで試しました。同じCIテストが `AssertionError: 0 != 1` で失敗し、復元後に成功しました。

実行ログはローカルの `output/quality/behavior-proof.json`、`ci-trust-proof.json`、`full-check.json`、`local-hook-proof.json`、`full-ci-proof.json` にあります。再実行コマンドは品質ガイドと各テストにあります。

## 保留・未確認

- 名前の意味、根拠の解釈、業務仕様、知識の採否、例外追加・検査コードや期待値の変更の妥当性は人のレビュー対象です。
- 代表の相対パス例はmacOS/Linuxを仮定しています。Windowsと知識本文の意味は検証していません。
- CI設定ファイルは完成しています。GitHub上では未実行で、必須チェック・Ruleset・CODEOWNERSなどの共有保護設定は未適用です。初回導入は取り込み先に検査器がないため、独立したレビューが必要です。
- `main`に対し `Repository Quality / repository-quality` を必須化し、検査条件・workflow変更の独立レビューを要求する設定案があります。権限・契約上の可否と担当者は未確認です。
- push・PR作成・共有設定への反映は未実施です。CIファイル作成だけで違反の取り込みを防げる状態になったとは判断していません。
