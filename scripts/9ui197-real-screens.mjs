import { createHash } from "node:crypto";

const escape = (value) =>
  String(value ?? "未提供")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const sameRef = (left, right) =>
  left?.artifactId === right?.artifactId &&
  left?.revision === right?.revision &&
  left?.lockDigest === right?.lockDigest;

const lead = (text) => `${String(text ?? "未提供").split("。")[0]}。`;

const script = `const options = [...document.querySelectorAll('[data-option]')];
function expand(option, open) {
  for (const item of options) {
    const active = item === option && open;
    item.classList.toggle('expanded', active);
    item.inert = open && item !== option;
    item.querySelector('.screen-surface').inert = !active;
    item.querySelector('[data-expand]').textContent = active ? '3画面の一覧へ戻る' : '大きく開いて操作';
  }
  document.body.classList.toggle('has-expanded', open);
}
function showStep(option, step) {
  const stages = [...option.querySelectorAll('[data-c-step]')];
  if (!Number.isInteger(step) || step < 0 || step >= stages.length) return;
  stages.forEach((stage, index) => { stage.hidden = index !== step; });
  option.dataset.currentStep = String(step);
  option.querySelector('[data-step-count]').textContent = (step + 1) + ' / ' + stages.length;
  option.querySelector('[data-c-prev]').disabled = step === 0;
  option.querySelector('[data-c-next]').disabled = step === stages.length - 1;
  option.querySelectorAll('[data-c-go]').forEach((button) => {
    button.setAttribute('aria-current', Number(button.dataset.cGo) === step ? 'step' : 'false');
  });
}
function fillTemplate(option, selector, target) {
  const template = option.querySelector(selector);
  if (template) target.replaceChildren(template.content.cloneNode(true));
}
function renderPair(option) {
  for (const side of ['left', 'right']) {
    const index = option.querySelector('[data-b-select="' + side + '"]').value;
    fillTemplate(option, '[data-panel-template="' + index + '"]', option.querySelector('[data-b-panel="' + side + '"]'));
  }
  option.querySelector('[data-pair-status]').textContent = '比較枠を更新しました。作業用の選択は変わっていません。';
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const option = button.closest('[data-option]');
  if (!option) return;
  if (button.hasAttribute('data-expand')) { expand(option, !option.classList.contains('expanded')); return; }
  if (button.hasAttribute('data-try-choice')) {
    option.querySelector('[data-trial-status]').textContent = '画面内で試した候補: 候補' + button.dataset.tryChoice + '（保存なし）';
    return;
  }
  if (button.hasAttribute('data-revision')) { option.querySelector('[data-revision-confirmation]').hidden = false; return; }
  if (button.hasAttribute('data-a-detail')) {
    option.querySelector('[data-a-main]').hidden = true;
    option.querySelector('[data-a-detail-view]').hidden = false;
    option.querySelectorAll('[data-a-detail-content]').forEach((item) => { item.hidden = item.dataset.aDetailContent !== button.dataset.aDetail; });
    return;
  }
  if (button.hasAttribute('data-a-back')) { option.querySelector('[data-a-main]').hidden = false; option.querySelector('[data-a-detail-view]').hidden = true; return; }
  if (button.hasAttribute('data-b-detail')) {
    fillTemplate(option, '[data-detail-template="' + button.dataset.bDetail + '"]', option.querySelector('[data-b-detail-content]'));
    option.querySelector('[data-b-main]').hidden = true;
    option.querySelector('[data-b-detail-view]').hidden = false;
    return;
  }
  if (button.hasAttribute('data-b-back')) { option.querySelector('[data-b-main]').hidden = false; option.querySelector('[data-b-detail-view]').hidden = true; return; }
  if (button.hasAttribute('data-c-detail')) {
    fillTemplate(option, '[data-detail-template="' + button.dataset.cDetail + '"]', option.querySelector('[data-c-detail-content]'));
    option.querySelector('[data-c-main]').hidden = true;
    option.querySelector('[data-c-detail-view]').hidden = false;
    return;
  }
  if (button.hasAttribute('data-c-back')) { option.querySelector('[data-c-main]').hidden = false; option.querySelector('[data-c-detail-view]').hidden = true; return; }
  if (button.hasAttribute('data-c-go')) { showStep(option, Number(button.dataset.cGo)); return; }
  if (button.hasAttribute('data-c-prev')) { showStep(option, Number(option.dataset.currentStep ?? '0') - 1); return; }
  if (button.hasAttribute('data-c-next')) { showStep(option, Number(option.dataset.currentStep ?? '0') + 1); }
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-b-select]')) renderPair(event.target.closest('[data-option]'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const open = document.querySelector('[data-option].expanded');
    if (open) expand(open, false);
  }
});`;

