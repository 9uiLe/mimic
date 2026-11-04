# Edge-to-Edgeの出典

2026-11-04に以下の公式資料の該当本文を確認しています。
AndroidとAppleの指針・APIの説明を対応させたもので、全プラットフォーム共通の規格ではありません。

| 本文の説明 | 出典と確認箇所 | 対象範囲と注意 |
| --- | --- | --- |
| システムバーの背後へ描く定義、背景・スクロール内容と文字・ボタンの扱い、切り欠き、バーの保護表現。 | [Android Developers「Edge-to-edge design」](https://developer.android.com/design/ui/mobile/guides/layout-and-content/edge-to-edge)の冒頭、Takeaways、Status bar considerations、Navigation bar considerations、Display cutouts、Other guidance。 | Androidの設計指針。背景を広げることと、操作部品を端へ寄せることを混同しない。3ボタンとジェスチャーで背景の扱いが違う。 |
| Insetsの意味、バー・ジェスチャー・切り欠き・IME、見た目とジェスチャーを保護する種類の違い。 | [Android Developers「About window insets」](https://developer.android.com/develop/ui/compose/system/insets)のInset fundamentals、各insetの表、safeDrawing・safeGestures・safeContentの説明。 | 表のAPI名はJetpack Compose。insetsは上下左右の量を持ち、ナビゲーション方式などによって実行時にも変わる。 |
| Viewsでのinsets、スクロール末尾への到達、没入モードとの区別、旧OSでの有効化。 | [Android Developers「Display content edge-to-edge in views」](https://developer.android.com/develop/ui/views/layout/edge-to-edge)のEnable edge-to-edge display、Handle overlaps using insets、Immersive mode、Make scrolling content edge-to-edge。 | Android Viewsの資料。RecyclerViewの例はinsetsと`clipToPadding="false"`を組み合わせる。全項目を常時枠内に置く規則ではない。 |
| Android 15の適用条件と、自動適用だけでは重なりを解消しないこと。 | [Android Developers「Behavior changes: Apps targeting Android 15 or higher」](https://developer.android.com/about/versions/15/behavior-changes-15)のWindow inset changes、Edge-to-edge enforcement。 | Android 15端末と対象API level 35という条件を保つ。システムバーの設定や非floatingウインドウの切り欠きに関する変更もある。 |
| Android 16での回避設定の無効化と、Android 15端末との違い。 | [Android Developers「Behavior changes: Apps targeting Android 16 or higher」](https://developer.android.com/about/versions/16/behavior-changes-16)のEdge to edge opt-out going away。 | 対象API level 36かつAndroid 16端末では回避不可。同じ対象SDKでもAndroid 15端末では回避設定が機能する。 |
| 背景を端まで広げる方針、表示条件への適応、Safe Areaとバーの関係。 | [Apple HIG「Layout」](https://developer.apple.com/design/human-interface-guidelines/layout)のVisual hierarchy、Adaptability、Guides and safe areas。 | 公式Markdown本文も確認。iPhoneを中心とする説明に必要な範囲を採用し、他のAppleプラットフォーム固有の数値は転用しない。 |
| ビューごとのSafe Area、コンテナ内のバーや独自ビューによる調整。 | [Apple「Positioning content relative to the safe area」](https://developer.apple.com/documentation/uikit/positioning-content-relative-to-the-safe-area)のDiscussion、Extend the safe area to include custom views。 | 公式Markdown本文で確認。UIKitの`safeAreaLayoutGuide`・`safeAreaInsets`とコンテナによる調整を説明する。 |
| 背景だけを広げることと、内容を含むビューでSafe Areaを無視することの違い。 | [Apple「Adding a background to your view」](https://developer.apple.com/documentation/swiftui/adding-a-background-to-your-view)のExtend the background into the safe areas、Adjust views when displaying the keyboard。 | SwiftUIの解説例。`ignoresSafeArea`の適用先によって、内容のキーボードへの追従も変わる。 |
| コンテナとキーボードの領域の区別。 | [Apple「SafeAreaRegions」](https://developer.apple.com/documentation/swiftui/safearearegions)のcontainer、keyboard。 | 公式Markdown本文で確認。SwiftUIの領域の定義であり、UIKitのSafe Area全体をキーボード回避の保証とは扱わない。 |

本文の章立て、背景写真と開始ボタンの作例、模式図を読む際の注意、既存知識との関係はMimicによる整理です。
調査のきっかけとなった提供画像は、公式仕様の根拠や実機検証の結果として扱っていません。
図の寸法や「安全な位置」という要約から、固定の余白値を導いていません。
読みやすさ・操作性・人による理解を測定した結果ではありません。

[本文に戻る](../KNOWLEDGE.md)
