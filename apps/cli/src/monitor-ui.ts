import { randomBytes } from "node:crypto";

export const monitorScript = String.raw`
const labels = {
  active:'進行可能', 'review-ready':'レビュー待ち', blocked:'停止・ブロック', closed:'Run 終了',
  ready:'準備済み', stopped:'停止中', complete:'セッション完了',
  executing:'実行予約あり', prepared:'提出準備済み', accepted:'提出済み', recorded:'保存状態のみ', runnable:'実行可能', 'multiple-sessions':'複数の保存状態',
  quota:'quota 停止', authentication:'認証待ち', 'billing-unconfirmed':'課金条件未確認', unsupported:'未対応条件', cancelled:'キャンセル', timeout:'タイムアウト',
  'unknown-outcome':'結果不明・要照合', question:'回答待ち', approval:'人の承認待ち', waiting:'待機', 'reservation-invalid':'保存条件が変更', 'iteration-limit':'生成上限',
  system:'システム', product:'プロダクト', experience:'体験', design:'デザイン', validation:'検証', review:'レビュー', unknown:'段階未確認',
  dispatch:'dispatch', authorization:'認可確認', 'permit-validation':'認可条件確認', 'runtime-metadata':'CLI 確認', 'generation-profile':'実行条件確認', 'safety-metadata':'安全条件確認', 'native-instructions':'入力準備', 'generation-launch':'起動', generation:'生成処理'
};
const text = (value) => labels[value] || value;
const add = (parent, tag, value) => { const el=document.createElement(tag); el.textContent=value; parent.append(el); return el; };
const refText = (ref) => ref.artifactId+'@'+ref.revision+' #'+ref.lockDigest;
let busy=false, lastSnapshot='', initialRunShown=false;
const openRunIds=new Set();
const search=document.getElementById('run-search');
function applyFilter() {
  const query=search.value.trim().toLocaleLowerCase();
  let shown=0;
  for(const card of document.querySelectorAll('#runs [data-run-id]')) {
    card.hidden=!!query && !card.dataset.search.includes(query);
    if(!card.hidden) shown++;
  }
  document.getElementById('run-count').textContent=shown+' 件を表示';
}
search.addEventListener('input',applyFilter);
async function poll() {
  if(busy) return;
  busy=true;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),1500);
  const connection=document.getElementById('connection');
  try {
    const response=await fetch('/api/state',{cache:'no-store',signal:controller.signal});
    if(!response.ok) throw new Error('unavailable');
    const state=await response.json();
    connection.textContent='接続中 · '+new Date(state.observedAt).toLocaleTimeString()+' 確認 · 2 秒間隔';
    connection.dataset.state='connected';
    document.getElementById('runs').dataset.stale='false';
    document.getElementById('summary').textContent=state.runs.length+' Runs / '+state.counts.artifacts+' 成果物 / '+state.counts.sessions+' セッション';
    const snapshot=JSON.stringify([state.runs,state.preview]);
    if(snapshot!==lastSnapshot) {
      lastSnapshot=snapshot;
      const runs=document.getElementById('runs'); runs.replaceChildren();
      if(!state.runs.length) add(runs,'p','保存された Run はありません。');
      if(!initialRunShown && state.runs.length) { openRunIds.add(state.runs[0].runId); initialRunShown=true; }
      for(const run of state.runs) {
      const card=document.createElement('details'); card.className='card'; card.dataset.runId=run.runId;
      card.dataset.search=[run.runId,...run.tasks.map(task=>task.taskId),...run.artifacts.map(artifact=>artifact.ref.artifactId)].join(' ').toLocaleLowerCase();
      card.open=openRunIds.has(run.runId);
      card.addEventListener('toggle',()=>{ if(card.open) openRunIds.add(run.runId); else openRunIds.delete(run.runId); });
      runs.append(card);
      const heading=document.createElement('summary'); card.append(heading);
      add(heading,'strong',run.runId); add(heading,'span',text(run.state)+' · '+run.artifacts.length+' 成果物 · '+run.sessions.length+' セッション');
      add(card,'p','Core の保存状態: '+text(run.state)+' · safe work '+run.safeWorkCount+' · blockers '+run.blockerCount+' · proposals '+run.proposalCount);
      if(!run.tasks.length) add(card,'p','保存された task plan / セッション task はありません。');
      const table=document.createElement('table'); card.append(table);
      const head=document.createElement('tr'); table.append(head); for(const label of ['Task ID','段階 / 出力型','保存された状態']) add(head,'th',label);
      for(const task of run.tasks) { const row=document.createElement('tr'); table.append(row); add(row,'td',task.taskId); add(row,'td',text(task.stage)+' / '+task.outputType); add(row,'td',text(task.phase)); }
      const stages=Object.entries(run.stageCounts).map(([stage,count])=>text(stage)+': '+count).join(' / ');
      if(stages) add(card,'p','Task 数（完了率ではありません）: '+stages);
      for(const session of run.sessions) {
        const block=document.createElement('div'); block.className='session'; card.append(block);
        add(block,'h3',session.sessionId+' · '+text(session.status)+(session.stop?' · '+text(session.stop):''));
        for(const task of session.tasks) add(block,'p',task.taskId+' · '+(session.status==='stopped'?text(session.stop || 'stopped')+'（task 保存 phase: '+text(task.phase)+'）':text(task.phase))+(task.stage?' · 最終観測: '+text(task.stage):''));
      }
      add(card,'h3','成果物の exact refs');
      if(!run.artifacts.length) add(card,'p','この Run の成果物 ref はまだありません。');
      for(const artifact of run.artifacts) add(card,'p',artifact.type+' · '+refText(artifact.ref)).className='ref';
      }
      applyFilter();
    }
    const link=document.getElementById('product-preview-link');
    link.hidden=state.preview.state!=='available';
    document.getElementById('preview-state').textContent=state.preview.state==='available'?'選択済みの既存 synthetic prototype。上の Run から生成された成果物とは限りません。バックエンド・保存・承認の証明ではありません。':state.preview.state==='not-selected'?'Preview は未選択です。起動時に既存 bundle を --preview で指定できます。':'選択した preview を安全に読み込めません。';
  } catch {
    connection.textContent='切断・取得不可 · 表示が残っている場合は前回の保存状態です。';
    connection.dataset.state='disconnected';
    document.getElementById('runs').dataset.stale='true';
  } finally { clearTimeout(timeout); busy=false; }
}
poll(); setInterval(poll,2000);
`;