const style = `:root{color-scheme:light;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#173331;background:#eef1ec}*{box-sizing:border-box}body{margin:0}body.has-expanded{overflow:hidden}button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #ecad50;outline-offset:2px}h1,h2,h3,p{margin-top:0}p{line-height:1.55}.index{max-width:1600px;margin:auto;padding:30px 28px 42px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#287568}.index-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.index-head h1{font-size:clamp(26px,3vw,43px);letter-spacing:-.04em;margin-bottom:8px}.index-head p{max-width:760px;margin-bottom:0;color:#4c625c}.source-note{border-left:4px solid #dbad62;padding:10px 14px;background:#fff8ea;font-size:13px;max-width:310px}.screens{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}.screen-option{background:#fff;border:1px solid #c9d7ce;box-shadow:0 14px 32px #24443b0f;min-width:0;overflow:hidden}.option-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #dce5de;background:#f9fbf8}.option-head h2{font-size:18px;line-height:1.25;margin:4px 0 2px}.option-head small{font-size:11px;color:#597068}.status-chip{display:inline-block;font-size:11px;font-weight:800;color:#176454;background:#e3f0ea;padding:3px 7px}.status-chip.pending{color:#705925;background:#f6edd4}.expand{border:1px solid #176454;background:#fff;color:#176454;font-weight:700;font-size:12px;padding:8px 10px;white-space:nowrap}.expand:hover{background:#e7f3ed}.screen-surface{height:490px;overflow:hidden;pointer-events:none;background:#f1f4ef}.screen-option.expanded{position:fixed;z-index:20;inset:0;width:100vw;height:100dvh;overflow:auto;border:0;box-shadow:none}.expanded .option-head{position:sticky;top:0;z-index:2;padding:14px max(20px,calc((100vw - 1320px)/2));background:#fff}.expanded .screen-surface{height:auto;min-height:calc(100dvh - 85px);overflow:visible;pointer-events:auto}.product{max-width:1320px;margin:auto;padding:24px 25px 50px}.product-top{display:flex;justify-content:space-between;align-items:start;gap:16px;padding-bottom:20px;border-bottom:1px solid #cad9cf}.product-top h3{font-size:clamp(22px,2.3vw,32px);letter-spacing:-.03em;margin:5px 0}.product-top p{font-size:13px;color:#52655c;max-width:700px;margin-bottom:0}.run-pill{border:1px solid #bfd2c6;padding:8px 12px;font-size:12px;white-space:nowrap;background:#fff}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:18px 0}.action{background:#176454;color:#fff;border:1px solid #176454;border-radius:4px;padding:10px 15px;font-weight:700}.action:hover{background:#0d493f}.action.secondary{background:#fff;color:#176454}.context{font-size:12px;color:#52655c}.fixed{font-weight:800;color:#3c4f46}.section-title{font-size:16px;margin:24px 0 12px}.candidate-tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.04em;background:#e8f3ed;color:#176454;padding:4px 7px}.candidate-tag.selected{background:#d9ebe2}.candidate-tag.pending{background:#f8efd9;color:#705925}.subtle{color:#5b6f65;font-size:12px}.screen-copy{font-size:14px;line-height:1.55;color:#29443c}.panel{background:#fff;border:1px solid #d4e0d7;padding:18px}.panel h4{margin:10px 0;font-size:20px}.panel p:last-child{margin-bottom:0}.link-button{border:0;background:none;color:#126a5b;text-decoration:underline;font-weight:700;padding:4px 0}.trial{border-top:1px solid #d4e0d7;margin-top:25px;padding-top:18px}.trial-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.trial-status{font-size:12px;color:#52655c}.revision-confirmation{margin-top:12px;background:#fff8e7;border-left:4px solid #dbad62;padding:14px}.materials{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:22px}.materials section{padding:16px;border:1px solid #d4e0d7;background:#fff}.materials h4{margin:0 0 9px}.materials p,.materials li{font-size:13px;line-height:1.55}.source-details{font-size:12px;margin-top:26px;color:#557066}.source-details pre{white-space:pre-wrap;overflow-wrap:anywhere}.a-table-wrap{overflow:auto;border:1px solid #c8d8cc;background:#fff}.a-table{border-collapse:collapse;table-layout:fixed;min-width:900px;width:100%}.a-table th,.a-table td{border-right:1px solid #dbe6de;border-bottom:1px solid #dbe6de;padding:15px;vertical-align:top;text-align:left;font-size:13px;line-height:1.5}.a-table thead th{position:sticky;top:0;background:#e5f0e8;z-index:1}.a-table tbody th{width:165px;background:#f0f5ef;font-size:12px;color:#35524a}.a-table .head-name{font-size:17px;display:block;margin-top:7px}.a-mobile{display:none}.a-mobile .panel{margin-bottom:12px}.a-mobile dl{margin:0}.a-mobile dt{font-weight:800;font-size:12px;color:#557066;margin-top:13px}.a-mobile dd{margin:3px 0 0;font-size:13px;line-height:1.5}.detail-view{max-width:900px;margin:auto;background:#fff;border:1px solid #cbd9ce;padding:24px}.detail-view h4{font-size:26px;margin:12px 0}.detail-view li{line-height:1.6;margin-bottom:10px}.detail-view details{border-top:1px solid #dce6de;padding-top:10px}.pair-controls{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0}.pair-controls label{font-size:12px;font-weight:800;color:#48695b}.pair-controls select{display:block;width:100%;margin-top:7px;border:1px solid #aebfb2;padding:10px;background:#fff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pair .panel{border-top:5px solid #176454;min-width:0}.pair .panel:nth-child(2){border-top-color:#c39043}.pair .field{border-top:1px solid #e0e8e1;margin-top:14px;padding-top:11px}.pair .field strong{display:block;font-size:11px;color:#5a6e61;margin-bottom:5px}.pair .field p{font-size:13px}.wizard-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.steps{display:flex;gap:6px;overflow-x:auto;padding:10px 0 17px}.steps button{min-width:102px;border:1px solid #cbd9ce;background:#fff;color:#426358;padding:8px 11px;font-size:11px;text-align:left}.steps button[aria-current="step"]{background:#176454;color:#fff}.step-stage{background:#fff;border:1px solid #d4e0d7;padding:24px}.step-stage h4{font-size:25px;letter-spacing:-.02em;margin:0 0 8px}.step-stage .stage-intro{color:#5b6e63;font-size:13px}.stage-candidates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.stage-candidates .panel{background:#f8faf7;min-width:0}.stage-candidates .panel p{font-size:13px}.stage-nav{display:flex;justify-content:space-between;gap:12px;margin-top:18px}.summary-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}.summary-list .panel p{font-size:12px}.summary-list strong{display:block;margin-top:12px;color:#48695b;font-size:11px}@media(max-width:1050px){.product{padding:18px}.screens{gap:10px}.screen-surface{height:390px}.option-head{align-items:start;flex-direction:column}.expand{width:100%}.expanded .option-head{flex-direction:row}.product-top{flex-direction:column}.run-pill{white-space:normal}}@media(max-width:700px){.index{padding:16px}.index-head{display:block;margin-bottom:15px}.index-head h1{font-size:27px}.source-note{max-width:none;margin-top:12px}.screens{grid-template-columns:1fr;gap:9px}.option-head{flex-direction:row;padding:10px 12px}.option-head h2{font-size:15px}.option-head small{display:none}.expand{width:auto;font-size:11px;padding:7px}.screen-surface{height:230px}.screen-option:not(.expanded) .product{padding:10px 12px}.screen-option:not(.expanded) .product-top{display:none}.screen-option:not(.expanded) .toolbar{margin:4px 0 8px}.screen-option:not(.expanded) .toolbar .context{display:none}.screen-option:not(.expanded) .pair-controls{margin:4px 0}.expanded .option-head{padding:10px 12px}.expanded .option-head small{display:block}.expanded .screen-surface{height:auto}.product{padding:16px 12px 40px}.product-top{padding-bottom:12px}.product-top h3{font-size:21px}.toolbar{margin:12px 0}.a-table-wrap{display:none}.a-mobile{display:block}.pair-controls,.pair,.materials,.stage-candidates,.summary-list{grid-template-columns:1fr}.pair-controls{gap:8px}.pair .panel{border-top-width:3px}.step-stage{padding:15px}.step-stage h4{font-size:20px}.stage-candidates{gap:8px}.steps button{min-width:87px}.detail-view{padding:16px}.run-pill{font-size:11px}}`;

