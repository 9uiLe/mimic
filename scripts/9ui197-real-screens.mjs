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

const exactRef = (ref) =>
  /^art_[A-Za-z0-9_-]+$/.test(ref?.artifactId ?? "") &&
  Number.isSafeInteger(ref?.revision) &&
  ref.revision > 0 &&
  /^sha256:[a-f0-9]{64}$/.test(ref?.lockDigest ?? "");

// One known dogfood brief has an HTML sketch for the Mimic comparison product.
// Keep the whole contract explicit until other product briefs have renderers.
const comparisonBrief = {
  audience: "Mimic で画面設計を進める利用者",
  purpose: "目的を入力して実デザイン案を比較し、改善する案を選べるようにする",
  primaryAction: "候補を比較し、改善に使う案を明示的に選ぶ",
  requiredInformation: [
    "候補ごとの主操作と構造上の違い",
    "向く条件、利点、失うもの",
    "未検証事項と次の操作",
  ],
  brandCharacter: "ブランドの具体的特徴と配色は未確定。確認まで創作しない",
  content: [
    { policy: "fixed-fact", text: "改訂の初期予算は最大2回" },
    { policy: "fixed-copy", text: "候補を比較" },
    { policy: "confirm", text: "どの案の違いがブランドに合うか" },
  ],
};
const matchesComparisonBrief = (brief) =>
  brief?.audience === comparisonBrief.audience &&
  brief.purpose === comparisonBrief.purpose &&
  brief.primaryAction === comparisonBrief.primaryAction &&
  brief.brandCharacter === comparisonBrief.brandCharacter &&
  JSON.stringify(brief.requiredInformation) ===
    JSON.stringify(comparisonBrief.requiredInformation) &&
  JSON.stringify(brief.content) === JSON.stringify(comparisonBrief.content) &&
  Array.isArray(brief.references) &&
  brief.references.length === 0 &&
  (!brief.brandColors || brief.brandColors.length === 0);

const sourcedReferences = [
  "https://speakerdeck.com/teamlab/object-oriented-ui-design",
  "https://smarthr.design/products/design-patterns/smarthr-table/",
  "https://design.google/library/expressive-material-design-google-research",
  "https://github.blog/news-insights/product-news/improving-navigation-for-github-actions/",
];
const referenceUrl = (reference) =>
  reference?.source?.match(/https?:\/\/[^\s)]+/u)?.[0];
const negatedMechanism =
  /置かない|使わず|使わない|用いない|採用しない|避ける|ではなく|不採用|排除|代わりに|しない|\b(?:not|without|avoid|exclude|instead of)\b/iu;
