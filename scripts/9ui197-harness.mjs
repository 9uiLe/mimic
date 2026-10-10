#!/usr/bin/env node
/** A small plan/review adapter for the existing Mimic Run, Skill and decision contracts. */
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateFile = path.join(repo, "docs/dogfood/9ui183/plan-template.json");
const digest = (text) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const sameContent = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const stagedEvidenceDigests = (manifest) =>
  manifest.evidenceFiles
    ? Object.fromEntries(
        Object.entries(manifest.evidenceFiles).map(([stage, files]) => [
          stage,
          files.map((file) => manifest.evidenceDigests[file]).sort(),
        ]),
      )
    : Object.values(manifest.evidenceDigests ?? {}).sort();
export const captureSettingsDigest = (config) =>
  digest(
    JSON.stringify(
      canonical({
        previewUrls: config.previewUrls ?? {},
        operations: config.operations ?? {},
        requiredSelectors: config.requiredSelectors ?? [],
      }),
    ),
  );
const nonempty = (value) => typeof value === "string" && !!value.trim();
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const exactRef = (ref) =>
  ref &&
  /^art_[A-Za-z0-9_-]+$/.test(ref.artifactId) &&
  Number.isSafeInteger(ref.revision) &&
  ref.revision > 0 &&
  /^sha256:[a-f0-9]{64}$/.test(ref.lockDigest);
const choiceKey = (ref) =>
  `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`;
const sameRef = (a, b) =>
  exactRef(a) && exactRef(b) && choiceKey(a) === choiceKey(b);