function detail(candidate) {
  return `<span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}${candidate.selected ? " · 作業用ベース" : " · 未選択"}</span><h4>候補${candidate.name}の詳細</h4><p>${escape(candidate.summary)}</p><h5>画面の構造</h5><ol>${candidate.mechanisms.map((item) => `<li>${escape(item)}</li>`).join("")}</ol><details><summary>出典の適用理由とS11評価</summary><ul>${candidate.rationale.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><ul>${candidate.evaluation.map((item) => `<li>${escape(item.criterion)}: ${escape(item.reason)} (${escape(item.state)})</li>`).join("")}</ul></details>`;
}

function runContext(report, selectedRef) {
  const history = (report.priorSelectedRefs ?? [])
    .map((ref) => `${escape(ref.artifactId)}@${escape(ref.revision)}`)
    .join(" → ");
  return `<p class="context">Run ${escape(report.runId)} · 親 Run: ${escape(report.previousRunId ?? "初期 Run")} · 改訂元: ${escape(selectedRef.artifactId)}@${escape(selectedRef.revision)}</p><p class="context">前の作業用選択: ${history || "記録なし"} · 改訂済み回数: ${escape(report.revisionCount ?? "未確認")} / ${escape(report.revisionBudget ?? "未確認")}</p>`;
}

