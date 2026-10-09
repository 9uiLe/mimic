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
let busy=false;
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
    const runs=document.getElementById('runs'); runs.replaceChildren();
    if(!state.runs.length) add(runs,'p','保存された Run はありません。');
    for(const run of state.runs) {
      const card=document.createElement('section'); card.className='card'; card.dataset.runId=run.runId; runs.append(card);
      add(card,'h2',run.runId); add(card,'p','Core の保存状態: '+text(run.state)+' · safe work '+run.safeWorkCount+' · blockers '+run.blockerCount+' · proposals '+run.proposalCount);
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

const style = `body{margin:0;background:#f5f7fb;color:#18263c;font:16px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 20px}h1{font-size:30px}h2{font-size:20px}h3{font-size:16px}h2,h3{overflow-wrap:anywhere}.card,.preview{background:white;border:1px solid #dce4ef;border-radius:12px;padding:22px;margin:20px 0}#connection{font-weight:650;color:#155b42}#connection[data-state=disconnected]{color:#9b3425}[data-stale=true]{opacity:.65}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e6ebf3;padding:10px;overflow-wrap:anywhere}.ref{font:13px/1.7 ui-monospace,monospace;overflow-wrap:anywhere}.session{border-left:3px solid #abc2e2;padding-left:16px}a{color:#1659a5}iframe{width:100%;height:78vh;border:1px solid #dce4ef;background:white}@media(max-width:650px){main{padding:16px 10px}th,td{padding:7px;font-size:13px}}`;
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
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic workspace monitor</title><style nonce="${nonce}">${style}</style><script src="/monitor.js" defer></script></head><body><main><h1>Mimic workspace monitor</h1><p>選択した workspace の保存状態を読み取ります。生成・承認・再開の操作はありません。保存状態は承認や backend 接続の証明ではありません。</p><p id="connection" data-testid="connection-status" role="status" aria-live="polite">接続確認中</p><p id="summary"></p><p>段階: システム → プロダクト → 体験 → デザイン → 検証 / レビュー。出力型に基づく分類で、段階の完了を示しません。</p><section class="preview"><h2>別途選択した既存プロダクト preview</h2><p id="preview-state">確認中</p><a id="product-preview-link" href="/preview" target="_blank" rel="noopener noreferrer" hidden>隔離した新しいタブで操作する</a></section><div id="runs"></div></main></body></html>`,
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
