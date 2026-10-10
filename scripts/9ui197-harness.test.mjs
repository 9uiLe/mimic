import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  approvedHistory,
  briefForTask,
  captureSettingsDigest,
  checkLockedContent,
  compareTrials,
  makePlan,
  operationChanged,
  renderReviewHtml,
  reviewTrial,
  validateBrief,
} from "./9ui197-harness.mjs";

const brief = {
  audience: "Run reviewer",
  purpose: "Choose a useful direction",
  primaryAction: "Compare candidates",
  requiredInformation: ["status", "next action"],
  brandCharacter: "clear and restrained",
  content: [
    { policy: "fixed-fact", text: "12 active Runs" },
    { policy: "fixed-copy", text: "Resume Run" },
    { policy: "editable-copy", text: "Find a design" },
    { policy: "confirm", text: "Which direction feels on brand?" },
  ],
  references: [
    {
      source: "case:example",
      reason: "makes state clear",
      appliesWhen: "resuming",
      doNotBorrow: "the product logo",
    },
  ],
};
const ref = (id, revision = 1) => ({
  artifactId: id,
  revision,
  lockDigest: `sha256:${"a".repeat(64)}`,
});
const exactChoice = (id, revision = 1) =>
  `${id}@${revision}#${ref(id, revision).lockDigest}`;
const candidate = (id, revision = 1) => ({
  ref: ref(id, revision),
  artifact: {
    meta: {
      id,
      type: "design-direction",
      revision,
      ...(revision > 1 ? { supersedesRevision: revision - 1 } : {}),
    },
    lifecycle: { status: "provisional" },
    content: { summary: id, mechanisms: ["comparison"] },
    dependencies: revision > 1 ? [ref(id, revision - 1)] : [],
  },
});
const proposedDecision = {
  ref: ref("art_proposal"),
  artifact: {
    meta: { id: "art_proposal", type: "decision", revision: 1 },
    lifecycle: { status: "proposed" },
    origin: { actorId: "mimic.s11.direction-evaluator" },
    content: {
      summary: "Suggested direction",
      outcome: "proposed",
      chosenAlternative: "art_one",
    },
  },
};
const workingSelection = (choice, reviewRef = proposedDecision.ref) => ({
  id: "selection_one",
  runId: "run_trial",
  ref: choice,
  reviewRef,
  actor: { kind: "human", id: "person_one" },
});
const base = (changes = {}) => ({
  manifest: {
    runId: "run_trial",
    condition: "guided",
    brief,
    revisionBudget: 2,
  },
  run: { proposals: {} },
  artifacts: [],
  decisions: [],
  sessions: [],
  ...changes,
});
const committed = (proposal, decisionId) => ({
  request: {
    actor: { kind: "human" },
    packetId: proposal.packetId,
    approvals: [{ proposalId: proposal.id, decisionId }],
  },
});

test("brief preserves fact policy across both arms and adds intervention only to guided arm", () => {
  assert.equal(validateBrief(brief), brief);
  assert.match(briefForTask(brief, false, "s10"), /fixed-fact: 12 active Runs/);
  assert.doesNotMatch(briefForTask(brief, false, "s10"), /three distinct/);
  assert.match(
    briefForTask(brief, true, "s10"),
    /do not borrow the product logo/,
  );
  const template = [
    { id: "s09", inputs: { required: [], optional: [] } },
    { id: "s11", inputs: { required: [], optional: [] } },
  ];
  const plan = makePlan(template, {
    runId: "run_trial",
    condition: "guided",
    model: "gpt-test",
    budget: { maxGenerations: 2, timeoutMs: 120000 },
    brief,
    referenceFile: "inputs/reference.md",
    evidenceFiles: { s04: ["inputs/system.md"], s08: ["inputs/task.md"] },
  });
  assert.deepEqual(plan[0].evidenceFiles, ["inputs/reference.md"]);
  assert.equal(template[0].evidenceFiles, undefined);
  assert.throws(
    () => validateBrief({ ...brief, references: [{ source: "case:example" }] }),
    /Reference needs/,
  );
});