const previewUrl = (url) =>
  typeof url === "string" &&
  (/^https:\/\//.test(url) || /^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url));

export function validateBrief(brief) {
  assert(brief && typeof brief === "object", "Missing design brief");
  for (const key of ["audience", "purpose", "primaryAction", "brandCharacter"])
    assert(nonempty(brief[key]), `Missing brief ${key}`);
  assert(
    Array.isArray(brief.requiredInformation) &&
      brief.requiredInformation.length &&
      brief.requiredInformation.every(nonempty),
    "Missing required information",
  );
  assert(
    Array.isArray(brief.content) &&
      brief.content.every(
        (item) =>
          nonempty(item.text) &&
          ["fixed-fact", "fixed-copy", "editable-copy", "confirm"].includes(
            item.policy,
          ),
      ),
    "Invalid content policy",
  );
  assert(
    brief.content.some(
      (item) => item.policy === "fixed-fact" || item.policy === "fixed-copy",
    ),
    "No fixed fact or copy",
  );
  assert(
    Array.isArray(brief.references) &&
      brief.references.every((item) =>
        ["source", "reason", "appliesWhen", "doNotBorrow"].every((key) =>
          nonempty(item[key]),
        ),
      ),
    "Reference needs source, reason, application condition and do-not-borrow rule",
  );
  assert(
    brief.brandColors === undefined ||
      (Array.isArray(brief.brandColors) &&
        brief.brandColors.every(
          (item) => nonempty(item.value) && nonempty(item.source),
        )),
    "Invalid sourced brand colors",
  );
  return brief;
}

export function briefForTask(brief, guided, stage) {
  validateBrief(brief);
  const common = [
    `Audience: ${brief.audience}`,
    `Purpose: ${brief.purpose}`,
    `Primary action: ${brief.primaryAction}`,
    `Required information: ${brief.requiredInformation.join("; ")}`,
    `Brand character: ${brief.brandCharacter}`,
    ...(brief.brandColors ?? []).map(
      (item) => `Brand color ${item.value}: ${item.source}`,
    ),
    ...brief.content.map((item) => `${item.policy}: ${item.text}`),
    "Fixed facts and fixed copy are source material, not text to improve. Confirm entries are unresolved; do not invent an answer.",
    ...(stage === "s10"
      ? [
          "The trial's initial candidate budget is three for either condition; emit fewer if further options would be redundant.",
        ]
      : []),
  ];
  if (!guided) return common.join("\n");
  return [
    ...common,
    "Design intervention: choose information and structure from the user's task and primary action. Do not add impressive but irrelevant statistics, claims or sections.",
    "If sourced brand colors exist, assign text, background and emphasis roles from them with legibility in mind. If a role cannot be justified, mark it unresolved; do not invent brand colors.",
    ...brief.references.map(
      (item) =>
        `Reference ${item.source}: use because ${item.reason}; apply when ${item.appliesWhen}; do not borrow ${item.doNotBorrow}.`,
    ),
    ...(stage === "s10"
      ? [
          "Start with three distinct structural candidates when they are defensible; this is an initial budget, not a quota. Compare information priority, primary action and comparison unit. Keep a conventional structure if it fits. State each option's conditions, benefits and costs. Do not claim human selection.",
        ]
      : []),
    ...(stage === "s11"
      ? [
          "Critique unnecessary information, generic structure and reference misuse by screen location and reason. Keep untested operation and human preference UNVERIFIED. Give a recommendation and trade-offs, never an AI-likeness score or a ban on purple, rounded corners or a font. Human selection is pending.",
        ]
      : []),
  ].join("\n");
}

export function makePlan(template, config) {
  assert(
    Array.isArray(template) && template.length,
    "Missing Mimic plan template",
  );
  assert(
    ["baseline", "guided"].includes(config.condition),
    "Invalid condition",
  );
  assert(
    nonempty(config.runId) &&
      /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(config.runId),
    "Invalid Run ID",
  );
  assert(
    config.previousRunId
      ? /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(config.previousRunId) &&
          config.previousRunId !== config.runId &&
          exactRef(config.baseRef) &&
          nonempty(config.revisionRequest)
      : config.baseRef === undefined && config.revisionRequest === undefined,
    "Revision needs a prior Run, exact chosen base and human revision request",
  );
  assert(
    nonempty(config.model) &&
      config.budget &&
      Number.isSafeInteger(config.budget.maxGenerations) &&
      config.budget.maxGenerations > 0 &&
      Number.isSafeInteger(config.budget.timeoutMs) &&
      config.budget.timeoutMs > 0,
    "Missing model or generation budget",
  );
  assert(
    config.revisionBudget === undefined ||
      (Number.isSafeInteger(config.revisionBudget) &&
        config.revisionBudget >= 0 &&
        config.revisionBudget <= 2),
    "Invalid revision budget",
  );
  validateBrief(config.brief);
  assert(
    nonempty(config.referenceFile) &&
      !path.isAbsolute(config.referenceFile) &&
      !config.referenceFile.split("/").includes(".."),
    "Invalid reference file",
  );
  assert(
    config.evidenceFiles &&
      typeof config.evidenceFiles === "object" &&
      ["s04", "s08"].every(
        (stage) =>
          Array.isArray(config.evidenceFiles[stage]) &&
          config.evidenceFiles[stage].length &&
          config.evidenceFiles[stage].every(nonempty),
      ),
    "Missing system or task evidence files",
  );
  assert(
    template.some((task) => task.id === "s09") &&
      template.some((task) => task.id === "s11"),
    "Missing S09–S11 path",
  );
  return template.map((source) => {
    const task = JSON.parse(JSON.stringify(source));
    task.humanBrief = briefForTask(
      config.brief,
      config.condition === "guided",
      task.id,
    );
    if (config.previousRunId && ["s10", "s11"].includes(task.id))
      task.humanBrief += `\nHuman-selected prior direction: ${choiceKey(config.baseRef)} from Run ${config.previousRunId}. Its accepted content is ${JSON.stringify(config.selectedBase ?? "UNVERIFIED")}. Address only this requested issue: ${config.revisionRequest}. Retain the prior direction unless the issue requires a change. This is revision of the selected direction; do not imply a new human choice.`;
    if (task.id === "s09") task.evidenceFiles = [config.referenceFile];
    else if (config.evidenceFiles[task.id])
      task.evidenceFiles = config.evidenceFiles[task.id];
    return task;
  });
}

/** Checks only exact text that an actual captured screen exposed; absent capture stays UNVERIFIED. */
export function checkLockedContent(brief, capturedText) {
  validateBrief(brief);
  if (capturedText === undefined) return { state: "UNVERIFIED", missing: [] };
  assert(typeof capturedText === "string", "Invalid screen capture");
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = (text) => {
    const start = /^[\p{L}\p{N}]/u.test(text) ? "(?<![\\p{L}\\p{N}])" : "";
    const end = /[\p{L}\p{N}]$/u.test(text) ? "(?![\\p{L}\\p{N}])" : "";
    return new RegExp(`${start}${escape(text)}${end}`, "u").test(capturedText);
  };
  const missing = brief.content
    .filter(
      (item) =>
        ["fixed-fact", "fixed-copy"].includes(item.policy) &&
        !present(item.text),
    )
    .map((item) => item.text);
  return { state: missing.length ? "FAIL" : "PASS", missing };
}
export const operationChanged = (before, after, expectedText) =>
  !before.includes(expectedText) &&
  after !== before &&
  after.includes(expectedText);

/** Registry decisions are trusted only when Mimic recorded an approved human actor. */
export function reviewTrial({
  manifest,
  run,
  artifacts,
  decisions,
  sessions = [],
  captures = {},
  history = [],
}) {
  const candidates = artifacts.filter(
    ({ artifact }) =>
      artifact.meta.type === "design-direction" &&
      artifact.lifecycle.status !== "rejected",
  );
  const evaluations = artifacts.filter(
    ({ artifact }) => artifact.meta.type === "evaluation",
  );
  const pending = artifacts.filter(
    ({ artifact }) =>
      artifact.meta.type === "decision" &&
      artifact.content.outcome === "proposed" &&
      artifact.origin?.actorId === "mimic.s11.direction-evaluator",
  );
  const approved = decisions.filter(
    (decision) =>
      decision.actor?.kind === "human" &&
      decision.outcome === "approved" &&
      Object.values(run.proposals ?? {}).some(
        (proposal) =>
          proposal.id === decision.proposalId &&
          proposal.packetId === decision.packetId &&
          pending.some(({ ref }) => sameRef(proposal.ref, ref)),
      ),
  );
  const recordedDecision = approved.length === 1 ? approved[0] : undefined;
  const choice = recordedDecision?.output?.artifact?.content?.chosenAlternative;
  const selected = candidates.find(({ ref }) => choiceKey(ref) === choice);
  assert(
    Array.isArray(history) && history.every(exactRef),
    "Invalid approved revision history",
  );
  const revisions = candidates.filter(
    ({ artifact }) =>
      artifact.meta.id === selected?.ref.artifactId &&
      artifact.meta.supersedesRevision !== undefined,
  );
  const unrelatedRevisions = candidates.filter(
    ({ artifact }) =>
      artifact.meta.supersedesRevision !== undefined &&
      artifact.meta.id !== selected?.ref.artifactId,
  );
  // A new Run may publish the selected artifact's next revision; count that
  // attempt once, whether represented in history or in local artifact metadata.
  const revisionCount = Math.max(history.length, revisions.length);
  const limit = manifest.revisionBudget ?? 2;
  assert(
    Number.isSafeInteger(limit) && limit >= 0 && limit <= 2,
    "Invalid revision budget",
  );
  const byCandidate = candidates.map(({ ref, artifact }) => {
    const observed = captures[choiceKey(ref)];
    const capture = sameRef(observed?.ref, ref) ? observed : undefined;
    return {
      ref,
      summary: artifact.content.summary,
      mechanisms: artifact.content.mechanisms,
      rationale:
        artifact.provenance
          ?.filter(
            (item) =>
              item.path.startsWith("/content/") && nonempty(item.rationale),
          )
          .slice(0, 3)
          .map((item) => item.rationale) ?? [],
      verification: {
        ...checkLockedContent(manifest.brief, capture?.screenText),
        requiredElements: capture?.requiredElements ?? "UNVERIFIED",
        primaryOperations: capture?.primaryOperations ?? "UNVERIFIED",
        overflow: capture?.overflow ?? "UNVERIFIED",
        screenshot: capture?.screenshot ?? null,
      },
      evaluation:
        evaluations.find(
          ({ artifact: item }) =>
            item.content.target === `${ref.artifactId}@${ref.revision}`,
        )?.artifact.content.findings ?? "UNVERIFIED",
    };
  });
  const stops = sessions
    .filter((session) => session.status === "stopped")
    .map((session) => ({
      sessionId: session.sessionId,
      stop: session.stop ?? "unknown",
    }));
  return {
    runId: manifest.runId,
    condition: manifest.condition,
    status:
      !candidates.length && stops.length
        ? "stopped"
        : !candidates.length
          ? "generating"
          : unrelatedRevisions.length
            ? "unselected-revision"
            : sessions.length &&
                sessions.every((session) => session.status === "stopped") &&
                !pending.length &&
                !recordedDecision
              ? "partial-stopped"
              : !recordedDecision && !pending.length
                ? "evaluating"
                : !recordedDecision
                  ? "awaiting-human-selection"
                  : !selected
                    ? "selection-needs-exact-ref"
                    : revisionCount >= limit
                      ? "revision-limit"
                      : "selected",
    candidates: byCandidate,
    proposedDecisions: pending.map(({ ref, artifact }) => ({
      ref,
      summary: artifact.content.summary,
      suggestedChoice: artifact.content.chosenAlternative ?? null,
    })),
    selectedRef: selected?.ref ?? null,
    humanDecisionId: recordedDecision?.id ?? null,
    unrelatedRevisionRefs: unrelatedRevisions.map(({ ref }) => ref),
    revisionCount,
    revisionBudget: limit,
    priorSelectedRefs: history,
    stops,
    unresolved: manifest.brief.content
      .filter((item) => item.policy === "confirm")
      .map((item) => item.text),
    usage: {
      generationReservations: sessions.reduce(
        (n, session) => n + (session.generationCount ?? 0),
        0,
      ),
      model: sessions.length
        ? sessions.every(
            (session) =>
              session.binding?.settings?.model === manifest.model &&
              session.binding?.settings?.billingMode === "subscription-only",
          )
          ? "MATCH"
          : "MISMATCH"
        : "UNVERIFIED",
      actualGenerationBudget: "UNVERIFIED",
      referenceAndCritiqueCost: "UNVERIFIED",
      humanAnswerTime: "UNMEASURED",
      humanSatisfaction: "UNMEASURED",
    },
  };
}

const htmlEscape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function renderReviewHtml(report, previewUrls = {}) {
  const cards = report.candidates
    .map((candidate) => {
      const url = previewUrls[choiceKey(candidate.ref)];
      const allowed = previewUrl(url);
      const link = allowed
        ? `<a href="${htmlEscape(url)}" target="_blank" rel="noopener noreferrer">指定された操作プレビューを開く（生成関係は未検証）</a>`
        : "操作プレビュー: 未接続";
      const image = candidate.verification.screenshot
        ? `<p><a href="${htmlEscape(candidate.verification.screenshot)}">実画面の撮影を開く</a></p>`
        : "";
      return `<article><h3>${htmlEscape(candidate.summary)}</h3><p>${htmlEscape(candidate.ref.artifactId)}@${candidate.ref.revision}</p><p>${link}</p>${image}<p>事実・固定コピー: <strong>${candidate.verification.state}</strong></p><p>構造: ${htmlEscape(candidate.mechanisms.join("; "))}</p><p>向く条件・利点・失うもの: ${htmlEscape(candidate.rationale.join("; ") || "UNVERIFIED")}</p><details><summary>評価と検査記録</summary><pre>${htmlEscape(JSON.stringify({ verification: candidate.verification, evaluation: candidate.evaluation, ref: candidate.ref }, null, 2))}</pre></details></article>`;
    })
    .join("\n");
  const recommendation =
    report.proposedDecisions
      .map(
        (item) =>
          `<p>${htmlEscape(item.summary)} — 提案: ${htmlEscape(item.suggestedChoice ?? "未特定")}</p>`,
      )
      .join("") || "<p>推奨提案: 未取得</p>";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Mimic 候補レビュー</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#172d28;background:#f4f6f3;margin:0}main{max-width:1200px;margin:auto;padding:24px;overflow-wrap:anywhere}h1{line-height:1.2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:16px}article,section{background:#fff;border:1px solid #d9e4da;border-radius:10px;padding:18px;margin:16px 0}article{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}a{color:#075c4b}small{color:#4d655a}details{margin-top:14px}</style></head><body><main><h1>設計候補を比較する</h1><p>Run ${htmlEscape(report.runId)} · ${htmlEscape(report.condition)} · ${htmlEscape(report.status)}</p><p>AIの提案は人間の選択ではありません。未実行の検査は UNVERIFIED です。</p><section><h2>提案と未確定事項</h2>${recommendation}<p>人間の選択: ${htmlEscape(report.selectedRef?.artifactId ?? "待機中")} · 回答時間/満足度: 未測定</p><p>${htmlEscape(report.unresolved.join("; ") || "要確認事項なし")}</p></section><div class="grid">${cards || "<p>候補はまだありません。</p>"}</div><details><summary>出典・停止・費用の記録</summary><pre>${htmlEscape(JSON.stringify({ stops: report.stops, usage: report.usage, proposedDecisions: report.proposedDecisions, humanDecisionId: report.humanDecisionId }, null, 2))}</pre></details><small>表示は保存済みの exact artifact と実検査記録に基づきます。調査 9UI-191 は効果を実証していません。</small></main></body></html>`;
}

export function compareTrials(left, right) {
  const fixed =
    [left.manifest.condition, right.manifest.condition].sort().join(",") ===
      "baseline,guided" &&
    !left.manifest.previousRunId &&
    !right.manifest.previousRunId &&
    sameContent(left.manifest.brief, right.manifest.brief) &&
    left.manifest.referenceDigest === right.manifest.referenceDigest &&
    left.manifest.templateDigest === right.manifest.templateDigest &&
    sameContent(
      stagedEvidenceDigests(left.manifest),
      stagedEvidenceDigests(right.manifest),
    ) &&
    sameContent(left.manifest.model, right.manifest.model) &&
    sameContent(left.manifest.budget, right.manifest.budget) &&
    (left.manifest.revisionBudget ?? 2) ===
      (right.manifest.revisionBudget ?? 2);
  return {
    matchedDeclaredInputs: fixed,
    observedOutcome: fixed
      ? "UNVERIFIED_UNTIL_BOTH_RUNS_AND_HUMAN_REVIEW"
      : "NOT_COMPARABLE",
    additionalReferenceAndCritiqueCost: "UNVERIFIED",
    humanSelectionTime: "UNMEASURED",
    humanSatisfaction: "UNMEASURED",
  };
}

/** Browser evidence is optional; no capture means no PASS. Actions use declared selectors. */
async function capturePreviews(config, artifacts, workspace) {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch();
  const observations = {};
  try {
    for (const { ref } of artifacts.filter(
      ({ artifact }) => artifact.meta.type === "design-direction",
    )) {
      const key = choiceKey(ref);
      const url = config.previewUrls?.[key];
      if (!previewUrl(url)) continue;
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const screenText = await page.locator("body").innerText();
        const requiredElements = [];
        for (const selector of config.requiredSelectors ?? []) {
          assert(nonempty(selector), "Invalid required selector");
          const matches = await page.locator(selector).all();
          requiredElements.push({
            selector,
            state: (
              await Promise.all(matches.map((item) => item.isVisible()))
            ).some(Boolean)
              ? "PASS"
              : "FAIL",
          });
        }
        const overflow = await page.evaluate(() =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth
            ? "FAIL"
            : "PASS",
        );
        const screenshot = `capture-${config.runId}-${ref.artifactId}-${ref.revision}-${ref.lockDigest.slice(7, 19)}.png`;
        const pixels = await page.screenshot({ fullPage: true });
        await writeFile(path.join(workspace, screenshot), pixels, {
          mode: 0o600,
        });
        const primaryOperations = [];
        for (const operation of config.operations?.[key] ?? []) {
          assert(
            nonempty(operation.selector) &&
              nonempty(operation.resultSelector) &&
              nonempty(operation.expectedText),
            "Invalid operation check",
          );
          try {
            const result = page.locator(operation.resultSelector).first();
            const before = (await result.count())
              ? await result.innerText()
              : "";
            await page.locator(operation.selector).click({ timeout: 3000 });
            await expect(result).toContainText(operation.expectedText, {
              timeout: 3000,
            });
            const after = await result.innerText();
            primaryOperations.push({
              selector: operation.selector,
              resultSelector: operation.resultSelector,
              state: operationChanged(before, after, operation.expectedText)
                ? "PASS"
                : "FAIL",
            });
          } catch {
            primaryOperations.push({
              selector: operation.selector,
              state: "FAIL",
            });
          }
        }
        observations[key] = {
          ref,
          url,
          screenText,
          requiredElements: requiredElements.length
            ? requiredElements
            : "UNVERIFIED",
          primaryOperations: primaryOperations.length
            ? primaryOperations
            : "UNVERIFIED",
          overflow,
          screenshot,
          screenshotDigest: digest(pixels),
        };
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return observations;
}

async function acceptedRun(workspace, runId) {
  const file = path.join(workspace, ".mimic/workspace.json");
  const before = await readFile(file, "utf8");
  const saved = JSON.parse(before);
  const run = saved.registry.runs[runId];
  assert(run, "Run not found");
  const { artifactDigest } =
    await import("../packages/core/dist/artifact-canonical.js");
  const artifacts = run.artifacts.map((ref) => {
    assert(exactRef(ref), "Invalid artifact ref");
    const record = JSON.parse(
      saved.snapshots[`${ref.artifactId}@${ref.revision}`],
    );
    assert(
      record?.artifact && artifactDigest(record.artifact) === ref.lockDigest,
      "Artifact lock mismatch",
    );
    return { ref, artifact: record.artifact };
  });
  const decisions = Object.values(saved.registry.decisions).filter(
    (decision) => saved.registry.packets[decision.packetId]?.runId === runId,
  );
  const sessions = [];
  let sessionNames = [];
  try {
    sessionNames = await readdir(path.join(workspace, ".mimic/agent-sessions"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let sessionPlanDigest;
  let sessionStore;
  for (const name of sessionNames) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name)) continue;
    if (!sessionStore) {
      const { FileSessionStore } =
        await import("../apps/cli/dist/agent/session.js");
      sessionStore = new FileSessionStore(workspace);
    }
    const checkpoint = await sessionStore.read(name.slice(0, -5));
    if (checkpoint?.binding?.runId !== runId) continue;
    if (!sessionPlanDigest) {
      const { preflightPlan } = await import("../apps/cli/dist/plan.js");
      const { canonicalJson } =
        await import("../packages/core/dist/artifact-canonical.js");
      const scopeConfig = JSON.parse(
        await readFile(path.join(workspace, ".mimic/config.json"), "utf8"),
      );
      const plan = JSON.parse(
        await readFile(
          path.join(workspace, `.mimic/runs/${runId}.json`),
          "utf8",
        ),
      );
      const normalized = preflightPlan(
        plan,
        scopeConfig.scopes,
        scopeConfig.defaultScope,
      );
      const packages = new Map();
      for (const entry of await readdir(path.join(workspace, "skills"), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const content = await readFile(
          path.join(workspace, "skills", entry.name, "manifest.yaml"),
          "utf8",
        );
        const skillId = content.match(/^\s*"skillId":\s*"([^"]+)"/m)?.[1];
        assert(skillId && !packages.has(skillId), "Invalid Skill mapping");
        packages.set(skillId, `skills/${entry.name}`);
      }
      const bindings = Object.fromEntries(
        normalized.map((task) => {
          const location = packages.get(task.skillId);
          assert(location, "Missing Skill package");
          return [task.id, location];
        }),
      );
      sessionPlanDigest = createHash("sha256")
        .update(canonicalJson({ tasks: normalized, packages: bindings }))
        .digest("hex");
    }
    assert(
      checkpoint.binding.planDigest === sessionPlanDigest &&
        checkpoint.binding.settings?.provider === "codex" &&
        checkpoint.binding.settings?.billingMode === "subscription-only",
      "Session checkpoint does not bind to the authorized Run plan",
    );
    sessions.push(checkpoint);
  }
  assert(
    before === (await readFile(file, "utf8")),
    "Workspace changed during review",
  );
  return { run, artifacts, decisions, sessions };
}

/** Re-read each prior Run's actual human decision; a config ref alone is never proof. */
export async function approvedHistory(workspace, manifest) {
  const history = [];
  const seen = new Set([manifest.runId]);
  let child = manifest;
  let baseContent;
  while (child.previousRunId) {
    assert(!seen.has(child.previousRunId), "Revision Run cycle");
    seen.add(child.previousRunId);
    assert(
      history.length < (manifest.revisionBudget ?? 2),
      "Revision budget exhausted",
    );
    const prior = JSON.parse(
      await readFile(
        path.join(workspace, `trial-${child.previousRunId}.json`),
        "utf8",
      ),
    );
    assert(
      prior.runId === child.previousRunId &&
        prior.condition === manifest.condition &&
        sameContent(prior.brief, manifest.brief) &&
        prior.model === manifest.model &&
        sameContent(prior.budget, manifest.budget) &&
        (prior.revisionBudget ?? 2) === (manifest.revisionBudget ?? 2) &&
        prior.referenceDigest === manifest.referenceDigest &&
        sameContent(
          stagedEvidenceDigests(prior),
          stagedEvidenceDigests(manifest),
        ) &&
        prior.templateDigest === manifest.templateDigest,
      "Revision changes frozen trial inputs",
    );
    const priorPlan = await readFile(
      path.join(workspace, `tasks-${prior.runId}.json`),
      "utf8",
    );
    assert(digest(priorPlan) === prior.planDigest, "Prior plan changed");
    const priorRunPlan = JSON.parse(
      await readFile(
        path.join(workspace, `.mimic/runs/${prior.runId}.json`),
        "utf8",
      ),
    );
    assert(
      JSON.stringify(JSON.parse(priorPlan)) === JSON.stringify(priorRunPlan),
      "Prior Run did not use prepared plan",
    );
    const snapshot = await acceptedRun(workspace, prior.runId);
    const report = reviewTrial({ manifest: prior, ...snapshot });
    assert(
      report.humanDecisionId && sameRef(child.baseRef, report.selectedRef),
      "Revision base lacks matching human-approved exact choice",
    );
    if (baseContent === undefined) {
      baseContent = snapshot.artifacts.find(({ ref }) =>
        sameRef(ref, report.selectedRef),
      )?.artifact.content;
      assert(
        baseContent && JSON.stringify(baseContent).length <= 30000,
        "Selected base content unavailable or too long",
      );
    }
    history.unshift(report.selectedRef);
    child = prior;
  }
  return { refs: history, baseContent };
}

async function main(args) {
  const [command, configPath] = args;
  assert(
    ["prepare", "capture", "review", "compare"].includes(command) && configPath,
    "Usage: node scripts/9ui197-harness.mjs <prepare|capture|review|compare> <config.json> [other-config.json]",
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (command === "compare") {
    const otherPath = args[2];
    assert(otherPath, "Missing second trial config");
    const other = JSON.parse(await readFile(otherPath, "utf8"));
    const left = JSON.parse(
      await readFile(
        path.join(config.workspace, `trial-${config.runId}.json`),
        "utf8",
      ),
    );
    const right = JSON.parse(
      await readFile(
        path.join(other.workspace, `trial-${other.runId}.json`),
        "utf8",
      ),
    );
    console.log(
      JSON.stringify(
        compareTrials({ manifest: left }, { manifest: right }),
        null,
        2,
      ),
    );
    return;
  }
  assert(path.isAbsolute(config.workspace), "Workspace must be absolute");
  const workspace = await realpath(config.workspace);
  assert(
    (await realpath(configPath)).startsWith(`${workspace}${path.sep}`),
    "Config must be inside workspace",
  );
  if (command === "prepare") {
    const template = JSON.parse(await readFile(templateFile, "utf8"));
    let plan = makePlan(template, config);
    await readFile(path.join(workspace, ".mimic/config.json"), "utf8");
    let current = { registry: { runs: {} } };
    try {
      current = JSON.parse(
        await readFile(path.join(workspace, ".mimic/workspace.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert(
      config.previousRunId
        ? current.registry?.runs?.[config.previousRunId] &&
            !current.registry?.runs?.[config.runId]
        : !Object.keys(current.registry?.runs ?? {}).length,
      "Initial trial needs a fresh workspace; revision needs its prior Run",
    );
    const reference = path.resolve(workspace, config.referenceFile);
    assert(
      reference.startsWith(`${workspace}${path.sep}`),
      "Reference escapes workspace",
    );
    assert((await realpath(reference)) === reference, "Reference path changed");
    const referenceBytes = await readFile(reference);
    const evidenceDigests = {};
    for (const name of Object.values(config.evidenceFiles).flat()) {
      const file = path.resolve(workspace, name);
      assert(
        file.startsWith(`${workspace}${path.sep}`),
        "Evidence escapes workspace",
      );
      assert((await realpath(file)) === file, "Evidence path changed");
      evidenceDigests[name] = digest(await readFile(file));
    }
    const manifest = {
      ...config,
      referenceDigest: digest(referenceBytes),
      evidenceDigests,
      templateDigest: digest(await readFile(templateFile)),
      revisionBudget: config.revisionBudget ?? 2,
    };
    const history = await approvedHistory(workspace, manifest);
    if (config.previousRunId)
      plan = makePlan(template, {
        ...config,
        selectedBase: history.baseContent,
      });
    const planText = JSON.stringify(plan, null, 2) + "\n";
    await writeFile(
      path.join(workspace, `tasks-${config.runId}.json`),
      planText,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(workspace, `trial-${config.runId}.json`),
      JSON.stringify({ ...manifest, planDigest: digest(planText) }, null, 2) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        runId: config.runId,
        condition: config.condition,
        plan: `tasks-${config.runId}.json`,
        next: "Execute with the existing mimic run and authorized subscription session dispatcher. Human selection uses mimic decide.",
      }),
    );
  } else {
    const manifest = JSON.parse(
      await readFile(
        path.join(workspace, `trial-${config.runId}.json`),
        "utf8",
      ),
    );
    assert(
      digest(
        await readFile(path.join(workspace, `tasks-${config.runId}.json`)),
      ) === manifest.planDigest,
      "Prepared plan changed",
    );
    const preparedPlan = JSON.parse(
      await readFile(
        path.join(workspace, `tasks-${config.runId}.json`),
        "utf8",
      ),
    );
    const actualPlan = JSON.parse(
      await readFile(
        path.join(workspace, `.mimic/runs/${config.runId}.json`),
        "utf8",
      ),
    );
    assert(
      JSON.stringify(preparedPlan) === JSON.stringify(actualPlan),
      "Run does not use prepared plan",
    );
    assert(
      digest(
        await readFile(path.resolve(workspace, manifest.referenceFile)),
      ) === manifest.referenceDigest,
      "Reference changed",
    );
    for (const [name, hash] of Object.entries(manifest.evidenceDigests))
      assert(
        digest(await readFile(path.resolve(workspace, name))) === hash,
        "Evidence changed",
      );
    const snapshot = await acceptedRun(workspace, config.runId);
    const history = await approvedHistory(workspace, manifest);
    if (command === "capture") {
      const observations = await capturePreviews(
        config,
        snapshot.artifacts,
        workspace,
      );
      await writeFile(
        path.join(workspace, `capture-${config.runId}.json`),
        JSON.stringify(
          {
            runId: config.runId,
            artifactRefs: snapshot.artifacts.map(({ ref }) => ref),
            settingsDigest: captureSettingsDigest(config),
            observations,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          runId: config.runId,
          captured: Object.keys(observations),
        }),
      );
      return;
    }
    let captures = {};
    let captureState = "NOT_CAPTURED";
    try {
      const capture = JSON.parse(
        await readFile(
          path.join(workspace, `capture-${config.runId}.json`),
          "utf8",
        ),
      );
      assert(
        capture.runId === config.runId &&
          JSON.stringify(capture.artifactRefs) ===
            JSON.stringify(snapshot.artifacts.map(({ ref }) => ref)),
        "Capture does not bind current artifacts",
      );
      if (capture.settingsDigest !== captureSettingsDigest(config)) {
        captureState = "STALE_SETTINGS";
      } else {
        for (const [key, observation] of Object.entries(capture.observations)) {
          assert(
            exactRef(observation.ref) && key === choiceKey(observation.ref),
            "Capture key is not an exact ref",
          );
          const expectedName = `capture-${config.runId}-${observation.ref.artifactId}-${observation.ref.revision}-${observation.ref.lockDigest.slice(7, 19)}.png`;
          assert(
            observation.screenshot === expectedName,
            "Capture screenshot name changed",
          );
          const imagePath = path.join(workspace, expectedName);
          assert(
            (await realpath(imagePath)) === imagePath &&
              digest(await readFile(imagePath)) ===
                observation.screenshotDigest,
            "Capture screenshot changed",
          );
        }
        captures = capture.observations;
        captureState = "BOUND";
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const report = reviewTrial({
      manifest,
      ...snapshot,
      captures,
      history: history.refs,
    });
    report.captureState = captureState;
    const html = renderReviewHtml(report, config.previewUrls);
    const reviewPath = path.join(workspace, `review-${config.runId}.html`);
    await writeFile(reviewPath, html, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reviewPath }, null, 2));
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