const matchesSourcedComparisonBrief = (brief) =>
  brief?.audience === comparisonBrief.audience &&
  brief.purpose === comparisonBrief.purpose &&
  brief.primaryAction === comparisonBrief.primaryAction &&
  brief.brandCharacter === comparisonBrief.brandCharacter &&
  JSON.stringify(brief.requiredInformation) ===
    JSON.stringify(comparisonBrief.requiredInformation) &&
  JSON.stringify(brief.content) === JSON.stringify(comparisonBrief.content) &&
  Array.isArray(brief.references) &&
  brief.references.length === sourcedReferences.length &&
  sourcedReferences.every(
    (source) =>
      brief.references.filter(
        (reference) =>
          referenceUrl(reference) === source &&
          reference.reason?.trim() &&
          reference.appliesWhen?.trim() &&
          reference.doNotBorrow?.trim(),
      ).length === 1,
  ) &&
  (!brief.brandColors || brief.brandColors.length === 0);

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
  if (button.hasAttribute('data-list-pick')) {
    const picked = button.dataset.listPick;
    option.querySelectorAll('[data-list-detail]').forEach((item) => { item.hidden = item.dataset.listDetail !== picked; });
    option.querySelectorAll('[data-list-pick]').forEach((item) => { item.setAttribute('aria-current', item === button ? 'true' : 'false'); });
    option.querySelector('[data-list-status]').textContent = '閲覧中: 候補' + String.fromCharCode(65 + Number(picked)) + '。作業用選択は変わっていません。';
  }
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-b-select]')) renderPair(event.target.closest('[data-option]'));
  if (event.target.matches('[data-s-select]')) {
    const option = event.target.closest('[data-option]');
    const side = event.target.dataset.sSelect;
    const picked = event.target.value;
    option.querySelectorAll('[data-s-slot="' + side + '"] [data-s-card]').forEach((item) => { item.hidden = item.dataset.sCard !== picked; });
    option.querySelector('[data-s-status]').textContent = '閲覧ペアを更新しました。作業用選択は変わっていません。';
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const open = document.querySelector('[data-option].expanded');
    if (open) expand(open, false);
  }
});`;

const style = `:root{color-scheme:light;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#173331;background:#eef1ec}*{box-sizing:border-box}body{margin:0}body.has-expanded{overflow:hidden}button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #ecad50;outline-offset:2px}h1,h2,h3,p{margin-top:0}p{line-height:1.55}.index{max-width:1600px;margin:auto;padding:30px 28px 42px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#287568}.index-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.index-head h1{font-size:clamp(26px,3vw,43px);letter-spacing:-.04em;margin-bottom:8px}.index-head p{max-width:760px;margin-bottom:0;color:#4c625c}.source-note{border-left:4px solid #dbad62;padding:10px 14px;background:#fff8ea;font-size:13px;max-width:310px}.screens{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}.screen-option{background:#fff;border:1px solid #c9d7ce;box-shadow:0 14px 32px #24443b0f;min-width:0;overflow:hidden}.option-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #dce5de;background:#f9fbf8}.option-head h2{font-size:18px;line-height:1.25;margin:4px 0 2px}.option-head small{font-size:11px;color:#597068}.status-chip{display:inline-block;font-size:11px;font-weight:800;color:#176454;background:#e3f0ea;padding:3px 7px}.status-chip.pending{color:#705925;background:#f6edd4}.expand{border:1px solid #176454;background:#fff;color:#176454;font-weight:700;font-size:12px;padding:8px 10px;white-space:nowrap}.expand:hover{background:#e7f3ed}.screen-surface{height:490px;overflow:hidden;pointer-events:none;background:#f1f4ef}.screen-option.expanded{position:fixed;z-index:20;inset:0;width:100vw;height:100dvh;overflow:auto;border:0;box-shadow:none}.expanded .option-head{position:sticky;top:0;z-index:2;padding:14px max(20px,calc((100vw - 1320px)/2));background:#fff}.expanded .screen-surface{height:auto;min-height:calc(100dvh - 85px);overflow:visible;pointer-events:auto}.product{max-width:1320px;margin:auto;padding:24px 25px 50px}.product-top{display:flex;justify-content:space-between;align-items:start;gap:16px;padding-bottom:20px;border-bottom:1px solid #cad9cf}.product-top h3{font-size:clamp(22px,2.3vw,32px);letter-spacing:-.03em;margin:5px 0}.product-top p{font-size:13px;color:#52655c;max-width:700px;margin-bottom:0}.run-pill{border:1px solid #bfd2c6;padding:8px 12px;font-size:12px;white-space:nowrap;background:#fff}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:18px 0}.action{background:#176454;color:#fff;border:1px solid #176454;border-radius:4px;padding:10px 15px;font-weight:700}.action:hover{background:#0d493f}.action.secondary{background:#fff;color:#176454}.context{font-size:12px;color:#52655c}.fixed{font-weight:800;color:#3c4f46}.section-title{font-size:16px;margin:24px 0 12px}.candidate-tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.04em;background:#e8f3ed;color:#176454;padding:4px 7px}.candidate-tag.selected{background:#d9ebe2}.candidate-tag.pending{background:#f8efd9;color:#705925}.subtle{color:#5b6f65;font-size:12px}.screen-copy{font-size:14px;line-height:1.55;color:#29443c}.panel{background:#fff;border:1px solid #d4e0d7;padding:18px}.panel h4{margin:10px 0;font-size:20px}.panel p:last-child{margin-bottom:0}.link-button{border:0;background:none;color:#126a5b;text-decoration:underline;font-weight:700;padding:4px 0}.trial{border-top:1px solid #d4e0d7;margin-top:25px;padding-top:18px}.trial-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.trial-status{font-size:12px;color:#52655c}.revision-confirmation{margin-top:12px;background:#fff8e7;border-left:4px solid #dbad62;padding:14px}.materials{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:22px}.materials section{padding:16px;border:1px solid #d4e0d7;background:#fff}.materials h4{margin:0 0 9px}.materials p,.materials li{font-size:13px;line-height:1.55}.source-details{font-size:12px;margin-top:26px;color:#557066}.source-details pre{white-space:pre-wrap;overflow-wrap:anywhere}.a-table-wrap{overflow:auto;border:1px solid #c8d8cc;background:#fff}.a-table{border-collapse:collapse;table-layout:fixed;min-width:900px;width:100%}.a-table th,.a-table td{border-right:1px solid #dbe6de;border-bottom:1px solid #dbe6de;padding:15px;vertical-align:top;text-align:left;font-size:13px;line-height:1.5}.a-table thead th{position:sticky;top:0;background:#e5f0e8;z-index:1}.a-table tbody th{width:165px;background:#f0f5ef;font-size:12px;color:#35524a}.a-table .head-name{font-size:17px;display:block;margin-top:7px}.a-mobile{display:none}.a-mobile .panel{margin-bottom:12px}.a-mobile dl{margin:0}.a-mobile dt{font-weight:800;font-size:12px;color:#557066;margin-top:13px}.a-mobile dd{margin:3px 0 0;font-size:13px;line-height:1.5}.detail-view{max-width:900px;margin:auto;background:#fff;border:1px solid #cbd9ce;padding:24px}.detail-view h4{font-size:26px;margin:12px 0}.detail-view li{line-height:1.6;margin-bottom:10px}.detail-view details{border-top:1px solid #dce6de;padding-top:10px}.pair-controls{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0}.pair-controls label{font-size:12px;font-weight:800;color:#48695b}.pair-controls select{display:block;width:100%;margin-top:7px;border:1px solid #aebfb2;padding:10px;background:#fff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pair .panel{border-top:5px solid #176454;min-width:0}.pair .panel:nth-child(2){border-top-color:#c39043}.pair .field{border-top:1px solid #e0e8e1;margin-top:14px;padding-top:11px}.pair .field strong{display:block;font-size:11px;color:#5a6e61;margin-bottom:5px}.pair .field p{font-size:13px}.wizard-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.steps{display:flex;gap:6px;overflow-x:auto;padding:10px 0 17px}.steps button{min-width:102px;border:1px solid #cbd9ce;background:#fff;color:#426358;padding:8px 11px;font-size:11px;text-align:left}.steps button[aria-current="step"]{background:#176454;color:#fff}.step-stage{background:#fff;border:1px solid #d4e0d7;padding:24px}.step-stage h4{font-size:25px;letter-spacing:-.02em;margin:0 0 8px}.step-stage .stage-intro{color:#5b6e63;font-size:13px}.stage-candidates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.stage-candidates .panel{background:#f8faf7;min-width:0}.stage-candidates .panel p{font-size:13px}.stage-nav{display:flex;justify-content:space-between;gap:12px;margin-top:18px}.summary-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}.summary-list .panel p{font-size:12px}.summary-list strong{display:block;margin-top:12px;color:#48695b;font-size:11px}@media(max-width:1050px){.product{padding:18px}.screens{gap:10px}.screen-surface{height:390px}.option-head{align-items:start;flex-direction:column}.expand{width:100%}.expanded .option-head{flex-direction:row}.product-top{flex-direction:column}.run-pill{white-space:normal}}@media(max-width:700px){.index{padding:16px}.index-head{display:block;margin-bottom:15px}.index-head h1{font-size:27px}.source-note{max-width:none;margin-top:12px}.screens{grid-template-columns:1fr;gap:9px}.option-head{flex-direction:row;padding:10px 12px}.option-head h2{font-size:15px}.option-head small{display:none}.expand{width:auto;font-size:11px;padding:7px}.screen-surface{height:230px}.screen-option:not(.expanded) .product{padding:10px 12px}.screen-option:not(.expanded) .product-top{display:none}.screen-option:not(.expanded) .toolbar{margin:4px 0 8px}.screen-option:not(.expanded) .toolbar .context{display:none}.screen-option:not(.expanded) .pair-controls{margin:4px 0}.expanded .option-head{padding:10px 12px}.expanded .option-head small{display:block}.expanded .screen-surface{height:auto}.product{padding:16px 12px 40px}.product-top{padding-bottom:12px}.product-top h3{font-size:21px}.toolbar{margin:12px 0}.a-table-wrap{display:none}.a-mobile{display:block}.pair-controls,.pair,.materials,.stage-candidates,.summary-list{grid-template-columns:1fr}.pair-controls{gap:8px}.pair .panel{border-top-width:3px}.step-stage{padding:15px}.step-stage h4{font-size:20px}.stage-candidates{gap:8px}.steps button{min-width:87px}.detail-view{padding:16px}.run-pill{font-size:11px}}`;

function detail(candidate) {
  return `<span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}${candidate.selected ? " · 作業用ベース" : " · 未選択"}</span><h4>候補${candidate.name}の詳細</h4><p>${escape(candidate.summary)}</p><h5>画面の構造</h5><ol>${candidate.mechanisms.map((item) => `<li>${escape(item)}</li>`).join("")}</ol><details><summary>出典の適用理由とS11の設計記述評価（実画面・操作は未検証）</summary><ul>${candidate.rationale.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><ul>${candidate.evaluation.map((item) => `<li>${escape(item.criterion)}: ${escape(item.reason)} (${escape(item.state)})</li>`).join("")}</ul></details>`;
}

function runContext(report, selectedRef) {
  const history = (report.priorSelectedRefs ?? [])
    .map((ref) => `${escape(ref.artifactId)}@${escape(ref.revision)}`)
    .join(" → ");
  return `<p class="context">Run ${escape(report.runId)} · 親 Run: ${escape(report.previousRunId ?? "初期 Run")} · ${selectedRef ? `改訂元: ${escape(selectedRef.artifactId)}@${escape(selectedRef.revision)}` : "改訂元: 未選択"}</p><p class="context">前の作業用選択: ${history || "記録なし"} · 改訂済み回数: ${escape(report.revisionCount ?? "未確認")} / ${escape(report.revisionBudget ?? "未確認")}</p>`;
}

function trial(candidates, report, brief) {
  const selected = candidates.find((candidate) => candidate.selected);
  const canRevise =
    selected &&
    Number.isSafeInteger(report.revisionCount) &&
    Number.isSafeInteger(report.revisionBudget) &&
    report.revisionCount < report.revisionBudget;
  const fixed = brief.content.find(
    (item) => item.policy === "fixed-fact",
  )?.text;
  const unavailable = selected
    ? "改訂上限のため試用できません。人の判断へ戻します。"
    : "人が作業用の案を選ぶまで改訂確認は試用できません。";
  return `<section class="trial"><strong>作業用選択を画面内で試す</strong><p class="subtle">${selected ? `保存済みの作業用ベースは候補${selected.name}。` : "保存済みの作業用ベースはありません。"}ここでの操作はRunや人の選択記録を変更しません。</p><p class="fixed">${escape(fixed)}</p><div class="trial-actions">${candidates.map((candidate) => `<button class="action secondary" type="button" data-try-choice="${candidate.name}">候補${candidate.name}を仮選択</button>`).join("")}</div><p class="trial-status" data-trial-status>画面内で試した候補: なし（保存なし）</p><button class="link-button" type="button" data-revision${canRevise ? "" : " disabled"}>選んだ案を改善する前に確認</button>${canRevise ? "" : `<p data-revision-limit>${unavailable}</p>`}<div class="revision-confirmation" data-revision-confirmation hidden><strong>改訂前の確認・試用</strong>${runContext(report, selected?.ref)}<p>これは確認画面の試作で、改訂は開始されません。</p></div></section>`;
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
  return `<header class="product-top"><div><span class="eyebrow">MIMIC / RUN ${escape(candidate.runId)}</span><h3>${escape(title)}</h3><p>同じ保存済み候補を、異なる比較方法で確認します。最終採用とブランド適合は未承認・未検証です。</p></div><div class="run-pill">現在の作業用ベース: ${candidate.selected ? `候補${candidate.name}` : "未選択"}<br><span class="fixed">${escape(brief.content.find((item) => item.policy === "fixed-fact")?.text)}</span></div></header>`;
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
  return `<article class="screen-option" data-option="${id}"><header class="option-head"><div><span class="status-chip ${status === "作業用ベース" ? "" : "pending"}">${escape(status)}</span><h2>画面案${name} · ${escape(subtitle)}</h2><small>保存済みS10構造をCodexが画面化 · 最終採用は未承認</small></div><button class="expand" type="button" data-expand>大きく開いて操作</button></header><div class="screen-surface" inert>${body}</div></article>`;
}

function matrixScreen(candidates, fields, report, brief) {
  const row = (field) =>
    `<tr><th scope="row">${escape(field)}</th>${candidates.map((candidate) => `<td>${escape(candidate.fields[field])}</td>`).join("")}</tr>`;
  const table = `<div class="a-table-wrap"><table class="a-table"><thead><tr><th scope="col">判断項目</th>${candidates.map((candidate) => `<th scope="col"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}${candidate.selected ? " · 作業用ベース" : " · 未選択"}</span><span class="head-name">${escape(lead(candidate.summary))}</span><button class="link-button" type="button" data-a-detail="${candidate.index}">詳細を見る</button></th>`).join("")}</tr></thead><tbody>${fields.map(row).join("")}</tbody></table></div>`;
  const mobile = `<div class="a-mobile">${candidates.map((candidate) => `<section class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><h4>${escape(lead(candidate.summary))}</h4><dl>${fields.map((field) => `<dt>${escape(field)}</dt><dd>${escape(candidate.fields[field])}</dd>`).join("")}</dl><button class="link-button" type="button" data-a-detail="${candidate.index}">詳細を見る</button></section>`).join("")}</div>`;
  return `<div class="product">${chrome(candidates[0], brief, "全候補を一度に見渡す")}<div data-a-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">全候補を列、同じ判断項目を行に配置</p>${runContext(report, candidates.find((candidate) => candidate.selected)?.ref)}</div><span class="context">3候補 × ${fields.length}項目</span></div>${table}${mobile}${materials(report)}${trial(candidates, report, brief)}</div><div class="detail-view" data-a-detail-view hidden><button class="link-button" type="button" data-a-back>比較表に戻る</button>${candidates.map((candidate) => `<section data-a-detail-content="${candidate.index}" hidden>${detail(candidate)}</section>`).join("")}</div>${commonFooter(candidates)}</div>`;
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
  return `<div class="product">${chrome(candidates[0], brief, "二案を並べて深く読む")}<div data-b-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">比較枠への配置は作業用選択とは別です</p></div><span class="context">二案を選び直せます</span></div><div class="pair-controls"><label>左の比較枠<select data-b-select="left">${choices}</select></label><label>右の比較枠<select data-b-select="right">${candidates.map((candidate) => `<option value="${candidate.index}"${candidate.index === 1 ? " selected" : ""}>候補${candidate.name}</option>`).join("")}</select></label></div><p class="subtle" data-pair-status>候補Aと候補Bを比較中。比較枠は保存済みの選択ではありません。</p><div class="pair"><section class="panel" data-b-panel="left">${pairPanel(candidates[0], fields)}</section><section class="panel" data-b-panel="right">${pairPanel(candidates[1], fields)}</section></div>${materials(report)}${trial(candidates, report, brief)}</div><div class="detail-view" data-b-detail-view hidden><button class="link-button" type="button" data-b-back>同じ二案の比較に戻る</button><div data-b-detail-content></div></div>${candidates.map((candidate) => `<template data-panel-template="${candidate.index}">${pairPanel(candidate, fields)}</template><template data-detail-template="${candidate.index}">${detail(candidate)}</template>`).join("")}${commonFooter(candidates)}</div>`;
}

