export type TrialReviewAvailability =
  "available" | "unavailable" | "not-selected";

export type TrialReviews = {
  current: TrialReviewAvailability;
  stopped: TrialReviewAvailability;
  replay: TrialReviewAvailability;
};

export const trialReviewStyle = `.trial-review{background:#fff;border:1px solid #cadbd3;border-radius:12px;padding:16px 20px;margin:22px 0}.trial-review p{margin:6px 0}.trial-review ul{margin:8px 0 0;padding-left:21px}.trial-review li{margin:5px 0}.trial-review a{font-weight:750}`;

/** The operator selects fixed snapshots; this UI never infers generation or adoption. */
export function trialReviewNotice(reviews: TrialReviews): string {
  if (
    reviews.current === "not-selected" &&
    reviews.stopped === "not-selected" &&
    reviews.replay === "not-selected"
  )
    return "";
  const current =
    reviews.current === "available"
      ? '<li><a href="/trial-review/current">選択した実 Run の保存済みレビューを開く →</a></li>'
      : reviews.current === "unavailable"
        ? "<li>選択した実 Run のレビューを安全に読み込めません。</li>"
        : "";
  const stopped =
    reviews.stopped === "available"
      ? '<li><a href="/trial-review/stopped">停止した試行の保存済みレビューを開く →</a></li>'
      : reviews.stopped === "unavailable"
        ? "<li>停止した試行のレビューを安全に読み込めません。</li>"
        : "";
  const replay =
    reviews.replay === "available"
      ? '<li><a href="/trial-review/replay">過去成果物の再生レビューを開く →</a></li>'
      : reviews.replay === "unavailable"
        ? "<li>過去成果物の再生レビューを安全に読み込めません。</li>"
        : "";
  return `<aside class="trial-review" aria-label="デザイン試行のレビュー"><strong>9UI-197 · 保存済みの試行レビュー</strong><p>停止状態は新しい候補の生成成功を示しません。過去成果物の再生も新規生成ではありません。生成・検査と人間の選択・採用はレビュー本文で別々に確認してください。</p><p>起動時に選択した静的記録です。Run が進んでも自動更新されません。</p><ul>${current}${stopped}${replay}</ul></aside>`;
}