test("revision plan binds the selected exact direction as an S10 revise input", async () => {
  const template = JSON.parse(
    await readFile(
      new URL("../docs/dogfood/9ui183/plan-template.json", import.meta.url),
      "utf8",
    ),
  );
  const plan = makePlan(template, {
    runId: "run_revision_one",
    previousRunId: "run_initial",
    selectedSelectionId: "selection_choice",
    baseRef: ref("art_one"),
    revisionRequest: "Clarify the primary action",
    selectedBase: { summary: "Selected direction" },
    condition: "guided",
    model: "gpt-test",
    budget: { maxGenerations: 2, timeoutMs: 120000 },
    brief,
    referenceFile: "inputs/reference.md",
    evidenceFiles: { s04: ["inputs/system.md"], s08: ["inputs/task.md"] },
  });
  const s10 = plan.find((task) => task.id === "s10");
  assert.equal(s10.intent, "revise");
  assert.equal(s10.targetArtifactId, "art_one");
  assert.deepEqual(s10.revisionBase, {
    ref: ref("art_one"),
    sourceRunId: "run_initial",
    selectionId: "selection_choice",
  });
  assert.deepEqual(
    s10.inputs.optional.find((item) => item.name === "prior-direction").refs,
    [ref("art_one")],
  );
  assert.match(s10.humanBrief, /Revise only the human-selected direction once/);
  assert.doesNotMatch(
    s10.humanBrief,
    /initial candidate budget|three distinct structural candidates/,
  );
  const skill = parseYaml(
    await readFile(
      new URL(
        "../skills/s10-design-direction-generator/manifest.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const declaration = (item) => ({
    name: item.name,
    kind: item.kind,
    ...(item.artifactType ? { artifactType: item.artifactType } : {}),
    ...(item.schemaVersion ? { schemaVersion: item.schemaVersion } : {}),
  });
  assert.deepEqual(s10.inputs.required.map(declaration), skill.inputs.required);
  assert.deepEqual(s10.inputs.optional.map(declaration), skill.inputs.optional);
  assert.match(s10.humanBrief, /Selected direction/);
  const { preflightPlan } = await import("../apps/cli/dist/plan.js");
  assert.equal(
    preflightPlan(
      plan,
      [{ level: "organization", ownerId: "org_local" }],
      "org_local",
    ).find((task) => task.id === "s10").intent,
    "revise",
  );
});

test("fixed fact and copy check never passes an uncaptured screen", () => {
  assert.equal(checkLockedContent(brief).state, "UNVERIFIED");
  assert.deepEqual(checkLockedContent(brief, "12 active Runs · Resume Run"), {
    state: "PASS",
    missing: [],
  });
  assert.deepEqual(checkLockedContent(brief, "13 active Runs · Resume Run"), {
    state: "FAIL",
    missing: ["12 active Runs"],
  });
  assert.deepEqual(checkLockedContent(brief, "112 active Runs · Resume Run"), {
    state: "FAIL",
    missing: ["12 active Runs"],
  });
});

test("capture binding changes with preview and screen checks", () => {
  const config = {
    previewUrls: { [exactChoice("art_one")]: "https://example.test/one" },
    requiredSelectors: ["#main"],
    operations: {},
  };
  assert.equal(
    captureSettingsDigest(config),
    captureSettingsDigest({
      requiredSelectors: ["#main"],
      operations: {},
      previewUrls: config.previewUrls,
    }),
  );
  assert.notEqual(
    captureSettingsDigest(config),
    captureSettingsDigest({
      ...config,
      previewUrls: { [exactChoice("art_one")]: "https://example.test/two" },
    }),
  );
  assert.notEqual(
    captureSettingsDigest(config),
    captureSettingsDigest({
      ...config,
      requiredSelectors: ["#main", "#status"],
    }),
  );
  assert.notEqual(
    captureSettingsDigest(config),
    captureSettingsDigest({
      ...config,
      readySelectors: { [exactChoice("art_one")]: "[data-ready]" },
    }),
  );
});

test("an operation only passes when its own result changes after the click", () => {
  assert.equal(operationChanged("Done", "Done", "Done"), false);
  assert.equal(operationChanged("Done waiting", "Done updated", "Done"), false);
  assert.equal(operationChanged("Waiting", "Done", "Done"), true);
  assert.equal(operationChanged("Waiting", "Other", "Done"), false);
});

test("normal candidate remains pending human choice and unverified screen", () => {
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      sessions: [{ sessionId: "S1", generationCount: 1, status: "complete" }],
    }),
  );
  assert.equal(report.status, "awaiting-human-selection");
  assert.equal(report.candidates[0].verification.state, "UNVERIFIED");
  assert.equal(report.usage.generationReservations, 1);
  assert.equal(report.usage.humanSatisfaction, "UNMEASURED");
});