function stepCandidates(candidates, field) {
  return `<div class="stage-candidates">${candidates.map((candidate) => `<article class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><p>${escape(candidate.fields[field])}</p><button class="link-button" type="button" data-c-detail="${candidate.index}">詳細を見る</button></article>`).join("")}</div>`;
}

function journeyScreen(candidates, fields, report, brief) {
  const stepNames = [...fields, "判断材料", "全体を再確認"];
  const steps = fields
    .map(
      (field, index) =>
        `<section class="step-stage" data-c-step="${index}"${index ? " hidden" : ""}><span class="eyebrow">判断項目 ${index + 1}</span><h4>${escape(field)}</h4><p class="stage-intro">この項目について全候補を確認します。段階の移動は選択を変えません。</p>${stepCandidates(candidates, field)}</section>`,
    )
    .join("");
  const evidence = `<section class="step-stage" data-c-step="${fields.length}" hidden><span class="eyebrow">判断材料</span><h4>推奨と未確定事項</h4><p class="stage-intro">AIの提案と人の確認事項を分けて読みます。</p>${materials(report)}</section>`;
  const summary = `<section class="step-stage" data-c-step="${fields.length + 1}" hidden><span class="eyebrow">全体の再確認</span><h4>全項目を振り返る</h4><div class="summary-list">${candidates.map((candidate) => `<article class="panel"><span class="candidate-tag ${candidate.selected ? "selected" : "pending"}">候補${candidate.name}</span><p>${escape(lead(candidate.summary))}</p>${fields.map((field) => `<strong>${escape(field)}</strong><p>${escape(candidate.fields[field])}</p>`).join("")}</article>`).join("")}</div>${trial(candidates, report, brief)}</section>`;
  return `<div class="product">${chrome(candidates[0], brief, "判断項目を順に確かめる")}<div data-c-main><div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">一項目ずつ確認し、最後に全体へ戻ります</p></div><span class="context" data-step-count>1 / ${stepNames.length}</span></div><nav class="steps" aria-label="判断項目">${stepNames.map((name, index) => `<button type="button" data-c-go="${index}" aria-label="${escape(name)}" aria-current="${index === 0 ? "step" : "false"}">${index + 1}. ${escape(name)}</button>`).join("")}</nav>${steps}${evidence}${summary}<div class="stage-nav"><button class="action secondary" type="button" data-c-prev disabled>前へ</button><button class="action" type="button" data-c-next>次の項目へ</button></div></div><div class="detail-view" data-c-detail-view hidden><button class="link-button" type="button" data-c-back>元の判断項目に戻る</button><div data-c-detail-content></div></div>${candidates.map((candidate) => `<template data-detail-template="${candidate.index}">${detail(candidate)}</template>`).join("")}${commonFooter(candidates)}</div>`;
}

