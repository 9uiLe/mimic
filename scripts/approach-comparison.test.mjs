import assert from "node:assert/strict";
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
import { makePlan, prepare, report } from "./approach-comparison.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repo, "docs/dogfood/9ui183/plan-template.json");

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
  for (const arm of ["b0", "c1", "c2"]) {
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
  const b0 = await readFile(
    path.join(root, manifest.arms.B0.evidencePath),
    "utf8",
  );
  assert.match(b0, /Flat case catalogue/);
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
    runId: manifest.runId,
    reason: 'Skill task "s09_c1" completed with verified exact outputs',
    outputs: [
      { artifactId: "art_completed", revision: 1, lockDigest: "sha256:1" },
    ],
  };
  const firstReviewable = {
    action: "set-work",
    runId: manifest.runId,
    reason: 'Skill task "s11_c1" completed with verified exact outputs',
    at: "2026-10-09T10:00:00.000Z",
    outputs: [],
  };
  const laterReview = {
    ...firstReviewable,
    at: "2026-10-09T11:00:00.000Z",
  };
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({
      registry: {
        events: [orphan, completed, firstReviewable, laterReview],
        runs: {
          [manifest.runId]: {
            closed: false,
            proposals: {},
            safeActions: [{}],
            blockers: {},
          },
        },
      },
      snapshots: {},
    }),
  );
  const frozenReport = await report(cfg);
  assert.equal(frozenReport.runState, "active");
  await mkdir(path.join(root, ".mimic/agent-sessions"));
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify({
      checkpoint: {
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
      },
    }),
  );
  const noAttemptLog = await report(cfg);
  assert.equal(noAttemptLog.binding.reasoningEffortVerified, false);
  assert.equal(noAttemptLog.outcomes.B0.elapsedGenerationMs, null);
  await writeFile(
    path.join(root, "attempts.jsonl"),
    JSON.stringify({
      runId: manifest.runId,
      sessionId: "attempt",
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      elapsedMs: 20,
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
  assert.equal(result.schemaVerification, "verified");
  assert.equal(result.compiledVerification, "verified");
  assert.equal(result.outcomes.C2.reasoningEffortVerified, false);
  assert.equal(result.repositoryInputs.templateMatches, true);
  const shared = JSON.parse(
    await readFile(
      path.join(root, ".mimic/agent-sessions/attempt.json"),
      "utf8",
    ),
  );
  shared.checkpoint.tasks.s09_c1 = { phase: "rejected" };
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify(shared),
  );
  const mixed = await report(cfg);
  assert.deepEqual(mixed.outcomes.B0.mixedSessionIds, ["attempt"]);
  assert.equal(mixed.outcomes.B0.attemptCount, null);
  assert.equal(mixed.outcomes.B0.generationCount, null);
  assert.equal(mixed.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(mixed.outcomes.C1.elapsedGenerationMs, null);
  await writeFile(
    path.join(root, ".mimic/agent-sessions/attempt.json"),
    JSON.stringify({
      ...shared,
      checkpoint: {
        ...shared.checkpoint,
        tasks: { s09_b0: shared.checkpoint.tasks.s09_b0 },
      },
    }),
  );
  const partial = JSON.parse(
    await readFile(
      path.join(root, ".mimic/agent-sessions/attempt.json"),
      "utf8",
    ),
  );
  partial.checkpoint.sessionId = "unlogged-attempt";
  await writeFile(
    path.join(root, ".mimic/agent-sessions/unlogged-attempt.json"),
    JSON.stringify(partial),
  );
  const incompleteTiming = await report(cfg);
  assert.equal(incompleteTiming.outcomes.B0.elapsedGenerationMs, null);
  assert.equal(incompleteTiming.outcomes.B0.reasoningEffortVerified, false);
  const sessionFile = path.join(root, ".mimic/agent-sessions/attempt.json");
  const mismatched = JSON.parse(await readFile(sessionFile, "utf8"));
  mismatched.checkpoint.binding.settings.model = "different-model";
  await writeFile(sessionFile, JSON.stringify(mismatched));
  await assert.rejects(report(cfg), /Session binding differs/);
  mismatched.checkpoint.binding.settings.model = cfg.model;
  await writeFile(sessionFile, JSON.stringify(mismatched));
  const schemaFile = path.join(
    root,
    "schemas/agent/codex-submission-output.schema.json",
  );
  const originalSchema = await readFile(schemaFile);
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
