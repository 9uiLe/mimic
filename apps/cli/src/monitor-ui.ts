import { randomBytes } from "node:crypto";

export const monitorScript = String.raw`
const labels = {
  active:'進行可能', 'review-ready':'レビュー待ち', blocked:'停止・ブロック', closed:'Run 終了',
  ready:'準備済み', stopped:'停止中', complete:'セッション完了',
  executing:'実行予約あり', prepared:'提出準備済み', accepted:'提出済み', recorded:'保存状態のみ', runnable:'実行可能', 'multiple-sessions':'複数の保存状態',
  quota:'quota 停止', authentication:'認証待ち', 'billing-unconfirmed':'課金条件未確認', unsupported:'未対応条件', cancelled:'キャンセル', timeout:'タイムアウト',
  'unknown-outcome':'結果不明・要照合', question:'回答待ち', approval:'人の承認待ち', waiting:'待機', 'reservation-invalid':'保存条件が変更', 'candidate-rejected':'候補が検証で拒否', 'iteration-limit':'生成上限',
  system:'システム', product:'プロダクト', experience:'体験', design:'デザイン', validation:'検証', review:'レビュー', unknown:'段階未確認',
  dispatch:'dispatch', authorization:'認可確認', 'permit-validation':'認可条件確認', 'runtime-metadata':'CLI 確認', 'generation-profile':'実行条件確認', 'safety-metadata':'安全条件確認', 'native-instructions':'入力準備', 'generation-launch':'起動', generation:'生成処理'
};
const text = (value) => labels[value] || value;
const add = (parent, tag, value) => { const el=document.createElement(tag); el.textContent=value; parent.append(el); return el; };
const refText = (ref) => ref.artifactId+'@'+ref.revision+' #'+ref.lockDigest;
let busy=false, lastSnapshot='', selectedRunId='', latestRuns=[], renderedRunId='', renderedRunSnapshot='';
const search=document.getElementById('run-search');
function applyFilter() {
  const query=search.value.trim().toLocaleLowerCase();
  let shown=0;
  for(const row of document.querySelectorAll('#runs [data-run-id]')) {
    row.hidden=!!query && !row.dataset.search.includes(query);
    if(!row.hidden) shown++;
  }
  document.getElementById('run-count').textContent=shown+' / '+latestRuns.length+' 件を表示';
  document.getElementById('selection-note').textContent=query && selectedRunId && document.querySelector('#runs [aria-current="true"]')?.hidden?'選択中の Run は検索結果の外です。詳細は表示を続けています。':'';
}
search.addEventListener('input',applyFilter);
function renderDetail() {
  const detail=document.getElementById('run-detail');
  const run=latestRuns.find(item=>item.runId===selectedRunId);
  const snapshot=JSON.stringify(run);
  if(selectedRunId===renderedRunId && snapshot===renderedRunSnapshot) return;
  const sameRun=selectedRunId===renderedRunId;
  const previousTable=detail.querySelector('.table-scroll');
  const tableFocused=sameRun && previousTable===document.activeElement;
  const tableScrollLeft=sameRun ? previousTable?.scrollLeft || 0 : 0;
  const priorTechnical=detail.querySelector('.technical-detail');
  const technicalOpen=sameRun && priorTechnical?.open;
  const technicalFocused=sameRun && priorTechnical?.contains(document.activeElement);
  detail.replaceChildren(); renderedRunId=selectedRunId; renderedRunSnapshot=snapshot;
  if(!run) { add(detail,'p','Run を選ぶと、進捗と次に確認する内容が表示されます。'); return; }
  const eyebrow=add(detail,'p','選択中の Run · 保存状態'); eyebrow.className='eyebrow';
  add(detail,'h2','今の進捗と次の行動');
  const status=add(detail,'p',text(run.state)+' · '+run.tasks.length+' Task · '+run.blockerCount+' 件の停止要因'); status.className='detail-status';
  const next=run.state==='blocked'?'停止要因と未解決のTaskを確認':run.state==='review-ready'?'案の根拠と未解決を確認':run.state==='active'?'実行可能なTaskを確認':'成果物と比較結果を確認';
  add(detail,'p','次に確認すること: '+next+'。表示は保存状態であり、backend 実行や承認の証明ではありません。');
  add(detail,'h3','Task の状態');
  if(!run.tasks.length) add(detail,'p','保存された task plan / セッション task はありません。');
  else {
    const scroll=document.createElement('div'); scroll.className='table-scroll'; scroll.tabIndex=0; scroll.setAttribute('role','region'); scroll.setAttribute('aria-label','Task 一覧'); detail.append(scroll);
    const table=document.createElement('table'); scroll.append(table);
    const head=document.createElement('tr'); table.append(head); for(const label of ['Task ID','段階 / 出力型','保存された状態']) add(head,'th',label).scope='col';
    for(const task of run.tasks) { const row=document.createElement('tr'); table.append(row); add(row,'td',task.taskId); add(row,'td',text(task.stage)+' / '+task.outputType); add(row,'td',text(task.phase)); }
  }
  const stages=Object.entries(run.stageCounts).map(([stage,count])=>text(stage)+': '+count).join(' / ');
  if(stages) add(detail,'p','Task 数（完了率ではありません）: '+stages);
  const technical=document.createElement('details'); technical.className='technical-detail'; detail.append(technical);
  technical.open=!!technicalOpen;
  add(technical,'summary','記録 ID・セッション・成果物の詳細を開く');
  add(technical,'p','Run ID: '+run.runId);
  add(technical,'p','safe work '+run.safeWorkCount+' · proposals '+run.proposalCount);
  add(technical,'h3','セッション');
  if(!run.sessions.length) add(technical,'p','保存されたセッションはありません。');
  for(const session of run.sessions) {
    const block=document.createElement('div'); block.className='session'; technical.append(block);
    add(block,'h4',session.sessionId+' · '+text(session.status)+(session.stop?' · '+text(session.stop):''));
    for(const task of session.tasks) add(block,'p',task.taskId+' · '+(session.status==='stopped'?text(session.stop || 'stopped')+'（task 保存 phase: '+text(task.phase)+'）':text(task.phase))+(task.stage?' · 最終観測: '+text(task.stage):''));
  }
  add(technical,'h3','成果物の exact refs');
  if(!run.artifacts.length) add(technical,'p','この Run の成果物 ref はまだありません。');
  for(const artifact of run.artifacts) add(technical,'p',artifact.type+' · '+refText(artifact.ref)).className='ref';
  const newTable=detail.querySelector('.table-scroll');
  if(newTable) { newTable.scrollLeft=tableScrollLeft; if(tableFocused) newTable.focus({preventScroll:true}); }
  if(technicalFocused) technical.querySelector('summary').focus({preventScroll:true});
}
function selectRun(runId) {
  selectedRunId=runId;
  for(const row of document.querySelectorAll('#runs [data-run-id]')) row.setAttribute('aria-current',String(row.dataset.runId===runId));
  renderDetail(); applyFilter();
}
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
    document.getElementById('run-browser').dataset.stale='false';
    document.getElementById('summary').textContent=state.runs.length+' Runs / '+state.counts.artifacts+' 成果物 / '+state.counts.sessions+' セッション';
    const snapshot=JSON.stringify([state.runs,state.preview]);
    if(snapshot!==lastSnapshot) {
      lastSnapshot=snapshot;
      latestRuns=state.runs;
      const runs=document.getElementById('runs');
      const focusedRun=document.activeElement?.dataset?.runId;
      runs.replaceChildren();
      if(!state.runs.length) add(runs,'p','保存された Run はありません。');
      if(!state.runs.some(run=>run.runId===selectedRunId)) selectedRunId=state.runs[0]?.runId || '';
      for(const run of state.runs) {
        const row=document.createElement('button'); row.type='button'; row.className='run-row'; row.dataset.runId=run.runId;
        row.dataset.search=[run.runId,...run.tasks.map(task=>task.taskId),...run.artifacts.map(artifact=>artifact.ref.artifactId)].join(' ').toLocaleLowerCase();
        row.setAttribute('aria-controls','run-detail'); row.setAttribute('aria-current',String(run.runId===selectedRunId));
        row.addEventListener('click',()=>selectRun(run.runId)); runs.append(row);
        add(row,'strong',text(run.runId));
        add(row,'span',text(run.state)+' · '+run.tasks.length+' Task · '+run.artifacts.length+' 成果物');
      }
      renderDetail(); applyFilter();
      if(focusedRun) [...runs.querySelectorAll('[data-run-id]')].find(row=>row.dataset.runId===focusedRun)?.focus();
    }
    const link=document.getElementById('product-preview-link');
    link.hidden=state.preview.state!=='available';
    document.getElementById('preview-state').textContent=state.preview.state==='available'?'選択済みの既存 synthetic prototype。上の Run から生成された成果物とは限りません。バックエンド・保存・承認の証明ではありません。':state.preview.state==='not-selected'?'Preview は未選択です。起動時に既存 bundle を --preview で指定できます。':'選択した preview を安全に読み込めません。';
  } catch {
    connection.textContent='切断・取得不可 · 表示が残っている場合は前回の保存状態です。';
    connection.dataset.state='disconnected';
    document.getElementById('run-browser').dataset.stale='true';
  } finally { clearTimeout(timeout); busy=false; }
}
poll(); setInterval(poll,2000);
`;