test("failure before candidates remains stopped with its reason; later review can resume", () => {
  const stopped = reviewTrial(
    base({
      sessions: [
        {
          sessionId: "S1",
          status: "stopped",
          stop: "candidate-rejected",
          generationCount: 1,
        },
      ],
    }),
  );
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stops[0].stop, "candidate-rejected");
  const resumed = reviewTrial(
    base({
      artifacts: [candidate("art_one")],
      sessions: [
        {
          sessionId: "S1",
          status: "stopped",
          stop: "candidate-rejected",
          generationCount: 1,
        },
        { sessionId: "S2", status: "complete", generationCount: 1 },
      ],
    }),
  );
  assert.equal(resumed.status, "evaluating");
  assert.equal(resumed.stops.length, 1);
});

test("a candidate with a stopped evaluator is partial, not ready for selection", () => {
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one")],
      sessions: [
        {
          sessionId: "S1",
          status: "stopped",
          stop: "timeout",
          generationCount: 1,
        },
      ],
    }),
  );
  assert.equal(report.status, "partial-stopped");
});

test("agent suggestion cannot become a human selection", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: ref("art_proposal"),
    status: "pending",
  };
  const decision = {
    id: "decision_1",
    actor: { kind: "agent" },
    outcome: "approved",
    proposalId: proposal.id,
    packetId: proposal.packetId,
    output: {
      artifact: { content: { chosenAlternative: exactChoice("art_one") } },
    },
  };
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      run: { proposals: { [proposal.id]: proposal } },
      decisions: [decision],
    }),
  );
  assert.equal(report.status, "awaiting-human-selection");
  assert.equal(report.humanDecisionId, null);
  const human = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      run: { proposals: { [proposal.id]: proposal } },
      decisions: [{ ...decision, actor: { kind: "human" } }],
    }),
  );
  assert.equal(human.status, "awaiting-human-commit");
  assert.equal(human.selectedRef, null);
  const afterCommit = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      run: { proposals: { [proposal.id]: { ...proposal, status: "merged" } } },
      decisions: [{ ...decision, actor: { kind: "human" } }],
      commits: [committed(proposal, decision.id)],
    }),
  );
  assert.equal(afterCommit.status, "awaiting-working-selection");
  assert.equal(afterCommit.selectedRef, null);
});

test("explicit working-source commit selects only its exact S10 candidate", () => {
  const choice = ref("art_one");
  const report = reviewTrial(
    base({
      artifacts: [
        candidate("art_one"),
        candidate("art_other"),
        proposedDecision,
      ],
      run: {
        proposals: {},
        revisionSelection: {
          id: "selection_one",
          runId: "run_trial",
          ref: choice,
          reviewRef: proposedDecision.ref,
          actor: { kind: "human", id: "person_one" },
        },
      },
    }),
  );
  assert.equal(report.status, "selected");
  assert.deepEqual(report.selectedRef, choice);
  assert.equal(report.humanSelectionId, "selection_one");
  assert.equal(report.humanDecisionId, null);
  assert.equal(
    reviewTrial(base({ artifacts: [candidate("art_one"), proposedDecision] }))
      .status,
    "awaiting-human-selection",
  );
});

test("human decision without exact candidate ref is not treated as selection", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: ref("art_proposal"),
  };
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      run: { proposals: { [proposal.id]: { ...proposal, status: "merged" } } },
      commits: [committed(proposal, "decision_1")],
      decisions: [
        {
          id: "decision_1",
          actor: { kind: "human" },
          outcome: "approved",
          proposalId: proposal.id,
          packetId: proposal.packetId,
          output: {
            artifact: { content: { chosenAlternative: "Looks good" } },
          },
        },
      ],
    }),
  );
  assert.equal(report.status, "awaiting-working-selection");
  assert.equal(report.selectedRef, null);
});

test("rejected S11 proposal is not shown as pending human choice", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: proposedDecision.ref,
    status: "rejected",
  };
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one"), proposedDecision],
      run: { proposals: { [proposal.id]: proposal } },
      decisions: [
        {
          id: "decision_rejected",
          actor: { kind: "human" },
          outcome: "rejected",
          proposalId: proposal.id,
          packetId: proposal.packetId,
        },
      ],
    }),
  );
  assert.equal(report.status, "proposal-rejected");
  assert.deepEqual(report.proposedDecisions, []);
});