function trial(candidates, report) {
  const canRevise =
    Number.isSafeInteger(report.revisionCount) &&
    Number.isSafeInteger(report.revisionBudget) &&
    report.revisionCount < report.revisionBudget;
  return `<section class="trial"><strong>作業用選択を画面内で試す</strong><p class="subtle">保存済みの作業用ベースは候補A。ここでの操作はRunや人の選択記録を変更しません。</p><p class="fixed">改訂は最大2回</p><div class="trial-actions">${candidates.map((candidate) => `<button class="action secondary" type="button" data-try-choice="${candidate.name}">候補${candidate.name}を仮選択</button>`).join("")}</div><p class="trial-status" data-trial-status>画面内で試した候補: なし（保存なし）</p><button class="link-button" type="button" data-revision${canRevise ? "" : " disabled"}>選んだ案を改善する前に確認</button>${canRevise ? "" : "<p data-revision-limit>改訂上限のため試用できません。人の判断へ戻します。</p>"}<div class="revision-confirmation" data-revision-confirmation hidden><strong>改訂前の確認・試用</strong>${runContext(report, candidates[0].ref)}<p>これは確認画面の試作で、改訂は開始されません。</p></div></section>`;
}

function materials(report) {
  const proposal =
    report.proposedDecisions
      ?.map((item) => `<p>${escape(item.summary)}</p>`)
      .join("") || "<p>推奨提案: 未取得</p>";
  const unresolved =
    report.unresolved?.map((item) => `<li>${escape(item)}</li>`).join("") ||
    "<li>要確認事項なし</li>";
  return `<div class="materials"><section><h4>AIの推奨提案</h4>${proposal}<p class="subtle">提案は人の採用ではありません。</p></section><section><h4>未確定事項</h4><ul>${unresolved}</ul></section></div>`;
}