const style = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef3f0;color:#183430;font:16px/1.55 system-ui,sans-serif}main{max-width:1360px;margin:auto;padding:34px 24px 70px}h1{font-size:clamp(27px,3vw,39px);line-height:1.2;margin:6px 0 12px}h2{font-size:21px;line-height:1.3}h3{font-size:16px;margin-top:28px}h4{font-size:14px}h1,h2,h3,h4,.run-row strong,.ref{overflow-wrap:anywhere}p{margin:10px 0}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#39746c}.intro{max-width:82ch;color:#415b56}.meta{display:flex;gap:14px 26px;flex-wrap:wrap;align-items:center;padding:15px 0;border-top:1px solid #cbdad3;border-bottom:1px solid #cbdad3;margin:24px 0}#connection{font-weight:650;color:#155b42}#connection[data-state=disconnected]{color:#9b3425}#summary{font-weight:650}.stage-note{font-size:14px;color:#49645e}.preview,#run-detail,.run-index{background:#fff;border:1px solid #cadbd3;border-radius:14px;box-shadow:0 5px 24px #173f3009}.preview{padding:20px 24px;margin:26px 0}.preview h2{margin:0 0 8px}.preview a{display:inline-block;margin-top:8px;font-weight:700}.run-tools{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:34px 0 12px}.run-tools label{display:block;font-weight:700}.run-tools input{display:block;font:inherit;width:min(100%,420px);padding:11px 13px;border:1px solid #8daaa1;border-radius:8px;margin-top:6px}.run-tools input:focus-visible,.run-row:focus-visible,.table-scroll:focus-visible,a:focus-visible{outline:3px solid #1678a3;outline-offset:3px}#run-count{font-size:14px;color:#415b56}.run-browser{display:grid;grid-template-columns:minmax(250px,340px) minmax(0,1fr);gap:18px;align-items:start}.run-index{overflow:hidden}.run-index h2{font-size:15px;margin:0;padding:16px 20px;border-bottom:1px solid #dce7e0}.run-list{max-height:min(70vh,810px);overflow:auto}.run-row{display:block;width:100%;border:0;border-bottom:1px solid #e2eae5;background:white;text-align:left;padding:14px 18px;cursor:pointer;color:inherit;font:inherit}.run-row:hover{background:#f3f8f5}.run-row[aria-current=true]{background:#e3f2e9;border-left:4px solid #137765;padding-left:14px}.run-row strong,.run-row span{display:block}.run-row strong{font:600 13px/1.4 ui-monospace,monospace}.run-row span{color:#526b64;font-size:13px;margin-top:6px}#run-detail{padding:22px 26px;min-width:0;min-height:320px}#run-detail h2{margin:6px 0 18px}.detail-status{padding:11px 14px;background:#edf6f0;border-left:3px solid #137765;font-weight:650}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:460px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e5eee8;padding:10px;overflow-wrap:anywhere}th{font-size:13px;color:#466159}.ref{font:13px/1.7 ui-monospace,monospace;border-bottom:1px solid #e5eee8;padding:8px 0}.session{border-left:3px solid #abc9bb;padding:2px 0 2px 16px;margin:14px 0}a{color:#086554}[data-stale=true]{opacity:.65}[hidden]{display:none!important}#selection-note{color:#6c5221;font-size:14px}iframe{width:100%;height:78vh;border:1px solid #dce4ef;background:white}@media(max-width:720px){main{padding:20px 14px 48px}.run-browser{grid-template-columns:1fr}.run-list{max-height:280px}#run-detail{padding:18px}.preview{padding:18px}.meta{display:block}}`;
const purposeStyle = `.decision-packet{background:#fff8df;border-left:4px solid #b5862b;border-radius:9px;padding:14px 19px;margin:22px 0}.decision-packet p{margin:5px 0}.decision-packet a{font-weight:750}.decision{background:#173d34;color:#fff;border-radius:16px;padding:22px 26px;margin:23px 0}.decision h2{margin:2px 0 8px}.decision p{max-width:80ch;color:#e1efe7}.decision a{display:inline-block;color:#173d34;background:#d7eee0;padding:10px 15px;border-radius:8px;text-decoration:none;font-weight:750;margin-top:10px}.decision a:hover{background:#fff}.step{font-size:12px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.technical-detail{margin-top:22px;border-top:1px solid #dce7e0;padding-top:15px}.technical-detail summary{cursor:pointer;font-weight:700;color:#175f4b}.technical-detail:focus-visible,.technical-detail summary:focus-visible{outline:3px solid #1678a3;outline-offset:3px}.run-row strong{font:700 15px/1.4 system-ui,sans-serif}.run-row span{font-size:13px}.run-tools{margin-top:31px}`;
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
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic · 設計案とRunを確認</title><style nonce="${nonce}">${style}${purposeStyle}</style><script src="/monitor.js" defer></script></head><body><main><p class="eyebrow">Mimic / Design review and Run monitor</p><h1>設計案を比べ、理由を確かめ、操作する</h1><p class="intro">このページには9UI-178の固定ケーススタディと、このworkspaceの保存済みRunが並びます。案の採否根拠を確認し、Runの進捗を見ながら別途選択したプレビューを新しいタブで操作してください。</p><aside class="decision-packet" aria-label="朝の判断資料"><strong>朝の判断資料 · 新方式は未採用</strong><p>B0/C1/C2の同条件比較は未完了です。途中結果と判断条件は更新される資料で確認してください。</p><p><a href="https://github.com/9uiLe/mimic/blob/main/docs/dogfood/9ui184/decision-packet.md" target="_blank" rel="noopener noreferrer">判断資料を開く →</a> · <a href="https://github.com/9uiLe/mimic/blob/main/docs/dogfood/9ui183/README.md" target="_blank" rel="noopener noreferrer">比較Runの手順</a></p></aside><section class="decision"><span class="step">1 · 案を比較する</span><h2>9UI-178 ケーススタディ · 3案を同じ基準で比較</h2><p>9UI-178の実Runは比較スタジオを暫定推奨し、再開ボードを代案としました。可視情報、隠れた決定情報、ノイズ、次の行動を並べて確かめられます。人間の採用判断は未実施です。</p><a href="/design-review">3案の構造プレビューと採否理由を見る →</a></section><div class="meta"><p id="connection" data-testid="connection-status" role="status" aria-live="polite">接続確認中</p><p id="summary"></p></div><section class="preview"><span class="step">2 · 操作して確かめる</span><h2>別途選択した既存プロダクトのプレビュー</h2><p id="preview-state">確認中</p><a id="product-preview-link" href="/preview" target="_blank" rel="noopener noreferrer" hidden>隔離した新しいタブで操作する →</a></section><div class="run-tools"><label for="run-search">3 · Run の進捗を確認する<input id="run-search" type="search" autocomplete="off" placeholder="Run・Task・成果物 ID で検索" aria-controls="runs"></label><span id="run-count" role="status"></span></div><p class="stage-note">表示は保存状態を2秒ごとに確認します。Taskの段階表示は完了率やbackend実行の保証ではありません。</p><p id="selection-note" role="status"></p><div id="run-browser" class="run-browser"><section class="run-index" aria-label="Run 一覧"><h2>保存された Run · 最近更新順</h2><div id="runs" class="run-list"></div></section><section id="run-detail" aria-label="選択した Run の詳細"></section></div></main></body></html>`,
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
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimic isolated product preview</title><style nonce="${nonce}">${style}</style></head><body><main><p><a href="/">Run 一覧に戻る</a></p><h1>既存 synthetic product preview</h1><p>別途選択された保存済み prototype です。Monitor の Run 出力・実 backend・データ保存・承認の証明ではありません。操作はこの隔離 frame 内に限定されます。</p><iframe title="Product preview" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(srcdoc)}"></iframe></main></body></html>`,
  };
}