test("superseding commit selects the newer S11 decision", () => {
  const oldProposal = {
    id: "proposal_old",
    packetId: "packet_old",
    ref: proposedDecision.ref,
    status: "superseded",
  };
  const newProposal = {
    id: "proposal_new",
    packetId: "packet_new",
    ref: ref("art_proposal", 2),
    status: "merged",
  };
  const decision = (proposal, id) => ({
    id,
    actor: { kind: "human" },
    outcome: "approved",
    proposalId: proposal.id,
    packetId: proposal.packetId,
    output: {
      artifact: { content: { chosenAlternative: exactChoice("art_one") } },
    },
  });
  const report = reviewTrial(
    base({
      artifacts: [
        candidate("art_one"),
        proposedDecision,
        { ref: newProposal.ref, artifact: proposedDecision.artifact },
      ],
      run: {
        proposals: {
          [oldProposal.id]: oldProposal,
          [newProposal.id]: newProposal,
        },
        revisionSelection: workingSelection(ref("art_one"), newProposal.ref),
      },
      decisions: [
        decision(oldProposal, "decision_old"),
        {
          ...decision(newProposal, "decision_new"),
          supersedesDecisionId: "decision_old",
        },
      ],
      commits: [committed(newProposal, "decision_new")],
    }),
  );
  assert.equal(report.status, "selected");
  assert.equal(report.humanDecisionId, "decision_new");
});

test("revisions stop at the budget and retain the earlier candidate", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: ref("art_proposal"),
  };
  const decision = {
    id: "decision_1",
    actor: { kind: "human" },
    outcome: "approved",
    proposalId: proposal.id,
    packetId: proposal.packetId,
    output: {
      artifact: { content: { chosenAlternative: exactChoice("art_one") } },
    },
  };
  const report = reviewTrial(
    base({
      run: {
        proposals: { [proposal.id]: { ...proposal, status: "merged" } },
        revisionSelection: workingSelection(ref("art_one", 3)),
      },
      decisions: [decision],
      commits: [committed(proposal, decision.id)],
      artifacts: [
        candidate("art_one"),
        candidate("art_one", 2),
        candidate("art_one", 3),
        proposedDecision,
      ],
    }),
  );
  assert.equal(report.status, "revision-limit");
  assert.equal(report.revisionCount, 2);
  assert.equal(report.candidates.length, 3);
});

test("a revision of an unselected direction is flagged", () => {
  const report = reviewTrial(
    base({ artifacts: [candidate("art_one"), candidate("art_other", 2)] }),
  );
  assert.equal(report.status, "unselected-revision");
  assert.deepEqual(report.unrelatedRevisionRefs, [ref("art_other", 2)]);
});

test("a revision of the prior human choice waits for the current choice", () => {
  const report = reviewTrial(
    base({
      manifest: {
        runId: "run_revision_one",
        condition: "guided",
        brief,
        revisionBudget: 2,
        baseRef: ref("art_one"),
      },
      artifacts: [candidate("art_one", 2), proposedDecision],
      history: [ref("art_one")],
    }),
  );
  assert.equal(report.status, "awaiting-human-selection");
  assert.deepEqual(report.unrelatedRevisionRefs, []);
  assert.equal(report.selectedRef, null);
});

test("an unrelated generated direction cannot count as a selected revision", () => {
  const report = reviewTrial(
    base({
      manifest: {
        runId: "run_revision_one",
        condition: "guided",
        brief,
        revisionBudget: 2,
        baseRef: ref("art_one"),
      },
      artifacts: [candidate("art_other"), proposedDecision],
      history: [ref("art_one")],
    }),
  );
  assert.equal(report.status, "invalid-revision-output");
  assert.deepEqual(report.invalidRevisionRefs, [ref("art_other")]);
  assert.equal(report.selectedRef, null);
});

test("a capture belongs to one exact revision", () => {
  const second = ref("art_one", 2);
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one"), candidate("art_one", 2)],
      captures: {
        [exactChoice("art_one", 2)]: {
          ref: second,
          screenText: "12 active Runs · Resume Run",
        },
      },
    }),
  );
  assert.equal(report.candidates[0].verification.state, "UNVERIFIED");
  assert.equal(report.candidates[1].verification.state, "PASS");
});