function chrome(candidate, brief, title) {
  return `<header class="product-top"><div><span class="eyebrow">MIMIC / RUN ${escape(candidate.runId)}</span><h3>${escape(title)}</h3><p>同じ保存済み候補を、異なる比較方法で確認します。最終採用とブランド適合は未承認・未検証です。</p></div><div class="run-pill">現在の作業用ベース: 候補A<br><span class="fixed">${escape(brief.content.find((item) => item.policy === "fixed-fact")?.text)}</span></div></header>`;
}

function commonFooter(candidates) {
  return `<details class="source-details"><summary>保存済み参照と検査状態</summary><pre>${escape(
    JSON.stringify(
      candidates.map((candidate) => ({
        ref: candidate.ref,
        verification: candidate.verification,
      })),
      null,
      2,
    ),
  )}</pre><p>S10は構造案です。この画面意匠はCodexによる試作で、Mimicが生成した完成UIではありません。</p></details>`;
}

function screen(id, name, subtitle, status, body) {
  return `<article class="screen-option" data-option="${id}"><header class="option-head"><div><span class="status-chip ${id === "a" ? "" : "pending"}">${escape(status)}</span><h2>画面案${name} · ${escape(subtitle)}</h2><small>保存済みS10構造をCodexが画面化 · 最終採用は未承認</small></div><button class="expand" type="button" data-expand>大きく開いて操作</button></header><div class="screen-surface" inert>${body}</div></article>`;
}

function matrixScreen(candidates, fields, report, brief) {
  const row = (field) =>
    `<tr><th scope="row">${escape(field)}</th>${candidates.map((candidate) => `<td>${escape(candidate.fields[field])}</td>`).join("")}</tr>`;
  const table = `<div class="a-table-wrap"><table class="a-table"><thead><tr><th scope="col">判断項目</th>${candidates.map((candidate) => `<th scope="col"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}${candidate.selected ? " · 作業用ベース" : " · 未選択"}</span><span class="head-name">${escape(lead(candidate.summary))}</span><button class="link-button" type="button" data-a-detail="${candidate.index}">詳細を見る</button></th>`).join("")}</tr></thead><tbody>${fields.map(row).join("")}</tbody></table></div>`;
  const mobile = `<div class="a-mobile">${candidates.map((candidate) => `<section class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><h4>${escape(lead(candidate.summary))}</h4><dl>${fields.map((field) => `<dt>${escape(field)}</dt><dd>${escape(candidate.fields[field])}</dd>`).join("")}</dl><button class="link-button" type="button" data-a-detail="${candidate.index}">詳細を見る</button></section>`).join("")}</div>`;
  return `<div class="product">${chrome(candidates[0], brief, "全候補を一度に見渡す")}<div data-a-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">全候補を列、同じ判断項目を行に配置</p>${runContext(report, candidates[0].ref)}</div><span class="context">3候補 × ${fields.length}項目</span></div>${table}${mobile}${materials(report)}${trial(candidates, report)}</div><div class="detail-view" data-a-detail-view hidden><button class="link-button" type="button" data-a-back>比較表に戻る</button>${candidates.map((candidate) => `<section data-a-detail-content="${candidate.index}" hidden>${detail(candidate)}</section>`).join("")}</div>${commonFooter(candidates)}</div>`;
}

function pairPanel(candidate, fields) {
  return `<div><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}${candidate.selected ? " · 作業用ベース" : " · 未選択"}</span><h4>${escape(lead(candidate.summary))}</h4>${fields.map((field) => `<div class="field"><strong>${escape(field)}</strong><p>${escape(candidate.fields[field])}</p></div>`).join("")}<button class="link-button" type="button" data-b-detail="${candidate.index}">候補${candidate.name}の詳細を見る</button></div>`;
}

