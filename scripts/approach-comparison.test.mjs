import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { preflightPlan } from "../apps/cli/dist/plan.js";
import { artifactDigest, canonicalJson } from "../packages/core/dist/index.js";
import { makePlan, prepare, report } from "./approach-comparison.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repo, "docs/dogfood/9ui183/plan-template.json");
const seal = (checkpoint) => ({
  digest: createHash("sha256").update(canonicalJson(checkpoint)).digest("hex"),
  checkpoint,
});

test("matched comparison freezes one common upstream and three isolated branches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-approach-test-"));
  await mkdir(path.join(root, ".mimic"));
  await mkdir(path.join(root, "inputs"));
  await writeFile(
    path.join(root, ".mimic/config.json"),
    JSON.stringify({
      defaultScope: "org_local",
      scopes: [{ level: "organization", ownerId: "org_local" }],
    }),
  );
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({
      registry: { events: [], runs: {} },
      snapshots: {},
    }),
  );
  await writeFile(
    path.join(root, "inputs/page.html"),
    "<main>Fixed snapshot</main>\n",
  );
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {
    recursive: true,
  });
  await cp(path.join(repo, "schemas"), path.join(root, "schemas"), {
    recursive: true,
  });
  const cfg = {
    workspace: root,
    cohortId: "test_compare",
    planTemplate: template,
    model: "gpt-6-luna",
    reasoningEffort: "low",
    dispatchSettings: {
      executable: "/usr/local/bin/codex",
      maxGenerations: 1,
      timeoutMs: 120000,
      maxOutputBytes: 4000000,
    },
    brief: "Compare three structures.",
    pageEvidenceFiles: ["inputs/page.html"],
    traitIds: ["trait:smarthr-table", "trait:google-expressive"],
    assessments: [
      {
        caseId: "case:smarthr-table",
        role: "near",
        structuralFit: "high",
        contextDistance: "low",
        rationale: "A fixed attribute table may support a choice.",
        evidenceRefs: ["obs:smarthr-table", "hyp:smarthr-table"],
      },
      {
        caseId: "case:google-expressive",
        role: "anti-reference",
        structuralFit: "low",
        contextDistance: "high",
        rationale: "Decorative emphasis can crowd out comparison data.",
        evidenceRefs: ["obs:google-expressive", "hyp:google-expressive"],
      },
    ],
    limit: 1,
  };
  await assert.rejects(
    prepare({ ...cfg, cohortId: "x".repeat(77) }),
    /Invalid cohort ID/,
  );
  await assert.rejects(
    prepare({ ...cfg, pageEvidenceFiles: [] }),
    /Missing comparison settings/,
  );
  await assert.rejects(
    prepare({ ...cfg, pageEvidenceFiles: ["./inputs/page.html"] }),
    /Invalid evidence path/,
  );
  await symlink("page.html", path.join(root, "inputs/page-link.html"));
  await assert.rejects(
    prepare({ ...cfg, pageEvidenceFiles: ["inputs/page-link.html"] }),
    /Linked or escaped evidence/,
  );
  await rm(path.join(root, "inputs/page-link.html"));
  await writeFile(
    path.join(root, "inputs/oversize.html"),
    "x".repeat(1024 * 1024 + 1),
  );
  await assert.rejects(
    prepare({ ...cfg, pageEvidenceFiles: ["inputs/oversize.html"] }),
    /Evidence file too large/,
  );
  await rm(path.join(root, "inputs/oversize.html"));
  const fullGraph = JSON.parse(
    await readFile(path.join(repo, "knowledge/seed/graph.json"), "utf8"),
  );
  await assert.rejects(
    prepare({
      ...cfg,
      cohortId: "test_over_budget",
      assessments: fullGraph.nodes
        .filter((node) => node.kind === "case")
        .map((node) => ({
          caseId: node.id,
          role: "adjacent",
          structuralFit: "medium",
          contextDistance: "medium",
          rationale: "Preflight the complete corpus budget.",
          evidenceRefs: node.evidenceRefs,
        })),
    }),
    /reference evidence exceeds the bounded comparison budget/,
  );
  await assert.rejects(
    readFile(path.join(root, "inputs/test_over_budget-corpus-inventory.json")),
    { code: "ENOENT" },
  );
  const manifest = await prepare(cfg);
  assert.ok(Object.keys(manifest.compiledModules).length > 0);
  await rm(path.join(root, ".mimic/workspace.json"));
  const unstarted = await prepare({ ...cfg, cohortId: "test_missing_state" });
  assert.equal(unstarted.runId, "run_test_missing_state");
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({ registry: { events: [], runs: {} }, snapshots: {} }),
  );
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({
      registry: { events: [], runs: { previous: {} }, canonical: {} },
      snapshots: {},
    }),
  );
  await assert.rejects(
    prepare({ ...cfg, cohortId: "test_used_workspace" }),
    /fresh Mimic workspace/,
  );
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({ registry: { events: [], runs: {} }, snapshots: {} }),
  );
  await writeFile(
    path.join(root, ".mimic/config.json"),
    JSON.stringify({
      defaultScope: "other_scope",
      scopes: [{ level: "organization", ownerId: "other_scope" }],
    }),
  );
  await assert.rejects(
    prepare({ ...cfg, cohortId: "test_wrong_scope" }),
    /scope|Scope/,
  );
  await writeFile(
    path.join(root, ".mimic/config.json"),
    JSON.stringify({
      defaultScope: "org_local",
      scopes: [{ level: "organization", ownerId: "org_local" }],
    }),
  );
  const plan = JSON.parse(
    await readFile(path.join(root, manifest.planPath), "utf8"),
  );
  const contaminated = JSON.parse(await readFile(template, "utf8"));
  contaminated
    .find((task) => task.id === "s10")
    .inputs.optional.push({
      name: "prior-direction",
      kind: "artifact",
      artifactType: "design-direction",
    });
  assert.throws(
    () => makePlan(contaminated, "test_compare", cfg),
    /leak between/,
  );
  assert.equal(plan.length, 15);
  assert.equal(
    preflightPlan(
      plan,
      [{ level: "organization", ownerId: "org_local" }],
      "org_local",
    ).length,
    15,
  );
  const task = (id) => plan.find((entry) => entry.id === id);
  assert.equal(task("s07").authority, "PROPOSE_ONLY");
  assert.match(task("s07").humanBrief, /work\.result\.proposal/);
  assert.match(
    task("s07").humanBrief,
    /only the exact proposed decision output ref/,
  );
  const unsafeS07 = JSON.parse(await readFile(template, "utf8"));
  unsafeS07.find((entry) => entry.id === "s07").authority = "AUTONOMOUS";
  assert.throws(
    () => makePlan(unsafeS07, "test_compare", cfg),
    /S07 durable boundary decision requires proposal-only authority/,
  );
  for (const arm of ["b0", "c1", "c2"]) {
    for (const stage of ["s09", "s10", "s11"]) {
      const comparisonTask = task(`${stage}_${arm}`);
      assert.deepEqual(
        comparisonTask.inputs.optional.filter(
          (need) => need.kind === "human-brief",
        ),
        [{ name: "comparison-brief", kind: "human-brief" }],
      );
      assert.match(comparisonTask.humanBrief, /Compare three structures/);
      if (stage === "s11") {
        assert.match(comparisonTask.humanBrief, /work\.result\.proposal/);
        assert.match(comparisonTask.humanBrief, /packetId,reason,items/);
        assert.match(comparisonTask.humanBrief, /host-derived lockDigest/);
        assert.match(
          comparisonTask.humanBrief,
          /evaluation refs are not proposal items/,
        );
      }
    }
    assert.ok(task(`s09_${arm}`).dependsOn.includes("s08"));
    assert.ok(
      task(`s10_${arm}`).inputs.required.some(
        (need) => need.refsFromTask === `s09_${arm}`,
      ),
    );
    assert.ok(
      task(`s11_${arm}`).inputs.required.some(
        (need) => need.refsFromTask === `s10_${arm}`,
      ),
    );
  }
  assert.deepEqual(task("s11_c2").evidenceFiles, [
    "inputs/test_compare-c2-s11.md",
  ]);
  assert.equal(manifest.retrieval.status, "ready");
  const c1 = await readFile(
    path.join(root, manifest.arms.C1.evidencePath),
    "utf8",
  );
  assert.match(c1, /case:smarthr-table/);
  assert.match(c1, /https:\/\/smarthr\.design/);
  assert.match(c1, /One object per row with name, discriminating fields/);
  assert.match(c1, /"from":"trait:smarthr-table"/);
  assert.match(c1, /obs:google-expressive/);
  assert.match(c1, /portfolio-limit/);
  const c2Review = await readFile(
    path.join(root, "inputs/test_compare-c2-s11.md"),
    "utf8",
  );
  assert.match(c2Review, /Emphasis can become visual noise/);
  assert.match(c2Review, /Google brand palette/);
  assert.match(c2Review, /hyp:google-expressive/);
  const c2 = await readFile(
    path.join(root, manifest.arms.C2.evidencePath),
    "utf8",
  );
  assert.match(c2, /Shared traversable declared-scope corpus/);
  assert.match(c2, /principle:smarthr-table/);
  const b0 = await readFile(
    path.join(root, manifest.arms.B0.evidencePath),
    "utf8",
  );
  assert.match(b0, /Flat case catalogue/);
  assert.match(b0, /Shared traversable declared-scope corpus/);
  assert.match(b0, /"edges"/);
  for (const evidence of [b0, c2]) {
    assert.ok(Buffer.byteLength(evidence) <= 40 * 1024);
    const subgraph = JSON.parse(evidence.trim().split("\n").at(-1));
    const nodeIds = new Set(subgraph.nodes.map((node) => node.id));
    const sourceIds = new Set(subgraph.sourceEvidence.map((row) => row.id));
    assert.deepEqual(
      subgraph.nodes
        .filter((node) => node.kind === "case")
        .map((node) => node.id)
        .sort(),
      ["case:google-expressive", "case:smarthr-table"],
    );
    assert.ok(
      subgraph.edges.every(
        (edge) =>
          nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.rationale,
      ),
    );
    assert.ok(
      [...subgraph.nodes, ...subgraph.edges].every((item) =>
        item.evidenceRefs.every((id) => sourceIds.has(id)),
      ),
    );
    assert.ok(
      subgraph.sourceEvidence.every((row) => row.sourceUrl && row.accessDate),
    );
  }
  const extraSource = await prepare({
    ...cfg,
    cohortId: "test_assessment_source",
    traitIds: [...cfg.traitIds, "trait:gov-journey"],
    assessments: [
      {
        ...cfg.assessments[0],
        evidenceRefs: [...cfg.assessments[0].evidenceRefs, "obs:gov-task-list"],
      },
      cfg.assessments[1],
    ],
  });
  const extraEvidence = await readFile(
    path.join(root, extraSource.arms.B0.evidencePath),
    "utf8",
  );
  const extraGraph = JSON.parse(extraEvidence.trim().split("\n").at(-1));
  assert.ok(extraGraph.nodes.some((node) => node.id === "trait:gov-journey"));
  assert.ok(extraGraph.nodes.some((node) => node.id === "case:gov-journey"));
  assert.ok(
    extraGraph.sourceEvidence.some((row) => row.id === "obs:gov-task-list"),
  );
  assert.doesNotMatch(b0, /Host graph retrieval/);
  const orphan = {
    action: "produce-provisional",
    runId: manifest.runId,
    reason: 'Skill task "s09_b0" produced partial output',
    outputs: [
      { artifactId: "art_orphan", revision: 1, lockDigest: "sha256:0" },
    ],
  };
  const completed = {
    action: "set-work",
    actor: { kind: "agent", id: "orchestrator" },
    runId: manifest.runId,
    reason: 'Skill task "s09_c1" completed with verified exact outputs',
    outputs: [
      { artifactId: "art_completed", revision: 1, lockDigest: "sha256:1" },
    ],
  };
  const proposedDecision = {
    meta: { type: "decision" },
    lifecycle: { status: "proposed" },
    approval: { status: "pending" },
  };
  const decisionRef = {
    artifactId: "art_decision",
    revision: 1,
    lockDigest: artifactDigest(proposedDecision),
  };
  const firstReviewable = {
    action: "set-work",
    actor: { kind: "agent", id: "orchestrator" },
    runId: manifest.runId,
    reason: 'Skill task "s11_c1" completed with verified exact outputs',
    at: "2026-10-09T10:00:00.000Z",
    outputs: [decisionRef],
  };
  const evaluationOnly = {
    ...firstReviewable,
    at: "2026-10-09T09:30:00.000Z",
    outputs: [{ artifactId: "art_evaluation", revision: 1 }],
  };
  const laterReview = {
    ...firstReviewable,
    at: "2026-10-09T11:00:00.000Z",
  };
  const unrelatedWork = {
    action: "set-work",
    actor: { kind: "agent", id: "operator" },
    runId: manifest.runId,
    reason: 'Skill task "s11_c1" completed with verified exact outputs',
    at: "2026-10-09T09:00:00.000Z",
    outputs: [{ artifactId: "false_review" }],
  };
  const unrelatedReason = {
    ...unrelatedWork,
    actor: { kind: "agent", id: "orchestrator" },
    reason: 'Recorded work for Skill task "s11_c1" without completion',
  };
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({
      registry: {
        events: [
          orphan,
          unrelatedWork,
          unrelatedReason,
          completed,
          evaluationOnly,
          firstReviewable,
          laterReview,
        ],
        runs: {
          [manifest.runId]: {
            closed: false,
            proposals: {},
            safeActions: [{}],
            blockers: {},
          },
        },
      },
      snapshots: {
        "art_decision@1": JSON.stringify({
          digest: decisionRef.lockDigest,
          artifact: proposedDecision,
        }),
      },
    }),
  );
  const frozenReport = await report(cfg);
  assert.equal(frozenReport.runState, "active");
  await mkdir(path.join(root, ".mimic/agent-sessions"));
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify(
      seal({
        version: 1,
        sessionId: "attempt",
        binding: {
          runId: manifest.runId,
          planDigest: frozenReport.binding.planDigest,
          settings: {
            provider: "codex",
            billingMode: "subscription-only",
            model: cfg.model,
          },
        },
        generationCount: 1,
        status: "stopped",
        stop: "candidate-rejected",
        tasks: {
          s09_b0: { phase: "rejected", rejectionReason: "preparation" },
        },
      }),
    ),
  );
  const noAttemptLog = await report(cfg);
  assert.equal(noAttemptLog.binding.reasoningEffortVerified, false);
  assert.equal(noAttemptLog.outcomes.B0.elapsedGenerationMs, null);
  const sessionConfig = {
    workspace: root,
    runId: manifest.runId,
    sessionId: "attempt",
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    ...cfg.dispatchSettings,
    packages: { s09_b0: "skills/s09-design-space-explorer" },
  };
  const configPath = path.join(root, "session-attempt.json");
  const configText = JSON.stringify(sessionConfig);
  await writeFile(configPath, configText);
  const configHash = createHash("sha256").update(configText).digest("hex");
  const schemaHash =
    manifest.schemas.workspace[
      "schemas/agent/codex-submission-output.schema.json"
    ].sha256;
  await writeFile(
    path.join(root, "attempts.jsonl"),
    JSON.stringify({
      runId: manifest.runId,
      sessionId: "attempt",
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      elapsedMs: 20,
      sessionConfigSha256: configHash,
      schemaSha256: schemaHash,
      tasks: [{ taskId: "s09_b0" }],
    }) + "\n",
  );
  const result = await report(cfg);
  assert.deepEqual(result.outcomes.B0.acceptedRefs, []);
  assert.equal(result.outcomes.B0.attemptCount, 1);
  assert.equal(result.outcomes.B0.elapsedGenerationMs, 20);
  assert.equal(result.outcomes.C1.acceptedRefs[0].artifactId, "art_completed");
  assert.equal(
    result.outcomes.C1.firstReviewableAt,
    "2026-10-09T10:00:00.000Z",
  );
  assert.equal(result.binding.verifiedSessionCount, 1);
  assert.equal(result.binding.reasoningEffortLogCount, 1);
  assert.equal(result.binding.reasoningEffortVerified, true);
  assert.equal(result.binding.dispatchSettingsVerified, true);
  assert.equal(result.schemaVerification, "verified");
  assert.equal(result.compiledVerification, "verified");
  assert.equal(result.outcomes.C2.reasoningEffortVerified, false);
  assert.equal(result.repositoryInputs.templateMatches, true);
  const attemptPath = path.join(root, "attempts.jsonl");
  const originalAttempt = JSON.parse(await readFile(attemptPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...sessionConfig, timeoutMs: 1000 }),
  );
  const changedDispatch = await report(cfg);
  assert.equal(changedDispatch.binding.dispatchSettingsVerified, false);
  assert.equal(changedDispatch.binding.reasoningEffortVerified, false);
  assert.equal(changedDispatch.outcomes.B0.reasoningEffortVerified, false);
  assert.equal(changedDispatch.outcomes.B0.elapsedGenerationMs, 20);
  await writeFile(configPath, configText);
  await writeFile(
    attemptPath,
    [originalAttempt, originalAttempt].map(JSON.stringify).join("\n") + "\n",
  );
  const duplicateTiming = await report(cfg);
  assert.equal(duplicateTiming.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(duplicateTiming.outcomes.B0.reasoningEffortVerified, false);
  assert.equal(duplicateTiming.binding.reasoningEffortVerified, false);
  await writeFile(
    attemptPath,
    [originalAttempt, { ...originalAttempt, sessionId: "missing-checkpoint" }]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const unmatchedTiming = await report(cfg);
  assert.equal(unmatchedTiming.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(unmatchedTiming.outcomes.B0.reasoningEffortVerified, false);
  assert.equal(unmatchedTiming.binding.reasoningEffortVerified, false);
  await writeFile(attemptPath, JSON.stringify(originalAttempt) + "\n");
  await writeFile(
    attemptPath,
    JSON.stringify({ ...originalAttempt, tasks: [{ taskId: "s09_c1" }] }) +
      "\n",
  );
  await assert.rejects(report(cfg), /Attempt settings differ/);
  await writeFile(attemptPath, JSON.stringify(originalAttempt) + "\n");
  const shared = JSON.parse(
    await readFile(
      path.join(root, ".mimic/agent-sessions/attempt.json"),
      "utf8",
    ),
  );
  shared.checkpoint.tasks.s09_c1 = { phase: "rejected" };
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify(seal(shared.checkpoint)),
  );
  await writeFile(
    attemptPath,
    JSON.stringify({
      ...originalAttempt,
      tasks: [{ taskId: "s09_b0" }, { taskId: "s09_c1" }],
    }) + "\n",
  );
  const mixed = await report(cfg);
  assert.deepEqual(mixed.outcomes.B0.mixedSessionIds, ["attempt"]);
  assert.equal(mixed.outcomes.B0.attemptCount, null);
  assert.equal(mixed.outcomes.B0.generationCount, null);
  assert.equal(mixed.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(mixed.outcomes.C1.elapsedGenerationMs, null);
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify(
      seal({
        ...shared.checkpoint,
        tasks: { s09_b0: shared.checkpoint.tasks.s09_b0 },
      }),
    ),
  );
  await writeFile(attemptPath, JSON.stringify(originalAttempt) + "\n");
  const partial = JSON.parse(
    await readFile(
      path.join(root, ".mimic/agent-sessions/attempt.json"),
      "utf8",
    ),
  );
  partial.checkpoint.sessionId = "unlogged-attempt";
  await writeFile(
    path.join(root, ".mimic/agent-sessions/unlogged-attempt.json"),
    JSON.stringify(seal(partial.checkpoint)),
  );
  const incompleteTiming = await report(cfg);
  assert.equal(incompleteTiming.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(incompleteTiming.outcomes.B0.reasoningEffortVerified, false);
  const sessionFile = path.join(root, ".mimic/agent-sessions/attempt.json");
  const mismatched = JSON.parse(await readFile(sessionFile, "utf8"));
  mismatched.checkpoint.binding.settings.model = "different-model";
  await writeFile(sessionFile, JSON.stringify(mismatched));
  await assert.rejects(report(cfg), /Invalid checkpoint envelope/);
  await writeFile(sessionFile, JSON.stringify(seal(mismatched.checkpoint)));
  await assert.rejects(report(cfg), /Session binding differs/);
  mismatched.checkpoint.binding.settings.model = cfg.model;
  await writeFile(sessionFile, JSON.stringify(seal(mismatched.checkpoint)));
  const schemaFile = path.join(
    root,
    "schemas/agent/codex-submission-output.schema.json",
  );
  const originalSchema = await readFile(schemaFile);
  const extraSkillFile = path.join(
    root,
    "skills/s09-design-space-explorer/extra.json",
  );
  await writeFile(extraSkillFile, "{}\n");
  await assert.rejects(report(cfg), /Changed Skill package set/);
  await rm(extraSkillFile);
  await writeFile(schemaFile, "{}\n");
  await assert.rejects(report(cfg), /Changed schema/);
  await writeFile(schemaFile, originalSchema);
  const extraSchema = path.join(root, "schemas/artifacts/extra.schema.json");
  await writeFile(extraSchema, "{}\n");
  await assert.rejects(report(cfg), /Changed schema set/);
  await rm(extraSchema);
  const manifestFile = path.join(root, `plans/${cfg.cohortId}-manifest.json`);
  const changedManifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const compiledName = Object.keys(changedManifest.compiledModules)[0];
  changedManifest.compiledModules[compiledName].sha256 = "invalid";
  await writeFile(manifestFile, JSON.stringify(changedManifest));
  await assert.rejects(report(cfg), /Changed compiled module/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(path.join(root, manifest.arms.B0.evidencePath), "changed\n");
  await assert.rejects(report(cfg), /Changed frozen file/);
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({ registry: { events: [], runs: {} }, snapshots: {} }),
  );
  const outside = await mkdtemp(path.join(os.tmpdir(), "mimic-escape-test-"));
  await rename(path.join(root, "inputs"), path.join(root, "inputs-original"));
  await cp(
    path.join(root, "inputs-original/page.html"),
    path.join(outside, "page.html"),
  );
  await symlink(outside, path.join(root, "inputs"));
  await assert.rejects(
    prepare({
      ...cfg,
      cohortId: "test_symlink_escape",
      pageEvidenceFiles: ["inputs-original/page.html"],
    }),
    /Output parent escapes workspace/,
  );
});
