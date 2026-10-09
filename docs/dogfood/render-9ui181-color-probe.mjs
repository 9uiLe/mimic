import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(path.join(dir, "9ui181-color-probe-output.json.raw"), "utf8"),
);
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const titles = {
  "warm-core-quiet-surfaces": "Warm core / quiet work",
  "sparse-signature-moments": "Signature moments / restrained canvas",
  "layered-utility-minimal-chroma": "Layered utility / minimal chroma",
};
const roleNames = [
  "text.primary",
  "text.secondary",
  "background",
  "surface",
  "surface.raised",
  "border",
  "link",
  "action.primary",
  "selection",
  "status.in-progress",
  "status.blocked",
  "status.complete",
  "brand.accent",
];
const render = (strategy) => {
  if (!titles[strategy.id]) throw new Error(`Unknown strategy: ${strategy.id}`);
  const variables = roleNames
    .map((role) => {
      const value = strategy.roles[role];
      if (!/^#[0-9a-fA-F]{6}$/.test(value ?? ""))
        throw new Error(`Invalid preview color: ${strategy.id}:${role}`);
      return `--${role.replaceAll(".", "-")}: ${value};`;
    })
    .join(" ");
  return `<section class="strategy" style="${variables}">
    <div class="brand">Mimic <small>Provisional color study</small></div>
    <h2>${escapeHtml(titles[strategy.id])}</h2>
    <div class="work">
      <div class="eyebrow">Current Run · Local monitor redesign</div>
      <div class="run"><strong>Compare design directions</strong><span class="state progress">● In progress</span></div>
      <p class="subtle">Three structural directions share the same task and evidence.</p>
      <div class="candidates">
        <div class="candidate"><strong>Resume Board</strong><span>Current state and next action</span></div>
        <div class="candidate chosen"><strong>Criteria Comparison Studio</strong><span>Common criteria, recommendation and uncertainty</span><em>Proposed recommendation — not human-approved</em></div>
        <div class="candidate"><strong>Run Timeline Investigation View</strong><span>Nested Run diagnosis; no invented event times</span></div>
      </div>
      <div class="raised"><div class="state blocked">● Pending blocker</div><strong>Review the pending blocker</strong><p class="subtle">This is the next action. The proposal has not been adopted.</p><button type="button">Review blocker</button></div>
      <div class="foot"><span class="state complete">● Reference selection complete</span><span class="link">View exact refs →</span></div>
    </div>
    <p class="note">${escapeHtml(strategy.tradeoff)}</p>
  </section>`;
};
const output = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Mimic provisional color comparison</title>
<style>
* { box-sizing: border-box; } body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: #202127; background: #e8e9ec; }
header { max-width: 1500px; margin: auto; padding: 28px 24px 8px; } header h1 { margin: 0; font-size: 1.5rem; } header p { margin: 8px 0; max-width: 900px; }
main { max-width: 1500px; margin: auto; padding: 18px 24px 36px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; align-items: stretch; }
.strategy { min-width: 0; padding: 20px; background: var(--background); color: var(--text-primary); border: 1px solid var(--border); border-top: 7px solid var(--brand-accent); border-radius: 12px; }
.brand { color: var(--brand-accent); font-size: 1.25rem; font-weight: 750; } .brand small { display: block; color: var(--text-secondary); font-size: .72rem; font-weight: 450; }
h2 { font-size: 1.12rem; line-height: 1.2; margin: 18px 0; min-height: 2.4em; }
.work { background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 16px; }
.eyebrow { color: var(--text-secondary); font-size: .76rem; } .run { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin: 9px 0; flex-wrap: wrap; }
.subtle, .candidate span { color: var(--text-secondary); } .subtle { font-size: .82rem; margin: 7px 0 14px; }
.state { font-size: .76rem; font-weight: 650; white-space: nowrap; } .progress { color: var(--status-in-progress); } .blocked { color: var(--status-blocked); margin-bottom: 7px; } .complete { color: var(--status-complete); }
.candidates { display: grid; gap: 8px; margin: 16px 0; }.candidate { background: var(--surface-raised); border: 1px solid var(--border); border-radius: 7px; padding: 10px; display: grid; gap: 2px; }.candidate strong { font-size: .87rem; }.candidate span { font-size: .77rem; }.candidate.chosen { background: var(--selection); }.candidate em { font-size: .71rem; font-style: normal; font-weight: 700; margin-top: 3px; }
.raised { background: var(--surface-raised); border: 1px solid var(--border); border-radius: 7px; padding: 12px; }.raised strong { font-size: .87rem; }button { border: 0; background: var(--action-primary); color: var(--surface-raised); border-radius: 5px; padding: 8px 11px; font: inherit; font-size: .8rem; font-weight: 650; }
.foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 15px; }.link { color: var(--link); font-size: .76rem; font-weight: 650; }.note { color: var(--text-secondary); font-size: .78rem; margin: 14px 0 0; }
@media (max-width: 1040px) { main { grid-template-columns: 1fr; } h2 { min-height: 0; } }
</style></head><body><header><h1>Same content, three provisional color systems</h1><p>Inspect-only synthetic preview from the 9UI-181 model probe. The structure and wording are identical across panels; only role values differ. No brand or direction is approved, and this page is not a Mimic S13 output.</p></header><main>${raw.strategies.map(render).join("\n")}</main></body></html>\n`;
writeFileSync(path.join(dir, "9ui181-color-probe-preview.html"), output);