/** Render three Codex-authored UI sketches from one verified, saved S10/S11 packet. */
export function renderRealScreensHtml(report, brief, expectedRef) {
  return renderComparisonScreensHtml(report, brief, expectedRef, false);
}

/** Before selection, render only directions whose saved mechanisms identify all three layouts. */
export function renderUnselectedScreensHtml(report, brief) {
  if (matchesSourcedComparisonBrief(brief))
    return renderSourcedScreensHtml(report, brief);
  return renderComparisonScreensHtml(report, brief, null, true);
}

const sourcedStyle = `.list-layout{display:grid;grid-template-columns:minmax(190px,27%) 1fr;gap:15px}.list-rail{display:grid;align-content:start;gap:8px}.list-rail button{text-align:left;border:1px solid #cbd9ce;background:#fff;padding:13px;line-height:1.45}.list-rail button[aria-current="true"]{border-left:5px solid #176454;background:#e8f3ed}.list-detail{min-width:0;border:1px solid #cbd9ce;background:#fff;padding:23px}.list-detail h4{font-size:22px;margin:10px 0}.sourced-pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.sourced-pair .panel{min-width:0}.sourced-pair .panel h5{font-size:16px;margin:10px 0}.sourced-pair .panel p{font-size:14px}@media(max-width:700px){.list-layout,.sourced-pair{grid-template-columns:1fr}.list-rail{display:flex;overflow-x:auto}.list-rail button{min-width:180px}.list-detail{padding:15px}}`;

