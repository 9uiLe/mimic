<!-- ai-knowledge:begin -->
変更の目的と確認結果を短く説明する。共有設定 example-v1
<!-- ai-knowledge:end -->

知識の検索・参照・説明では [知識の入口](knowledge/README.md) から必要な本文と補足を読む。Repositoryの内容・機能・運用を変更または点検するときは、作業前に [AI向けの作業ガイド](guideline/ai.md) と、そこから参照する [Repositoryの方針と利用ガイド](guideline/README.md) を読む。

設計に使う知識を選ぶときは、[設計判断に使う知識を選ぶ原則](guideline/README.md#設計判断に使う知識を選ぶ原則)から、いま決めたい問いに合う本文へ進む。

知識を説明するとき、読者が文をまたいで関係・配置・分岐・数量の傾向を組み立てる必要があれば、依頼に図の指定がなくても実際の図を回答に添える。[図を添える判断](guideline/README.md#説明に図を添える判断)に従う。

製品UIを設計するときは、配色の指定がなくても主要な操作や注目点を決め、案件のアクセントカラーを実際の画面に割り当てる。[UIの配色方針](guideline/README.md#uiの色を具体的に示すとき)に従う。

変更時は [品質検査の定義と根拠](guideline/quality-checks.md) を参照し、`bun run quality:check`・`bun run quality:test` を実行する。テスト変更は同ガイドの故障検出手順に従う。