test("evaluation findings belong to the exact candidate revision", () => {
  const report = reviewTrial(
    base({
      artifacts: [
        candidate("art_one"),
        candidate("art_one", 2),
        {
          ref: ref("art_eval"),
          artifact: {
            meta: { type: "evaluation" },
            content: {
              target: "art_one@1",
              findings: ["Only the first revision was evaluated"],
            },
          },
        },
      ],
    }),
  );
  assert.deepEqual(report.candidates[0].evaluation, [
    "Only the first revision was evaluated",
  ]);
  assert.equal(report.candidates[1].evaluation, "UNVERIFIED");
});

test("approved prior Run selections consume the revision budget", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: proposedDecision.ref,
  };
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_new"), proposedDecision],
      run: {
        proposals: { [proposal.id]: { ...proposal, status: "merged" } },
        revisionSelection: workingSelection(ref("art_new")),
      },
      commits: [committed(proposal, "human_decision")],
      decisions: [
        {
          id: "human_decision",
          actor: { kind: "human" },
          outcome: "approved",
          proposalId: proposal.id,
          packetId: proposal.packetId,
          output: {
            artifact: {
              content: { chosenAlternative: exactChoice("art_new") },
            },
          },
        },
      ],
      history: [ref("art_initial"), ref("art_revision_one")],
    }),
  );
  assert.equal(report.status, "revision-limit");
  assert.equal(report.revisionCount, 2);
  assert.deepEqual(report.priorSelectedRefs, [
    ref("art_initial"),
    ref("art_revision_one"),
  ]);
});

test("one revised Run is counted once when it publishes revision metadata", () => {
  const proposal = {
    id: "proposal_1",
    packetId: "packet_1",
    ref: proposedDecision.ref,
  };
  const report = reviewTrial(
    base({
      artifacts: [candidate("art_one", 2), proposedDecision],
      run: {
        proposals: { [proposal.id]: { ...proposal, status: "merged" } },
        revisionSelection: workingSelection(ref("art_one", 2)),
      },
      commits: [committed(proposal, "human_decision")],
      decisions: [
        {
          id: "human_decision",
          actor: { kind: "human" },
          outcome: "approved",
          proposalId: proposal.id,
          packetId: proposal.packetId,
          output: {
            artifact: {
              content: { chosenAlternative: exactChoice("art_one", 2) },
            },
          },
        },
      ],
      history: [ref("art_one")],
    }),
  );
  assert.equal(report.revisionCount, 1);
  assert.equal(report.status, "selected");
});