function pairScreen(candidates, fields, report, brief) {
  const choices = candidates
    .map(
      (candidate) =>
        `<option value="${candidate.index}">候補${candidate.name}</option>`,
    )
    .join("");
  return `<div class="product">${chrome(candidates[0], brief, "二案を並べて深く読む")}<div data-b-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">比較枠への配置は作業用選択とは別です</p></div><span class="context">二案を選び直せます</span></div><div class="pair-controls"><label>左の比較枠<select data-b-select="left">${choices}</select></label><label>右の比較枠<select data-b-select="right">${candidates.map((candidate) => `<option value="${candidate.index}"${candidate.index === 1 ? " selected" : ""}>候補${candidate.name}</option>`).join("")}</select></label></div><p class="subtle" data-pair-status>候補Aと候補Bを比較中。比較枠は保存済みの選択ではありません。</p><div class="pair"><section class="panel" data-b-panel="left">${pairPanel(candidates[0], fields)}</section><section class="panel" data-b-panel="right">${pairPanel(candidates[1], fields)}</section></div>${materials(report)}${trial(candidates, report)}</div><div class="detail-view" data-b-detail-view hidden><button class="link-button" type="button" data-b-back>同じ二案の比較に戻る</button><div data-b-detail-content></div></div>${candidates.map((candidate) => `<template data-panel-template="${candidate.index}">${pairPanel(candidate, fields)}</template><template data-detail-template="${candidate.index}">${detail(candidate)}</template>`).join("")}${commonFooter(candidates)}</div>`;
}

function stepCandidates(candidates, field) {
  return `<div class="stage-candidates">${candidates.map((candidate) => `<article class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><p>${escape(candidate.fields[field])}</p><button class="link-button" type="button" data-c-detail="${candidate.index}">詳細を見る</button></article>`).join("")}</div>`;
}

function journeyScreen(candidates, fields, report, brief) {
  const stepNames = [...fields, "判断材料", "全体を再確認"];
  const navNames = [
    "共通項目",
    "推奨と保留",
    "Runと選択",
    "選択と改訂",
    "情報量",
    "向く条件",
    "判断材料",
    "全体要約",
  ];
  const steps = fields
    .map(
      (field, index) =>
        `<section class="step-stage" data-c-step="${index}"${index ? " hidden" : ""}><span class="eyebrow">判断項目 ${index + 1}</span><h4>${escape(field)}</h4><p class="stage-intro">この項目について全候補を確認します。段階の移動は選択を変えません。</p>${stepCandidates(candidates, field)}</section>`,
    )
    .join("");
  const evidence = `<section class="step-stage" data-c-step="${fields.length}" hidden><span class="eyebrow">判断材料</span><h4>推奨と未確定事項</h4><p class="stage-intro">AIの提案と人の確認事項を分けて読みます。</p>${materials(report)}</section>`;
  const summary = `<section class="step-stage" data-c-step="${fields.length + 1}" hidden><span class="eyebrow">全体の再確認</span><h4>全項目を振り返る</h4><div class="summary-list">${candidates.map((candidate) => `<article class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><p>${escape(lead(candidate.summary))}</p>${fields.map((field) => `<strong>${escape(field)}</strong><p>${escape(candidate.fields[field])}</p>`).join("")}</article>`).join("")}</div>${trial(candidates, report)}</section>`;
  return `<div class="product">${chrome(candidates[0], brief, "判断項目を順に確かめる")}<div data-c-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">一項目ずつ確認し、最後に全体へ戻ります</p></div><span class="context" data-step-count>1 / ${stepNames.length}</span></div><nav class="steps" aria-label="判断項目">${stepNames.map((name, index) => `<button type="button" data-c-go="${index}" aria-label="${escape(name)}" aria-current="${index === 0 ? "step" : "false"}">${index + 1}. ${escape(navNames[index] ?? name)}</button>`).join("")}</nav>${steps}${evidence}${summary}<div class="stage-nav"><button class="action secondary" type="button" data-c-prev disabled>前へ</button><button class="action" type="button" data-c-next>次の項目へ</button></div></div><div class="detail-view" data-c-detail-view hidden><button class="link-button" type="button" data-c-back>元の判断項目に戻る</button><div data-c-detail-content></div></div>${candidates.map((candidate) => `<template data-detail-template="${candidate.index}">${detail(candidate)}</template>`).join("")}${commonFooter(candidates)}</div>`;
}

