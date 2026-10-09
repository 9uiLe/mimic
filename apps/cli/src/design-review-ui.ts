import { randomBytes } from "node:crypto";

/** A fixed review snapshot from the accepted 9UI-178 S10/S11 Run. */
export function designReviewPage(): { html: string; csp: string } {
  const nonce = randomBytes(24).toString("base64");
  const style = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f2;color:#18352f;font:15px/1.55 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:32px 24px 70px}h1{font-size:clamp(27px,3.5vw,42px);line-height:1.18;margin:8px 0 12px}h2{font-size:21px;line-height:1.3}h3{font-size:17px;margin:0 0 12px}p{margin:9px 0}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:#397469}.intro{max-width:79ch;color:#445e56}.hero{border-bottom:1px solid #cfdbd2;padding-bottom:20px}.hero a,.link{color:#075c4b;font-weight:700}.status{display:flex;gap:12px;flex-wrap:wrap;margin:19px 0}.badge{display:inline-block;border-radius:99px;padding:5px 11px;background:#e2eee6;color:#185c49;font-size:12px;font-weight:750}.badge.muted{background:#e8ebe8;color:#506058}.recommendation{background:#173d34;color:#fff;padding:23px 27px;border-radius:17px;margin:25px 0;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr);gap:25px}.recommendation h2{margin:3px 0}.recommendation p{color:#e1eee8}.recommendation .badge{background:#d4eddc}.recommendation strong{color:#fff}.recommendation .link{color:#d8f2df}.review-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:18px 0}.direction{background:#fff;border:1px solid #d6e0d8;border-radius:14px;padding:20px;min-width:0}.direction.chosen{border:2px solid #167657;padding:19px}.direction h3{margin:9px 0}.direction p{color:#455d54}.direction ul{padding-left:19px;margin:9px 0}.direction li{margin:5px 0}.direction .preview{background:#f2f6f3;border:1px solid #dce7de;border-radius:10px;padding:14px;min-height:245px;margin-top:16px}.mini-title{font-size:12px;font-weight:800;letter-spacing:.05em;color:#45635a;text-transform:uppercase}.mini-row{padding:7px 9px;border:1px solid #d4e0d8;border-radius:7px;background:white;margin:7px 0}.mini-row strong,.mini-row span{display:block}.mini-row span{font-size:12px;color:#587067}.mini-stack{border-left:3px solid #35866a;padding:3px 0 3px 12px;margin:9px 0}.mini-matrix{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.mini-matrix span{background:white;padding:8px 5px;text-align:center;border:1px solid #d6e5da;border-radius:5px;font-size:12px}.mini-matrix span:nth-child(2){border-color:#167657;background:#e6f3e8}.compare{background:#fff;border:1px solid #d6e0d8;border-radius:14px;padding:20px;margin:26px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #dfe8e1}th{font-size:13px;color:#395a4d}td:first-child{font-weight:750;width:155px}td strong{display:block;color:#173f31}.verdict{color:#607168;font-size:12px}.live{background:#edf3ee;border:1px solid #d6e0d8;border-radius:14px;padding:20px;margin:27px 0}.live select{font:inherit;max-width:100%;padding:8px 10px;border:1px solid #90aa99;border-radius:8px}.live-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:15px}.live-card{background:white;border-radius:10px;padding:15px}.live-card ol{padding-left:23px;margin:9px 0}.live-card li{margin:4px 0}.technical{margin-top:25px;border-top:1px solid #cfdbd2;padding-top:16px}.technical summary{cursor:pointer;font-weight:700}.technical p{overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace}.note{font-size:13px;color:#556c60}.callout{border-left:3px solid #b5862b;padding-left:12px;color:#554b30}a:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #1678a3;outline-offset:3px}@media(max-width:880px){.review-grid{grid-template-columns:1fr}.recommendation,.live-results{grid-template-columns:1fr}main{padding:20px 14px 50px}}`;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic · 3つの設計方向を比較</title><style nonce="${nonce}">${style}</style><script src="/design-review.js" defer></script></head><body><main>
<header class="hero"><p><a href="/">← Run モニターへ戻る</a></p><p class="eyebrow">固定ケーススタディ / 9UI-178 の実 Run</p><h1>設計案を比べ、選ぶ理由を確かめる</h1><p class="intro">9UI-178の同じ課題からMimicが3つの構造案を生成し、4つの共通基準で評価しました。この比較は現在表示中のworkspaceのRunとは独立した固定記録です。下の案は操作できる構造プレビューです。選定は暫定で、人間の採用判断や実利用の効果は記録していません。</p><div class="status"><span class="badge">S10: 3案を受理</span><span class="badge">S11: 共通基準で比較</span><span class="badge muted">採用判断: 未実施</span></div></header>
<section class="recommendation" aria-label="暫定推奨"><div><span class="badge">Mimic の暫定推奨</span><h2>Criteria Comparison Studio</h2><p>案の違い、共通基準、根拠、代案と不確実性を一つの判断面に置きます。Run調査は別の導線から開き、比較の主題を埋もれさせません。</p></div><div><strong>取り込む機構</strong><p>Resume Boardの「現在地・根拠・未解決・次の行動」を小さな再開コンテキストとして残します。情報密度と基準の妥当性は実利用で確認が必要です。</p><p><a id="review-preview-link" class="link" href="/preview" target="_blank" rel="noopener noreferrer" hidden>別途選択した既存プロダクトを新しいタブで操作 →</a></p></div></section>
<h2>3つの構造プレビュー</h2><p class="note">各案は同じ保存済みRun情報をどう配置するかの試案です。下のRun選択を変えると再開ボードと調査ビューの内容が更新されます。</p>
<div class="review-grid"><article class="direction"><span class="badge muted">代案</span><h3>Resume Board</h3><p>保存されたRunから作業を再開する構造。現在地、根拠、未解決、次の行動を一緒に置く。</p><ul><li>強み: 中断後の復帰</li><li>弱み: 案間の採否理由が隠れやすい</li></ul><div class="preview"><div class="mini-title">再開コンテキスト</div><div class="mini-row"><strong>現在地</strong><span id="resume-state">Run を読み込み中</span></div><div class="mini-row"><strong>根拠</strong><span id="resume-evidence">保存状態を確認中</span></div><div class="mini-row"><strong>次の行動</strong><span id="resume-next">確認中</span></div></div></article>
<article class="direction chosen"><span class="badge">暫定推奨</span><h3>Criteria Comparison Studio</h3><p>設計案を同じ基準で並べ、推奨と代案の理由を同じ画面で確かめる。</p><ul><li>強み: 選択の根拠が見える</li><li>弱み: Run調査への移動が必要</li></ul><div class="preview"><div class="mini-title">共通基準を横断</div><div class="mini-matrix"><span>再開</span><span>比較</span><span>調査</span><span>現在地</span><span>根拠</span><span>履歴</span><span>次の行動</span><span>代案</span><span>診断</span></div><div class="mini-row"><strong>暫定推奨: 比較</strong><span>判断情報を一覧化。利用効果は未検証。</span></div></div></article>
<article class="direction"><span class="badge muted">調査向け</span><h3>Run Timeline</h3><p>時系列でRunを調べる構造。タスク・セッション・成果物の診断に向く。</p><ul><li>強み: 失敗や保存状態を追える</li><li>弱み: 案間比較は埋もれやすい</li></ul><div class="preview"><div class="mini-title">調査の流れ（概念図）</div><div id="timeline-steps"><div class="mini-stack">Run を読み込み中</div></div><p class="note">現在のAPIはイベント時刻を公開しません。表示順は実際の時系列を示しません。</p></div></article></div>
<section class="compare"><h2>同じ4基準で比較した結果</h2><div class="scroll"><table><thead><tr><th>基準</th><th>Resume Board</th><th>Criteria Comparison Studio</th><th>Run Timeline</th></tr></thead><tbody>
<tr><td>判断に必要な可視情報</td><td><strong>満たす</strong>現在地、根拠、未解決、次の行動をまとめる。</td><td><strong>満たす</strong>共通基準と推奨・代案・不確実性を示す。</td><td><strong>懸念</strong>復帰情報はあるが、案間比較の根拠が見えにくい。</td></tr>
<tr><td>隠れた決定情報</td><td><strong>大きな懸念</strong>記録詳細は開けるが、推奨理由の見せ方が未定。</td><td><strong>懸念</strong>Runの詳しい根拠は別の調査画面にある。</td><td><strong>満たす</strong>Task、セッション、exact ref、ログへ辿れる。</td></tr>
<tr><td>不要なノイズ</td><td><strong>抑える</strong>詳細を必要時に開き、再開の文脈を保つ。</td><td><strong>懸念</strong>比較画面とRun調査で注意が分散しうる。</td><td><strong>懸念</strong>イベント列が次の設計判断を埋もれさせうる。</td></tr>
<tr><td>次の行動</td><td><strong>明確</strong>Runの現在地のそばに置く。</td><td><strong>明確</strong>案全体へ戻り、別のRun調査へ進める。</td><td><strong>明確</strong>調査の上に次の行動を固定する。</td></tr>
</tbody></table></div><p class="note">「満たす」は構造上の推論です。利用者による選択の速さ・理解度・満足度は測っていません。</p></section>
<section class="live"><h2>保存済みRunで構造を試す</h2><p>現在のworkspaceで表示するRunを変えると、再開ボードと調査ビューの概念プレビューが更新されます。固定の9UI-178比較結果は変わりません。ここでの操作は保存や承認を行いません。</p><label for="review-run">Runを選ぶ</label> <select id="review-run"><option>読み込み中</option></select><p id="review-connection" class="note" role="status">接続確認中</p><div class="live-results"><div class="live-card"><h3>再開ボードなら</h3><p id="review-resume">読み込み中</p></div><div class="live-card"><h3>調査ビューなら</h3><ol id="review-tasks"></ol></div></div><p class="callout">このAPIは保存状態とTask順を返します。タイムライン案が要するイベント時刻や、プレビューとRunの生成関係は示しません。</p></section>
<details class="technical"><summary>Mimicの受理結果と根拠を確認</summary><p>Run: run_mimic_monitor_cycle2_v2_20261009</p><p>S09 reference-selection: art_run_mimic_monitor_cycle2_v2_20261009_s09_reference_selection@1 / sha256:5968be4736d294f953e2005926b4889dace3d50e6e57fbf96db265f5750d749e</p><p>S10: art_run_mimic_monitor_cycle2_v2_20261009_s10_direction_resume_board@1 / sha256:1037bf9bd1c7c4d26d5d78769f9148c71a342ca43415435a45a6290a6f697ab5<br>art_run_mimic_monitor_cycle2_v2_20261009_s10_direction_compare_studio@1 / sha256:b82b14bed9f1e25ffaa3507f140aed3bef25c6d0e99293a71aac899ada39c915<br>art_run_mimic_monitor_cycle2_v2_20261009_s10_direction_run_timeline@1 / sha256:204865341c795150928b464c8960be62f2e62414639e9b7e4661c048605350e8</p><p>S11 proposed decision: art_run_mimic_monitor_cycle2_v2_20261009_s11_decision_direction_review@1 / sha256:a476c96a3146f60f390567a916e6b9bdeca471ce3617229171fe6cede8c81ede</p><p>静的CLIは型・exact input・由来と受理状態を検証しました。推奨はモデルの判断で、人間の採用ではありません。</p></details></main></body></html>`;
  return {
    csp: `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html,
  };
}