function sourcedListScreen(candidates, fields, report, brief) {
  const rail = candidates
    .map(
      (candidate) =>
        `<button type="button" data-list-pick="${candidate.index}" aria-current="${candidate.index === 0}"><strong>候補${candidate.name}</strong><br>${escape(lead(candidate.summary))}</button>`,
    )
    .join("");
  const details = candidates
    .map(
      (candidate) =>
        `<section data-list-detail="${candidate.index}"${candidate.index ? " hidden" : ""}><span class="candidate-tag pending">候補${candidate.name} · 閲覧用</span><h4>候補${candidate.name}の実画面と評価</h4><p class="subtle">画面の完成画像は未生成。保存済み構造と評価を広い詳細領域に表示しています。</p>${detail(candidate)}<h5>共通判断項目</h5>${fields.map((field) => `<div class="field"><strong>${escape(field)}</strong><p>${escape(candidate.fields[field])}</p></div>`).join("")}</section>`,
    )
    .join("");
  return `<div class="product">${chrome(candidates[0], brief, "候補一覧から一案を大きく読む")}<div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">閲覧中の候補と作業用の選択は別です。</p></div><span class="context" data-list-status>閲覧中: 候補A。作業用選択はありません。</span></div><div class="list-layout"><nav class="list-rail" aria-label="閲覧する候補">${rail}</nav><div class="list-detail">${details}</div></div>${materials(report)}${trial(candidates, report, brief)}${commonFooter(candidates)}</div>`;
}

function sourcedPairScreen(candidates, fields, report, brief) {
  const choices = (selected) =>
    candidates
      .map(
        (candidate) =>
          `<option value="${candidate.index}"${candidate.index === selected ? " selected" : ""}>候補${candidate.name}</option>`,
      )
      .join("");
  const stages = fields
    .map(
      (field, index) =>
        `<section class="step-stage" data-c-step="${index}"${index ? " hidden" : ""}><span class="eyebrow">論点 ${index + 1}</span><h4>${escape(field)}</h4><p class="stage-intro">二案の同じ論点を対照します。閲覧ペアの変更は作業用選択を変えません。</p><div class="sourced-pair">${["left", "right"].map((side, sideIndex) => `<div data-s-slot="${side}">${candidates.map((candidate) => `<article class="panel" data-s-card="${candidate.index}"${candidate.index !== sideIndex ? " hidden" : ""}><span class="candidate-tag pending">候補${candidate.name}</span><h5>${escape(lead(candidate.summary))}</h5><p>${escape(candidate.fields[field])}</p></article>`).join("")}</div>`).join("")}</div></section>`,
    )
    .join("");
  const last = fields.length;
  return `<div class="product">${chrome(candidates[0], brief, "論点ごとに二案を対照する")}<div class="toolbar"><div><strong>${escape(brief.content.find((item) => item.policy === "fixed-copy")?.text)}</strong><p class="context">論点を行き来し、二案を入れ替えて確認します。</p></div><span class="context" data-step-count>1 / ${last + 1}</span></div><div class="pair-controls"><label>左の閲覧候補<select data-s-select="left">${choices(0)}</select></label><label>右の閲覧候補<select data-s-select="right">${choices(1)}</select></label></div><p class="subtle" data-s-status>候補Aと候補Bを閲覧中。作業用選択はありません。</p><nav class="steps" aria-label="比較する論点">${[...fields, "総括と未確定"].map((name, index) => `<button type="button" data-c-go="${index}" aria-current="${index === 0 ? "step" : "false"}">${index + 1}. ${escape(name)}</button>`).join("")}</nav>${stages}<section class="step-stage" data-c-step="${last}" hidden><h4>全候補の向く条件と代償</h4><div class="summary-list">${candidates.map((candidate) => `<article class="panel"><span class="candidate-tag pending">候補${candidate.name}</span><p>${escape(candidate.summary)}</p></article>`).join("")}</div>${materials(report)}${trial(candidates, report, brief)}</section><div class="stage-nav"><button class="action secondary" type="button" data-c-prev disabled>前へ</button><button class="action" type="button" data-c-next>次の論点へ</button></div>${commonFooter(candidates)}</div>`;
}