/** Render three Codex-authored UI sketches from one verified, saved S10/S11 packet. */
export function renderRealScreensHtml(report, brief, expectedRef) {
  if (
    !report?.humanSelectionId ||
    !sameRef(report.selectedRef, expectedRef) ||
    !/^sha256:[a-f0-9]{64}$/.test(expectedRef?.lockDigest ?? "")
  )
    throw Error("Real screens need the verified exact human working choice");
  const byName = new Map();
  for (const candidate of report.candidates ?? []) {
    const name = candidate.summary?.match(/^案([ABC])/u)?.[1];
    if (!name || byName.has(name))
      throw Error("Expected distinct saved A/B/C directions");
    byName.set(name, candidate);
  }
  if (byName.size !== 3 || !sameRef(byName.get("A")?.ref, expectedRef))
    throw Error("Expected the selected saved A direction and B/C comparisons");
  if (
    !brief?.content?.some(
      (item) => item.policy === "fixed-fact" && item.text === "改訂は最大2回",
    ) ||
    !brief.content.some(
      (item) => item.policy === "fixed-copy" && item.text === "候補を比較",
    )
  )
    throw Error("Real screens need the saved fixed fact and copy");
  const markers = [
    "候補を列、共通判断項目を行",
    "二つの比較枠",
    "項目単位で確認",
  ];
  const commonCriteria = (byName.get("A").evaluation ?? [])
    .filter((item) => item.criterion)
    .slice(0, 5)
    .map((item) => item.criterion);
  const expectedCriteria = [
    "共通判断項目の可視性",
    "AI の推奨理由と未確定事項の分離・到達性",
    "対象・関係・現在の選択と復帰の連続性",
    "明示選択と改訂前の再確認",
    "情報量・不要情報と次の操作",
  ];
  if (JSON.stringify(commonCriteria) !== JSON.stringify(expectedCriteria))
    throw Error("Saved S11 packet lacks five common judgment criteria");
  const candidates = ["A", "B", "C"].map((name, index) => {
    const candidate = byName.get(name);
    if (!candidate.mechanisms?.some((item) => item.includes(markers[index])))
      throw Error(`Saved direction ${name} lacks its structural mechanism`);
    if (!Array.isArray(candidate.evaluation))
      throw Error(`Saved direction ${name} lacks its S11 evaluation`);
    const fields = Object.fromEntries(
      commonCriteria.map((criterion) => [
        criterion,
        candidate.evaluation.find((item) => item.criterion === criterion)
          ?.reason ?? "未提供",
      ]),
    );
    fields["向く条件と代償"] = candidate.summary;
    return {
      ...candidate,
      name,
      index,
      runId: report.runId,
      selected: name === "A",
      fields,
      evaluation: Array.isArray(candidate.evaluation)
        ? candidate.evaluation
        : [],
    };
  });
  const fields = Object.keys(candidates[0].fields);
  const screens = [
    screen(
      "a",
      "A",
      "全候補一覧",
      "作業用ベース",
      matrixScreen(candidates, fields, report, brief),
    ),
    screen(
      "b",
      "B",
      "二案対照",
      "未選択の比較案",
      pairScreen(candidates, fields, report, brief),
    ),
    screen(
      "c",
      "C",
      "判断項目順次",
      "未選択の比較案",
      journeyScreen(candidates, fields, report, brief),
    ),
  ].join("");
  const hash = createHash("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>3つの実画面を比較 · Mimic</title><style>${style}</style></head><body><main class="index" data-real-screens="unapproved"><header class="index-head"><div><span class="eyebrow">MIMIC / DESIGN REVIEW</span><h1>3つの画面を、同じ内容で試す</h1><p>Aは人が改訂元に選んだ構造案です。BとCは未選択の比較候補。どの画面も最終採用・公開は未承認です。</p></div><aside class="source-note">Mimic S10/S11 の保存済み構造と評価を使い、Codex が画面を設計・実装しました。Mimic が完成UIを生成したものではありません。</aside></header><div class="screens">${screens}</div></main><script>${script}</script></body></html>`;
}