const style = `body{margin:0;background:#f2f5f7;color:#172b3e;font:16px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 20px}h1{font-size:30px}h2{font-size:20px}h3{font-size:16px}h2,h3{overflow-wrap:anywhere}.card,.preview{background:white;border:1px solid #d6e0e5;border-radius:12px;padding:22px;margin:16px 0;box-shadow:0 3px 18px #18304308}#connection{font-weight:650;color:#155b42}#connection[data-state=disconnected]{color:#9b3425}[data-stale=true]{opacity:.65}[hidden]{display:none!important}.run-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:26px 0 8px}.run-tools input{font:inherit;padding:10px 12px;border:1px solid #98aab7;border-radius:8px;min-width:min(100%,340px)}.run-tools input:focus-visible,summary:focus-visible{outline:3px solid #397ecb;outline-offset:3px}.card summary{cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;overflow-wrap:anywhere}.card summary span{font-size:14px;color:#486074}.card[open] summary{padding-bottom:16px;border-bottom:1px solid #d6e0e5}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e6ebf3;padding:10px;overflow-wrap:anywhere}.ref{font:13px/1.7 ui-monospace,monospace;overflow-wrap:anywhere}.session{border-left:3px solid #abc2e2;padding-left:16px}a{color:#1659a5}iframe{width:100%;height:78vh;border:1px solid #dce4ef;background:white}@media(max-width:650px){main{padding:16px 10px}.card summary{display:block}.card summary span{display:block}th,td{padding:7px;font-size:13px}}`;
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export function monitorPage(): { html: string; csp: string } {
  const nonce = randomBytes(24).toString("base64");
  return {
    csp: `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic workspace monitor</title><style nonce="${nonce}">${style}</style><script src="/monitor.js" defer></script></head><body><main><h1>Mimic workspace monitor</h1><p>保存された Run を探して内容を確認できます。生成・承認・再開の操作はありません。保存状態は承認や backend 接続の証明ではありません。</p><p id="connection" data-testid="connection-status" role="status" aria-live="polite">接続確認中</p><p id="summary"></p><p>段階: システム → プロダクト → 体験 → デザイン → 検証 / レビュー。出力型に基づく分類で、段階の完了を示しません。</p><section class="preview"><h2>別途選択した既存プロダクト preview</h2><p id="preview-state">確認中</p><a id="product-preview-link" href="/preview" target="_blank" rel="noopener noreferrer" hidden>隔離した新しいタブで操作する</a></section><div class="run-tools"><label for="run-search">Run・Task・成果物 ID で探す</label><input id="run-search" type="search" autocomplete="off" placeholder="例: s10 / run_mimic" aria-controls="runs"><span id="run-count" role="status"></span></div><div id="runs"></div></main></body></html>`,
  };
}
export function previewPage(bundle: {
  html: string;
  css: string;
  js: string;
}): { html: string; csp: string } {
  const nonce = randomBytes(24).toString("base64");
  const childPolicy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src data:; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  // The second policy permits inline code only, preventing scripts/styles with
  // copied nonces from loading remote resources. Policies intersect.
  const policies = `<meta http-equiv="Content-Security-Policy" content="${childPolicy}"><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; style-src 'unsafe-inline'">`;
  const srcdoc = bundle.html
    .replace(/<head>/i, () => `<head>${policies}`)
    .replace(
      /<link rel="stylesheet" href="prototype\.css"\s*\/?\s*>/,
      () =>
        `<style nonce="${nonce}">${bundle.css.replace(/<\/style/gi, "<\\/style")}</style>`,
    )
    .replace(
      '<script type="module" src="prototype.js"></script>',
      () =>
        `<script type="module" nonce="${nonce}">${bundle.js.replace(/<\/script/gi, "<\\/script")}</script>`,
    );
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic isolated product preview</title><style nonce="${nonce}">${style}</style></head><body><main><h1>既存 synthetic product preview</h1><p>別途選択された保存済み prototype です。Monitor の Run 出力・実 backend・データ保存・承認の証明ではありません。操作はこの隔離 frame 内に限定されます。</p><iframe title="Product preview" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(srcdoc)}"></iframe></main></body></html>`,
  };
}