function renderSourcedScreensHtml(report, brief) {
  if (
    !report ||
    report.condition !== "guided" ||
    !["awaiting-human-selection", "awaiting-working-selection"].includes(
      report.status,
    ) ||
    report.selectedRef ||
    report.humanSelectionId ||
    report.candidates?.length !== 3
  )
    throw Error("Sourced screens need three evaluated, unselected directions");
  const markers = [
    "表の列に候補、行に主操作",
    "候補一覧と広い詳細領域",
    "論点の移動領域と二案",
  ];
  const byLayout = markers.map((marker) => {
    const matches = report.candidates.filter(
      (candidate) =>
        candidate.mechanisms?.some(
          (item) => item.includes(marker) && !negatedMechanism.test(item),
        ) &&
        exactRef(candidate.ref) &&
        Array.isArray(candidate.evaluation) &&
        candidate.evaluation.length > 0,
    );
    if (matches.length !== 1)
      throw Error("Saved S10/S11 does not identify one sourced layout");
    return matches[0];
  });
  if (new Set(byLayout.map((item) => item.ref.artifactId)).size !== 3)
    throw Error("Saved S10 directions overlap between sourced layouts");
  const fields = byLayout[0].evaluation
    .filter(
      (item) =>
        item.criterion &&
        item.reason &&
        byLayout.every((candidate) =>
          candidate.evaluation.some(
            (peer) => peer.criterion === item.criterion && peer.reason,
          ),
        ),
    )
    .slice(0, 6)
    .map((item) => item.criterion);
  if (fields.length < 2)
    throw Error("Saved S11 lacks common sourced judgment criteria");
  const candidates = byLayout.map((candidate, index) => ({
    ...candidate,
    name: ["A", "B", "C"][index],
    index,
    runId: report.runId,
    selected: false,
    fields: Object.fromEntries([
      ...fields.map((field) => [
        field,
        candidate.evaluation.find((item) => item.criterion === field).reason,
      ]),
      ["向く条件と代償", candidate.summary],
    ]),
  }));
  const allFields = Object.keys(candidates[0].fields);
  const screens = [
    screen(
      "a",
      "A",
      "共通項目の比較表",
      "未選択の比較案",
      matrixScreen(candidates, allFields, report, brief),
    ),
    screen(
      "b",
      "B",
      "一覧と広い単案詳細",
      "未選択の比較案",
      sourcedListScreen(candidates, allFields, report, brief),
    ),
    screen(
      "c",
      "C",
      "論点別の二案対照",
      "未選択の比較案",
      sourcedPairScreen(candidates, allFields, report, brief),
    ),
  ].join("");
  const hash = createHash("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>3つの候補画面を比較 · Mimic</title><style>${style}${sourcedStyle}</style></head><body><main class="index" data-real-screens="unselected"><header class="index-head"><div><span class="eyebrow">MIMIC / DESIGN REVIEW</span><h1>3つの画面を、同じ内容で試す</h1><p>3案とも人の選択前です。画面内の仮選択は保存されず、最終採用・公開も未承認です。</p></div><aside class="source-note">Mimic S10/S11 の保存済み構造と評価を使い、Codex が画面を設計・実装しました。完成画面画像とブランド適合は未検証です。</aside></header><div class="screens">${screens}</div></main><script>${script}</script></body></html>`;
}

function renderComparisonScreensHtml(report, brief, expectedRef, unselected) {
  if (
    !unselected &&
    (!report?.humanSelectionId ||
      !sameRef(report.selectedRef, expectedRef) ||
      !/^sha256:[a-f0-9]{64}$/.test(expectedRef?.lockDigest ?? ""))
  )
    throw Error("Real screens need the verified exact human working choice");
  if (
    unselected &&
    (!report ||
      !["awaiting-human-selection", "awaiting-working-selection"].includes(
        report.status,
      ) ||
      report.selectedRef ||
      report.humanSelectionId ||
      report.condition !== "guided")
  )
    throw Error(
      "Unselected screens need a complete guided Run awaiting human choice",
    );
  // This sketch depicts Mimic's own design comparison workflow. S10 can also
  // describe unrelated products; a matching layout word alone is insufficient.
  if (unselected && !matchesComparisonBrief(brief))
    throw Error(
      "Unselected screen sketch only supports the Mimic design comparison brief",
    );
  const byName = new Map();
  const markers = [
    "候補を列、共通判断項目を行",
    "二つの比較枠",
    "項目単位で確認",
  ];
  const negated =
    /使わず|使わない|用いない|採用しない|避ける|ではなく|不採用|排除|代わりに|しない|\b(?:not|without|avoid|exclude|instead of)\b/iu;
  for (const candidate of report.candidates ?? []) {
    let name;
    if (unselected) {
      const matches = markers.flatMap((marker, index) =>
        candidate.mechanisms?.some(
          (item) => !negated.test(item) && item.includes(marker),
        )
          ? ["A", "B", "C"][index]
          : [],
      );
      if (matches.length !== 1)
        throw Error(
          "Saved S10 mechanism does not identify one supported screen layout",
        );
      name = matches[0];
    } else name = candidate.summary?.match(/^案([ABC])/u)?.[1];
    if (!name || byName.has(name))
      throw Error("Expected distinct saved A/B/C directions");
    byName.set(name, candidate);
  }
  if (
    !unselected &&
    (byName.size !== 3 || !sameRef(byName.get("A")?.ref, expectedRef))
  )
    throw Error("Expected the selected saved A direction and B/C comparisons");
  if (unselected && byName.size !== 3)
    throw Error("Unselected screens need three distinct saved layouts");
  if (
    !brief?.content?.some(
      (item) => item.policy === "fixed-fact" && item.text === "改訂は最大2回",
    ) ||
    !brief.content.some(
      (item) => item.policy === "fixed-copy" && item.text === "候補を比較",
    )
  ) {
    if (
      !unselected ||
      !brief?.content?.some(
        (item) => item.policy === "fixed-fact" && item.text?.trim(),
      ) ||
      !brief.content.some(
        (item) => item.policy === "fixed-copy" && item.text?.trim(),
      )
    )
      throw Error("Real screens need the saved fixed fact and copy");
  }
  const commonCriteria = (byName.get("A").evaluation ?? [])
    .filter((item) => item.criterion)
    .slice(0, unselected ? 6 : 5)
    .map((item) => item.criterion);
  const expectedCriteria = [
    "共通判断項目の可視性",
    "AI の推奨理由と未確定事項の分離・到達性",
    "対象・関係・現在の選択と復帰の連続性",
    "明示選択と改訂前の再確認",
    "情報量・不要情報と次の操作",
  ];
  if (
    !unselected &&
    JSON.stringify(commonCriteria) !== JSON.stringify(expectedCriteria)
  )
    throw Error("Saved S11 packet lacks five common judgment criteria");
  if (
    unselected &&
    (commonCriteria.length < 2 ||
      ["B", "C"].some((name) =>
        commonCriteria.some(
          (criterion) =>
            !byName
              .get(name)
              .evaluation?.some(
                (item) => item.criterion === criterion && item.reason,
              ),
        ),
      ))
  )
    throw Error("Saved S11 packet lacks common judgment criteria");
  const candidates = ["A", "B", "C"].map((name, index) => {
    const candidate = byName.get(name);
    if (
      !unselected &&
      !candidate.mechanisms?.some((item) => item.includes(markers[index]))
    )
      throw Error(`Saved direction ${name} lacks its structural mechanism`);
    if (!Array.isArray(candidate.evaluation) || !exactRef(candidate.ref))
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
      selected: !unselected && name === "A",
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
      unselected ? "未選択の比較案" : "作業用ベース",
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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>3つの実画面を比較 · Mimic</title><style>${style}</style></head><body><main class="index" data-real-screens="${unselected ? "unselected" : "unapproved"}"><header class="index-head"><div><span class="eyebrow">MIMIC / DESIGN REVIEW</span><h1>3つの画面を、同じ内容で試す</h1><p>${unselected ? "3案とも人の選択前です。画面内の仮選択は保存されず、最終採用・公開も未承認です。" : "Aは人が改訂元に選んだ構造案です。BとCは未選択の比較候補。どの画面も最終採用・公開は未承認です。"}</p></div><aside class="source-note">Mimic S10/S11 の保存済み構造と評価を使い、Codex が画面を設計・実装しました。Mimic が完成UIを生成したものではありません。</aside></header><div class="screens">${screens}</div></main><script>${script}</script></body></html>`;
}

/** An unselected A revision shown as an operable Codex sketch using saved Mimic directions. */
export function renderRevisionScreenHtml(base, revision, brief) {
  const baseRef = base?.selectedRef;
  const baseA = base?.candidates?.find((item) => sameRef(item.ref, baseRef));
  const revised = revision?.candidates?.[0];
  const nextRef = revised?.ref;
  if (
    !base?.humanSelectionId ||
    !exactRef(baseRef) ||
    !exactRef(nextRef) ||
    !baseA?.mechanisms?.some((item) =>
      item.includes("候補を列、共通判断項目を行"),
    ) ||
    revision?.previousRunId !== base.runId ||
    revision.status !== "awaiting-human-selection" ||
    revision.invalidRevisionRefs?.length ||
    revision.unrelatedRevisionRefs?.length ||
    !revision.priorSelectedRefs?.some((ref) => sameRef(ref, baseRef)) ||
    revision.selectedRef ||
    revision.humanSelectionId ||
    revision.candidates?.length !== 1 ||
    nextRef?.artifactId !== baseRef?.artifactId ||
    nextRef?.revision !== baseRef.revision + 1 ||
    !Array.isArray(revised.evaluation) ||
    !revised.evaluation.length ||
    !revised.mechanisms?.some((item) =>
      item.includes("候補を列、共通判断項目を行"),
    ) ||
    !brief?.content?.some(
      (item) => item.policy === "fixed-fact" && item.text === "改訂は最大2回",
    ) ||
    !brief.content.some(
      (item) => item.policy === "fixed-copy" && item.text === "候補を比較",
    )
  )
    throw Error(
      "Revision screen needs the selected exact A base and one unselected exact revision",
    );
  const baseCandidates = ["二つの比較枠", "項目単位で確認"].map((marker) =>
    base.candidates.filter((item) =>
      item.mechanisms?.some((text) => text.includes(marker)),
    ),
  );
  if (
    base.candidates.length !== 3 ||
    baseCandidates.some(
      ([item, duplicate]) =>
        !item ||
        duplicate ||
        !exactRef(item.ref) ||
        !Array.isArray(item.evaluation) ||
        sameRef(item.ref, baseRef),
    ) ||
    sameRef(baseCandidates[0][0].ref, baseCandidates[1][0].ref)
  )
    throw Error("Revision screen needs the saved B/C comparison context");
  const candidates = [revised, ...baseCandidates.map(([item]) => item)].map(
    (item, index) => ({
      ...item,
      name: ["A", "B", "C"][index],
      index,
    }),
  );
  const rows = [
    ["主操作と構造", (item) => item.mechanisms[item.name === "A" ? 1 : 0]],
    ["向く条件・利点・失うもの", (item) => item.summary],
    [
      "詳細と比較への復帰",
      (item) => item.mechanisms[item.name === "A" ? 2 : 1],
    ],
    ["選択と改訂", (item) => item.mechanisms[item.name === "A" ? 4 : 2]],
    [
      "評価上の懸念",
      (item) =>
        item.evaluation.find((finding) => finding.state === "CONCERN")
          ?.reason ?? "未提供",
    ],
    [
      "未確定事項",
      (item) =>
        item.evaluation.find((finding) => finding.state === "UNVERIFIED")
          ?.reason ?? "未確認",
    ],
  ];
  const short = (text) => escape(lead(text));
  const cellText = (name, item, read) =>
    name === "向く条件・利点・失うもの"
      ? escape(read(item))
      : short(read(item));
  const heading = (item) =>
    `候補${item.name}${item.name === "A" ? " · 改稿候補（未選択）" : " · 比較用（未選択）"}`;
  const table = `<table><thead><tr><th scope="col">共通項目</th>${candidates.map((item) => `<th scope="col">${escape(heading(item))}</th>`).join("")}</tr></thead><tbody>${rows.map(([name, read]) => `<tr><th scope="row">${escape(name)}</th>${candidates.map((item) => `<td>${cellText(name, item, read)}<button type="button" data-detail="${item.index}">詳細を見る</button></td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const mobile = rows
    .map(
      ([name, read]) =>
        `<section class="row-card"><h3>${escape(name)}</h3>${candidates.map((item) => `<div><strong>${escape(heading(item))}</strong><p>${cellText(name, item, read)}</p><button type="button" data-detail="${item.index}">詳細を見る</button></div>`).join("")}</section>`,
    )
    .join("");
  const detail = candidates
    .map(
      (item) =>
        `<section id="detail-${item.index}" class="detail" hidden><button type="button" data-back>比較に戻る</button><p class="context">Run ${escape(item.name === "A" ? revision.runId : base.runId)} · ${escape(heading(item))}</p><h2>${escape(heading(item))}</h2><p>${escape(item.summary)}</p><ul>${item.mechanisms.map((part) => `<li>${escape(part)}</li>`).join("")}</ul><p>${escape(item.rationale?.join(" / ") ?? "未提供")}</p><details><summary>S11評価と出典</summary><pre>${escape(JSON.stringify({ ref: item.ref, evaluation: item.evaluation, verification: item.verification }, null, 2))}</pre></details></section>`,
    )
    .join("");
  const recommendation =
    Array.isArray(revision.proposedDecisions) &&
    revision.proposedDecisions.length
      ? revision.proposedDecisions
          .map(
            (item) =>
              `<p>${escape(item.summary)} · ${escape(item.suggestedChoice)}</p>`,
          )
          .join("")
      : "<p>AIの推奨提案: 未取得</p>";
  const js = `let trialChoice = null;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-detail')) {
      document.querySelector('#comparison').hidden = true;
      document.querySelectorAll('.detail').forEach((panel) => { panel.hidden = true; });
      const panel = document.querySelector('#detail-' + button.dataset.detail);
      if (panel) { panel.hidden = false; panel.scrollIntoView(); }
    } else if (button.hasAttribute('data-back')) {
      button.closest('.detail').hidden = true;
      document.querySelector('#comparison').hidden = false;
      document.querySelector('#comparison').scrollIntoView();
    } else if (button.hasAttribute('data-try-choice')) {
      trialChoice = button.dataset.tryChoice;
      document.querySelector('#trial-status').textContent = '画面内で仮に選んだ案: 候補' + button.dataset.tryChoice + '（保存なし。現在の作業用ベースはA@${baseRef.revision}）';
      document.querySelector('#selection-guidance').hidden = true;
    } else if (button.id === 'try-revision') {
      if (!trialChoice) {
        document.querySelector('#selection-guidance').hidden = false;
      } else {
        document.querySelector('#trial-revision-target').textContent = '画面内で仮に選んだ候補' + trialChoice + '。保存された作業用ベースはA@${baseRef.revision}のままです。';
        document.querySelector('#revision-check').hidden = false;
      }
    }
  });`;
  const hash = createHash("sha256").update(js).digest("base64");
  const css = `*{box-sizing:border-box}body{margin:0;background:#eef2ee;color:#18352e;font:16px/1.5 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:24px}h1{font-size:clamp(28px,4vw,44px);margin:0 0 8px}h2{margin:0 0 14px}.intro,.panel,.detail,.row-card{background:white;border:1px solid #cbdcd0;padding:20px;margin:16px 0}.intro{border-top:5px solid #287567}.eyebrow,.context{font-size:13px;color:#50685e}.context{margin:6px 0}.action{font-weight:700;color:#0b604d}.notice{background:#fff5de;border-left:4px solid #b57816;padding:12px;margin:16px 0}.desktop{overflow-x:auto}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #d1ddd4;padding:14px;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{background:#e3efe6}tbody th{width:17%;background:#f3f7f3}td{font-size:14px}button{display:block;margin:12px 0 0;border:1px solid #176454;background:white;color:#176454;padding:9px 12px;font:inherit;cursor:pointer}button:hover{background:#e4f1e9}button:focus-visible,summary:focus-visible{outline:3px solid #bb791b;outline-offset:2px}.mobile{display:none}.row-card>div{border-top:1px solid #d1ddd4;padding:12px 0}.row-card p{margin:6px 0}.detail{max-width:880px}.detail li{margin:12px 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}[hidden]{display:none!important}@media(max-width:700px){main{padding:14px}.desktop{display:none}.mobile{display:block}}`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>候補を比較 · A改稿プレビュー</title><style>${css}</style></head><body><main data-revision-screen="unapproved"><header class="intro"><p class="eyebrow">MIMIC / A REVISION PREVIEW</p><h1>候補を比較</h1><p>違いを比較して改訂元を確認する</p><p class="context">対象Run ${escape(revision.runId)} · 現在の利用者の選択: 作業用A@${baseRef.revision} · 改稿A@${nextRef.revision}: 未選択</p><p class="action">次の操作: 共通項目で候補を読み、必要なら改稿Aを仮選択して改善対象を確認する</p><p>改訂は最大2回 · 選んだ案を改善する</p></header><p class="notice">保存済みS10の構造案をCodexのレンダラーが操作画面にした未承認の試作です。改稿Aは人が採用していません。操作は画面内の試用でRunの選択記録を変更しません。</p><section id="comparison" class="panel"><h2>共通項目で比較</h2><p>候補Aの改稿と、元のRunに保存されたB/Cの方向を同じ項目で照合します。B/Cは親Runの比較資料で、この改稿Runでは選択できません。</p><div class="desktop">${table}</div><div class="mobile">${mobile}</div><h2>AIの推奨提案</h2>${recommendation}<p>AIの提案は人の選択ではありません。</p><h2>改稿候補を試す</h2><button type="button" data-try-choice="A">改稿候補Aを画面内で仮選択</button><p id="trial-status" role="status">画面内の仮選択: なし（保存なし）</p><button id="try-revision" type="button">改善対象を確認する（試用）</button><p id="selection-guidance" class="notice" hidden>まず改稿候補Aを画面内で仮選択してください。Runの選択記録は変更されません。</p><div id="revision-check" class="notice" hidden><strong>改善対象確認（試用・保存なし）</strong><p id="trial-revision-target"></p><p>対象Run ${escape(revision.runId)} · 改稿A@${nextRef.revision}は未選択</p><p>改訂は最大2回。実際の開始と残回数は未検証です。</p></div></section>${detail}<section class="panel"><h2>関係と未確定事項</h2><p>親Run ${escape(base.runId)} → 改稿Run ${escape(revision.runId)}。現在の選択は元のA@${baseRef.revision}のままです。</p><p>ブランド適合、選択の手間、利用者の満足度は未測定。390pxの利用者操作は人による確認前です。</p><details><summary>履歴・出典の詳細</summary><pre>${escape(JSON.stringify({ baseSelection: baseRef, revision: nextRef, evaluation: revised.evaluation }, null, 2))}</pre></details></section></main><script>${js}</script></body></html>`;
}
