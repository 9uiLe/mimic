# インタラクションデザインの出典

2026年10月22日に以下の箇所を確認しました。Apple HIGは公式ページが案内するMarkdown本文でも確認しています。

| 出典URL | 実読した節・箇所 | 本文で支える主張 | 対象範囲・注意 |
| --- | --- | --- | --- |
| [Apple — Explore navigation design for iOS](https://developer.apple.com/videos/play/wwdc2022/10001/) | 公開TranscriptのTab bars、hierarchical navigation、modal presentationsを説明する部分。特にタブ間の文脈保持、タイトル・back label、階層を進む遷移と独立作業の区別。 | 内容の階層と作業に合う遷移、現在地・戻る先、タブを切り替えた際の文脈。 | WWDC22のiOS向け解説。全プラットフォーム共通の遷移方法や、あらゆる中断後の自動復元を要求する資料ではない。 |
| [Apple HIG — Modality](https://developer.apple.com/design/human-interface-guidelines/modality) | 定義 / Discussion / Best practices。公式[Markdown本文](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/modality.md)。 | 親の操作を止めるモード、作業への集中、明確な閉じ方、閉じる際のデータ損失への対処。 | Appleの設計指針。モーダル表示の利点と負担を扱い、すべての作業をモーダルにするものではない。 |
| [Apple HIG — Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | 定義 / Discussion / Best practices。公式[Markdown本文](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/feedback.md)。 | 現在の状態・成否・訂正方法を伝えること、情報の重要さと中断の強さ、アクセシブルな複数の伝達方法。 | Appleの設計指針。本文ではwatchOS固有の進捗表示の指針を他のプラットフォームへ一般化しない。 |
| [Apple HIG — Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy) | Best practices / Requesting permission。公式[Markdown本文](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/privacy.md)。 | 必要なデータだけを求めること、用途の透明性、権限を必要とする機能を使う文脈での要求。 | Appleのプラットフォームにおける指針。本文は権限要求が行為に関係することを説明し、法的な同意要件や個別の実装仕様を導かない。 |
| [W3C — WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Abstract / SC 3.3.1 Error Identification / SC 4.1.3 Status Messages / §5.2・§5.3。 | 自動検出した入力エラーを対象とともにテキストで示すこと、ステータスメッセージを支援技術へ伝えられること、Webの適合範囲。 | Webコンテンツの基準。4.1.3はマークアップ言語で実装された内容を扱い、フォーカスを移さずに支援技術が提示できることを求める。本資料からネイティブアプリの適合は主張しない。 |

利用者の行為とシステムの応答という本文の射程は、これらの設計指針を読むために設定しています。
空・処理中・完了・失敗の表、保存ボタンの例、戻る・取り消す・保存して閉じるの読み分けはMimicの説明用の整理です。
AppleやW3Cが定義した共通の四状態分類や、状態機械を必須とする要件ではありません。
中断後に何を保存・再開できるか、権限がない場合にどの機能を残すかなどは、個別製品の判断として残ります。

[本文に戻る](../KNOWLEDGE.md)