test("a revision verifies the prior Run's committed human choice and exact base", async () => {
  const accepted = JSON.parse(
    await readFile(
      new URL(
        "../docs/dogfood/9ui178/accepted-design-artifacts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const chosen = accepted.artifacts.find(
    ({ artifact }) => artifact.meta.type === "design-direction",
  );
  const proposalArtifact = accepted.artifacts.find(
    ({ artifact }) =>
      artifact.meta.type === "decision" &&
      artifact.origin?.actorId === "mimic.s11.direction-evaluator",
  );
  assert(chosen && proposalArtifact);
  const workspace = await mkdtemp(path.join(tmpdir(), "mimic-9ui197-history-"));
  try {
    await mkdir(path.join(workspace, ".mimic/runs"), { recursive: true });
    const priorRunId = accepted.runId;
    const plan = "[]";
    const planDigest = `sha256:${createHash("sha256").update(plan).digest("hex")}`;
    const prior = {
      runId: priorRunId,
      condition: "guided",
      brief,
      model: "model-1",
      budget: { maxGenerations: 2, timeoutMs: 120000 },
      revisionBudget: 2,
      referenceDigest: "sha256:reference",
      evidenceDigests: { "inputs/task.md": "sha256:task" },
      templateDigest: "sha256:template",
      planDigest,
    };
    const proposal = {
      id: "proposal_s11",
      packetId: "packet_s11",
      ref: proposalArtifact.ref,
      status: "merged",
    };
    const saved = {
      registry: {
        runs: {
          [priorRunId]: {
            scope: "org_local",
            artifacts: accepted.artifacts.map(({ ref }) => ref),
            proposals: { [proposal.id]: proposal },
          },
        },
        packets: { [proposal.packetId]: { runId: priorRunId } },
        decisions: {
          decision_1: {
            id: "decision_1",
            actor: { kind: "human" },
            outcome: "approved",
            proposalId: proposal.id,
            packetId: proposal.packetId,
            output: {
              artifact: {
                content: {
                  chosenAlternative: `${chosen.ref.artifactId}@${chosen.ref.revision}#${chosen.ref.lockDigest}`,
                },
              },
            },
          },
        },
        commits: { commit_1: committed(proposal, "decision_1") },
      },
      snapshots: Object.fromEntries(
        accepted.artifacts.map(({ ref, artifact }) => [
          `${ref.artifactId}@${ref.revision}`,
          JSON.stringify({ artifact }),
        ]),
      ),
    };
    const selection = {
      id: "selection_1",
      runId: priorRunId,
      ref: chosen.ref,
      reviewRef: proposalArtifact.ref,
      actor: { kind: "human", id: "person_1" },
      at: "2026-10-10T04:10:00Z",
      reason: "Use this direction as working revision source",
    };
    const { canonicalJson } =
      await import("../packages/core/dist/artifact-canonical.js");
    const { LocalRevisionSelectionAuthority } =
      await import("../apps/cli/dist/local-revision-selection.js");
    saved.registry.runs[priorRunId].revisionSelection =
      await new LocalRevisionSelectionAuthority(workspace).prepare(
        selection,
        {
          version: 1,
          action: "select-revision-base",
          hostId: "fixture-host",
          humanActorId: selection.actor.id,
          confirmedAt: selection.at,
          runId: priorRunId,
          scopeOwnerId: "org_local",
          requestId: selection.id,
          requestDigest: `sha256:${createHash("sha256").update(canonicalJson(selection)).digest("hex")}`,
          candidate: chosen.ref,
          review: proposalArtifact.ref,
        },
        saved.registry,
      );
    await writeFile(
      path.join(workspace, `trial-${priorRunId}.json`),
      JSON.stringify(prior),
    );
    await writeFile(path.join(workspace, `tasks-${priorRunId}.json`), plan);
    await writeFile(
      path.join(workspace, `.mimic/runs/${priorRunId}.json`),
      plan,
    );
    await writeFile(
      path.join(workspace, ".mimic/workspace.json"),
      JSON.stringify(saved),
    );
    const child = {
      ...prior,
      runId: "run_revision_one",
      previousRunId: priorRunId,
      baseRef: chosen.ref,
      revisionRequest: "Improve the selected action",
    };
    const history = await approvedHistory(workspace, child);
    assert.deepEqual(history.refs, [chosen.ref]);
    assert.deepEqual(history.baseContent, chosen.artifact.content);
    assert.equal(history.baseSelectionId, "selection_1");
    const other = accepted.artifacts.find(
      ({ artifact, ref }) =>
        artifact.meta.type === "design-direction" &&
        ref.artifactId !== chosen.ref.artifactId,
    );
    assert(other);
    await assert.rejects(
      approvedHistory(workspace, {
        ...child,
        baseRef: other.ref,
      }),
      /matching human-approved exact choice/,
    );
    await assert.rejects(
      approvedHistory(workspace, { ...child, revisionBudget: 0 }),
      /Revision budget exhausted/,
    );
    await mkdir(path.join(workspace, ".mimic/agent-sessions"));
    await writeFile(
      path.join(workspace, ".mimic/agent-sessions/Session_1.json"),
      JSON.stringify({ digest: "invalid", checkpoint: { version: 1 } }),
    );
    await assert.rejects(
      approvedHistory(workspace, child),
      /Invalid checkpoint/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an S07 human decision does not hide the later S11 selection", () => {
  const s07Ref = ref("art_s07_decision");
  const s11Proposal = {
    id: "proposal_s11",
    packetId: "packet_s11",
    ref: proposedDecision.ref,
  };
  const s07Proposal = {
    id: "proposal_s07",
    packetId: "packet_s07",
    ref: s07Ref,
  };
  const decision = (proposal, id, choice) => ({
    id,
    actor: { kind: "human" },
    outcome: "approved",
    proposalId: proposal.id,
    packetId: proposal.packetId,
    output: { artifact: { content: { chosenAlternative: choice } } },
  });
  const report = reviewTrial(
    base({
      run: {
        proposals: {
          [s07Proposal.id]: s07Proposal,
          [s11Proposal.id]: { ...s11Proposal, status: "merged" },
        },
        revisionSelection: workingSelection(ref("art_one")),
      },
      commits: [committed(s11Proposal, "decision_s11")],
      artifacts: [
        candidate("art_one"),
        proposedDecision,
        {
          ref: s07Ref,
          artifact: {
            meta: { type: "decision" },
            origin: { actorId: "mimic.s07.experience-architecture" },
            content: { outcome: "proposed" },
          },
        },
      ],
      decisions: [
        decision(s07Proposal, "decision_s07", "domain"),
        decision(s11Proposal, "decision_s11", exactChoice("art_one")),
      ],
    }),
  );
  assert.equal(report.status, "selected");
  assert.equal(report.humanDecisionId, "decision_s11");
});

test("the review consumes the previously accepted real S10/S11 artifacts without claiming adoption", async () => {
  const accepted = JSON.parse(
    await readFile(
      new URL(
        "../docs/dogfood/9ui178/accepted-design-artifacts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const report = reviewTrial(base({ artifacts: accepted.artifacts }));
  assert.equal(report.candidates.length, 3);
  assert.equal(report.proposedDecisions.length, 1);
  assert.equal(report.status, "awaiting-human-selection");
  assert(
    report.candidates.every((item) => item.verification.state === "UNVERIFIED"),
  );
  const html = renderReviewHtml(report);
  assert.match(html, /A comparison workspace treats design review/);
  assert.match(html, /改訂作業のために人が選んだ案: 待機中/);
  assert.doesNotMatch(html, /<script/);
});

test("comparison requires identical declared task, sources, model and budget", () => {
  const manifest = {
    condition: "baseline",
    brief,
    referenceDigest: "sha256:ref",
    templateDigest: "sha256:template",
    skillTreeDigest: "sha256:skills",
    schemaTreeDigest: "sha256:schemas",
    evidenceDigests: { "inputs/task.md": "sha256:task" },
    model: "model-1",
    budget: { maxGenerations: 2, timeoutMs: 120000 },
  };
  assert.equal(
    compareTrials(
      { manifest },
      { manifest: { ...manifest, condition: "guided" } },
    ).matchedDeclaredInputs,
    true,
  );
  assert.equal(
    compareTrials(
      { manifest },
      { manifest: { ...manifest, condition: "guided", model: "model-2" } },
    ).observedOutcome,
    "NOT_COMPARABLE",
  );
  assert.equal(
    compareTrials(
      { manifest: { ...manifest, revisionBudget: 1 } },
      { manifest: { ...manifest, condition: "guided", revisionBudget: 2 } },
    ).observedOutcome,
    "NOT_COMPARABLE",
  );
  assert.equal(
    compareTrials(
      { manifest },
      {
        manifest: {
          ...manifest,
          condition: "guided",
          skillTreeDigest: "sha256:changed",
        },
      },
    ).observedOutcome,
    "NOT_COMPARABLE",
  );
  const left = {
    ...manifest,
    evidenceFiles: { s04: ["inputs/system-a.md"], s08: ["inputs/task-a.md"] },
    evidenceDigests: {
      "inputs/system-a.md": "sha256:system",
      "inputs/task-a.md": "sha256:task",
    },
  };
  const right = {
    ...manifest,
    condition: "guided",
    brief: {
      references: brief.references,
      content: brief.content,
      brandCharacter: brief.brandCharacter,
      requiredInformation: brief.requiredInformation,
      primaryAction: brief.primaryAction,
      purpose: brief.purpose,
      audience: brief.audience,
    },
    evidenceFiles: { s08: ["inputs/task-b.md"], s04: ["inputs/system-b.md"] },
    evidenceDigests: {
      "inputs/task-b.md": "sha256:task",
      "inputs/system-b.md": "sha256:system",
    },
  };
  assert.equal(
    compareTrials({ manifest: left }, { manifest: right })
      .matchedDeclaredInputs,
    true,
  );
  assert.equal(
    compareTrials(
      { manifest: left },
      {
        manifest: {
          ...right,
          previousRunId: "run_prior",
          revisionRequest: "Improve the selected action",
        },
      },
    ).observedOutcome,
    "NOT_COMPARABLE",
  );
});