export const designReviewScript = String.raw`
const select=document.getElementById('review-run');
let selected='', last='', busy=false;
const label=run=>run.runId.replace(/^run_/,'').replaceAll('_',' ');
const phase=run=>run.tasks.find(task=>!['accepted','recorded'].includes(task.phase)) || run.tasks.at(-1);
const next=run=>run.state==='blocked'?'停止理由と未解決を確認':run.state==='review-ready'?'候補の根拠を確認':run.state==='active'?'次のTaskを確認':'成果物と比較結果を確認';
function render(state){
  document.getElementById('review-preview-link').hidden=state.preview.state!=='available';
  const choices=state.runs;
  if(!choices.some(run=>run.runId===selected))selected=choices[0]?.runId||'';
  const key=JSON.stringify([choices,selected]);if(key===last)return;last=key;
  select.replaceChildren();
  for(const run of choices){const option=document.createElement('option');option.value=run.runId;option.textContent=label(run);select.append(option)}
  select.value=selected;
  const run=choices.find(item=>item.runId===selected);
  if(!run){
    const option=document.createElement('option');option.textContent='保存された Run はありません';select.append(option);select.disabled=true;
    document.getElementById('resume-state').textContent='現在のworkspaceにRunはありません';
    document.getElementById('resume-evidence').textContent='成果物なし';
    document.getElementById('resume-next').textContent='Runを作成するとここで確認できます';
    document.getElementById('review-resume').textContent='現在のworkspaceにRunはありません。上の9UI-178比較は固定記録です。';
    document.getElementById('timeline-steps').replaceChildren();
    document.getElementById('review-tasks').replaceChildren();
    return;
  }
  select.disabled=false;
  const task=phase(run);
  document.getElementById('resume-state').textContent=run.state+' · '+(task?.taskId||'Taskなし');
  document.getElementById('resume-evidence').textContent=run.artifacts.length+'件の成果物 · '+run.blockerCount+'件のblocker';
  document.getElementById('resume-next').textContent=next(run);
  document.getElementById('review-resume').textContent=label(run)+'。'+run.tasks.length+' Task、'+run.artifacts.length+' 成果物。'+next(run)+'。';
  const steps=document.getElementById('timeline-steps');steps.replaceChildren();
  const list=document.getElementById('review-tasks');list.replaceChildren();
  for(const item of run.tasks.slice(0,7)){
    const block=document.createElement('div');block.className='mini-stack';block.textContent=item.taskId+' · '+item.stage+' · '+item.phase;steps.append(block);
    const li=document.createElement('li');li.textContent=item.taskId+' · '+item.phase;list.append(li);
  }
}
select.addEventListener('change',()=>{selected=select.value;last='';if(window.latestDesignState)render(window.latestDesignState)});
async function poll(){if(busy)return;busy=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1500);try{const response=await fetch('/api/state',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();const state=await response.json();window.latestDesignState=state;render(state);document.getElementById('review-connection').textContent='保存状態を '+new Date(state.observedAt).toLocaleTimeString()+' に確認 · 2秒間隔';}catch{document.getElementById('review-connection').textContent='保存状態を取得できません。上の比較結果は受理済みRunの固定記録です。';}finally{clearTimeout(timer);busy=false}}
poll();setInterval(poll,2000);
`;
