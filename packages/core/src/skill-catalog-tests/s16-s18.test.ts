import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { loadSkillPackage, runSkillPackage } from "../skill-runtime/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemasRoot = path.join(repository, "schemas");
const at = "2026-10-06T12:00:00Z";
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
const packages = [
  "s16-design-critic",
  "s17-knowledge-curator",
  "s18-experience-validation",
] as const;
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Scenario = {
  id: string;
  mode: string;
  output?: string;
  reason?: string;
  expectOutputs?: number;
  expectCriteria?: string[];
  expectStates?: Record<string, string>;
  expectAlternatives?: string[];
  expectOutcome?: string;
  expectState?: string;
  expectEvidenceRefs?: string[];
  evidenceRefs?: string[];
};
const exact = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
const declaredCases: Record<
  (typeof packages)[number],
  Record<string, string>
> = {
  "s16-design-critic": {
    "criterion-review": "produce",
    "missing-target-lock": "blocked",
    "missing-empirical-evidence": "produce",
    "undeclared-output": "reject-output-type",
  },
  "s17-knowledge-curator": {
    "local-disposition": "produce",
    "approved-reuse": "reuse-approved",
    "untraceable-source": "blocked",
    "self-approval": "reject-self-approval",
    "rejected-replay": "reject-replay",
  },
  "s18-experience-validation": {
    "unobserved-plan": "produce",
    "missing-target": "blocked",
    "unsupported-claim": "reject-no-evidence",
    "wrong-run": "reject-run",
    "evidence-supported": "produce",
    "evidence-mixed": "produce",
    "evidence-unsupported": "produce",
  },
};

async function setup(packageName: (typeof packages)[number]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-quality-skills-"));
  temporaryRoots.push(root);
  const schemas = await loadSchemaDirectory(
    path.join(schemasRoot, "artifacts"),
  );
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
    scopes,
    {
      async verify(record: { actor: { kind: string; id: string } }) {
        return record.actor.kind === "human" && record.actor.id === "human_1";
      },
      async allowCommit() {
        return true;
      },
    },
  );
  const skill = await loadSkillPackage(
    path.join(repository, "skills", packageName),
    schemasRoot,
  );
  const scenarios = JSON.parse(skill.tests["tests/scenarios.json"]!) as {
    scenarios: Scenario[];
  };
  const output = JSON.parse(
    skill.examples["examples/output.json"]!,
  ) as ArtifactSnapshot;
  const task: RoutedTask = {
    id: "quality",
    skillId: skill.manifest.skillId,
    outputType: skill.manifest.outputs[0]!,
    additionalOutputTypes: skill.manifest.outputs.slice(1),
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    evidenceFiles: [],
    inputs: {
      required: skill.manifest.inputs.required.map((input) => ({ ...input })),
      optional: skill.manifest.inputs.optional.map((input) => ({ ...input })),
      alternatives: skill.manifest.inputs.alternatives.map((group) => ({
        oneOf: group.oneOf.map((input) => ({ ...input })),
      })),
    },
  };
  const start = (tasks: readonly RoutedTask[] = [task]) =>
    runtime.orchestrator.start({
      id: "run_quality",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: { kind: "agent", id: "agent_1" },
      at,
      tasks,
    });
  async function source(type: string, id: string) {
    const filename =
      type === "product-ui-contract" ? "proposed-product-ui-contract" : type;
    const fixture = JSON.parse(
      await readFile(
        path.join(repository, "fixtures/artifacts/valid", `${filename}.json`),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const artifact: ArtifactSnapshot = {
      ...fixture,
      meta: { ...fixture.meta, id },
      lifecycle: { status: "provisional", freshness: "valid" },
      approval: { status: "pending" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.fixture",
        runId: "run_seed",
        createdAt: at,
      },
      dependencies: [],
    };
    const proposed: ArtifactSnapshot = {
      ...artifact,
      lifecycle: { status: "proposed", freshness: "valid" },
    };
    await runtime.artifacts.create(proposed);
    await runtime.registry.produce({
      runId: "run_seed",
      ref: exact(proposed),
      inputs: [],
      actor: { kind: "skill", id: "mimic.fixture" },
      at,
      reason: "Fixture input for package bridge",
    });
    return proposed;
  }
  return {
    ...runtime,
    schemas,
    skill,
    scenarios: scenarios.scenarios,
    output,
    task,
    start,
    source,
  };
}

async function boundInputs(
  x: Awaited<ReturnType<typeof setup>>,
  extraTypes: string[] = [],
  tasks: readonly RoutedTask[] = [x.task],
) {
  const seedTask: RoutedTask = {
    ...x.task,
    id: "seed",
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }],
      optional: [],
      alternatives: [],
    },
    humanBrief: "Fixture setup",
  };
  await x.orchestrator.start({
    id: "run_seed",
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks: [seedTask],
  });
  const sources: ArtifactSnapshot[] = [];
  for (const input of x.skill.manifest.inputs.required) {
    if (input.kind === "artifact")
      sources.push(
        await x.source(
          input.artifactType,
          `art_${input.name.replaceAll("-", "_")}`,
        ),
      );
  }
  for (const type of extraTypes)
    sources.push(
      await x.source(type, `art_extra_${type.replaceAll("-", "_")}`),
    );
  await x.registry.submit({
    runId: "run_seed",
    packetId: "packet_seed",
    proposals: sources.map((artifact, index) => ({
      id: `proposal_seed_${index}`,
      ref: exact(artifact),
      alternatives: ["approve", "reject"],
      rationale: "Fixture source",
      evidenceLimits: ["Illustrative fixture"],
      dependents: [],
    })),
    actor: { kind: "agent", id: "agent_1" },
    at,
    reason: "Fixture approval",
  });
  for (const [index, source] of sources.entries()) {
    const bare: ArtifactSnapshot = {
      ...source,
      meta: { ...source.meta, revision: 2, supersedesRevision: 1 },
      lifecycle: { status: "approved", freshness: "valid" },
      approval: {
        status: "approved",
        decisionId: `decision_seed_${index}`,
        actorId: "human_1",
        at,
      },
    };
    const approved: ArtifactSnapshot = {
      ...bare,
      meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
    };
    await x.registry.decide({
      id: `decision_seed_${index}`,
      packetId: "packet_seed",
      proposalId: `proposal_seed_${index}`,
      outcome: "approved",
      actor: { kind: "human", id: "human_1" },
      at,
      rationale: "Approve fixture source",
      output: { ref: exact(approved), artifact: approved },
    });
  }
  await x.registry.commit({
    id: "commit_seed",
    packetId: "packet_seed",
    approvals: sources.map((_, index) => ({
      proposalId: `proposal_seed_${index}`,
      decisionId: `decision_seed_${index}`,
    })),
    actor: { kind: "human", id: "human_1" },
    at,
    reason: "Fixture commit",
  });
  await x.start(tasks);
}

function candidate(
  x: Awaited<ReturnType<typeof setup>>,
  caseId: string,
  content = x.output.content,
): ArtifactSnapshot {
  return {
    ...x.output,
    meta: { ...x.output.meta, id: `art_${caseId.replaceAll("-", "_")}` },
    origin: {
      actorKind: "skill",
      actorId: x.skill.manifest.skillId,
      runId: "run_quality",
      createdAt: at,
    },
    dependencies: [],
    content,
  };
}

for (const packageName of packages) {
  test(`${packageName} executes declared scenarios against the shared workspace`, async () => {
    const declared = await setup(packageName);
    expect(declared.skill.instructions.length).toBeGreaterThan(500);
    expect(declared.schemas.validate(declared.output)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(
      Object.fromEntries(declared.scenarios.map(({ id, mode }) => [id, mode])),
    ).toEqual(declaredCases[packageName]);
    expect(declared.scenarios.length).toBe(
      Object.keys(declaredCases[packageName]).length,
    );
    const productive = declared.scenarios.filter(
      (scenario) => scenario.mode === "produce",
    );
    for (const scenario of productive) {
      const x = await setup(packageName);
      await boundInputs(x);
      let content = structuredClone(x.output.content) as Record<
        string,
        unknown
      >;
      if (scenario.expectState && scenario.expectState !== "UNVERIFIED") {
        content = {
          ...content,
          summary: `Synthetic ${scenario.id} fixture result; not empirical product evidence.`,
          method: "Synthetic simulated task observation fixture",
          state: scenario.expectState,
          evidenceRefs: scenario.evidenceRefs,
          limitations: [
            "Fictional test data; cannot support a product quality claim.",
          ],
        };
      }
      const draft = candidate(
        x,
        scenario.id,
        content as ArtifactSnapshot["content"],
      );
      const output: ArtifactSnapshot =
        scenario.expectState && scenario.expectState !== "UNVERIFIED"
          ? {
              ...draft,
              provenance: [
                {
                  path: "/content",
                  kind: "fact",
                  evidenceRefs: scenario.evidenceRefs!,
                },
              ],
            }
          : draft;
      expect(output.meta.type).toBe(scenario.output);
      if (scenario.evidenceRefs && packageName === "s16-design-critic") {
        expect(
          output.provenance
            .filter((entry) => entry.kind === "fact")
            .flatMap((entry) => entry.evidenceRefs ?? []),
        ).toEqual(scenario.evidenceRefs);
      }
      await x.artifacts.create(output);
      const work = await runSkillPackage({
        orchestrator: x.orchestrator,
        package: x.skill,
        runId: "run_quality",
        tasks: [x.task],
        taskId: "quality",
        at,
        executor: async (context) => {
          expect(context.package.tests["tests/scenarios.json"]).toContain(
            scenario.id,
          );
          if (scenario.id.startsWith("evidence-")) {
            const observation = JSON.parse(
              context.package.tests["tests/observations.json"]!,
            ) as {
              synthetic: boolean;
              cases: Record<string, { classification: string }>;
            };
            const classification = scenario.id.replace("evidence-", "");
            expect(observation.synthetic).toBe(true);
            expect(observation.cases[classification]?.classification).toBe(
              classification,
            );
            expect(scenario.evidenceRefs).toEqual([
              `tests/observations.json#${classification}`,
            ]);
          }
          expect(context.invocation.runId).toBe("run_quality");
          expect(context.inputs.map((input) => input.name)).toEqual(
            x.skill.manifest.inputs.required.map((input) => input.name),
          );
          const first = context.inputs[0]!;
          const original = (
            await x.artifacts.read(first.ref.artifactId, first.ref.revision)
          ).artifact;
          (first.artifact.content as Record<string, unknown>).summary =
            "executor mutation";
          expect(
            (await x.artifacts.read(first.ref.artifactId, first.ref.revision))
              .artifact,
          ).toEqual(original);
          return {
            result: {
              runId: context.invocation.runId,
              taskId: context.invocation.taskId,
              skillId: context.invocation.skillId,
              inputRefs: context.invocation.inputRefs,
              outputRefs: [exact(output)],
            },
          };
        },
      });
      expect(work.result.outputRefs).toEqual([exact(output)]);
      expect(
        (await x.registry.run("run_quality")).run.artifacts,
      ).toContainEqual(exact(output));
      if (scenario.expectCriteria) {
        const findings = (
          output.content as {
            findings: Array<{ criterion: string; state: string }>;
          }
        ).findings;
        expect(findings.map((finding) => finding.criterion)).toEqual(
          scenario.expectCriteria,
        );
        for (const [criterion, state] of Object.entries(
          scenario.expectStates ?? {},
        ))
          expect(
            findings.find((finding) => finding.criterion === criterion)?.state,
          ).toBe(state);
      }
      if (scenario.expectAlternatives) {
        const decision = output.content as {
          alternatives: string[];
          outcome: string;
        };
        expect(decision.alternatives).toEqual(scenario.expectAlternatives);
        expect(decision.outcome).toBe(scenario.expectOutcome);
        expect(output.approval.status).toBe("pending");
      }
      if (scenario.expectState) {
        const validation = output.content as {
          state: string;
          evidenceRefs: string[];
        };
        expect(validation.state).toBe(scenario.expectState);
        expect(validation.evidenceRefs).toEqual(
          scenario.expectEvidenceRefs ?? scenario.evidenceRefs,
        );
      }
    }
  });
}

test("blocked scenarios return zero outputs and retain a specific reason", async () => {
  for (const packageName of packages) {
    const x = await setup(packageName);
    await boundInputs(x);
    const scenario = x.scenarios.find((item) => item.mode === "blocked")!;
    const work = await runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_quality",
      tasks: [x.task],
      taskId: "quality",
      at,
      executor: async ({ invocation }) => ({
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [],
          blocked: {
            reason: scenario.reason!,
            affectedTaskIds: [invocation.taskId],
          },
        },
      }),
    });
    expect(work.result.outputRefs).toHaveLength(scenario.expectOutputs!);
    expect(
      (await x.registry.run("run_quality")).run.blockers.quality,
    ).toContain(scenario.reason);
  }
});

test("undeclared output and self approval cannot cross the runtime boundary", async () => {
  const undeclared = await setup("s16-design-critic");
  await boundInputs(undeclared);
  const undeclaredCase = undeclared.scenarios.find(
    (scenario) => scenario.mode === "reject-output-type",
  )!;
  expect(undeclaredCase.id).toBe("undeclared-output");
  await expect(
    runSkillPackage({
      orchestrator: undeclared.orchestrator,
      package: undeclared.skill,
      runId: "run_quality",
      tasks: [{ ...undeclared.task, outputType: undeclaredCase.output! }],
      taskId: "quality",
      at,
      executor: async () => {
        throw new Error("unreachable");
      },
    }),
  ).rejects.toThrow(/undeclared output type/);
  const x = await setup("s17-knowledge-curator");
  await boundInputs(x);
  const selfApprovalCase = x.scenarios.find(
    (scenario) => scenario.mode === "reject-self-approval",
  )!;
  const candidateOutput = candidate(x, selfApprovalCase.id);
  expect(candidateOutput.meta.type).toBe(selfApprovalCase.output);
  const selfApproved: ArtifactSnapshot = {
    ...candidateOutput,
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      actorId: x.skill.manifest.skillId,
      decisionId: "self",
      at,
    },
  };
  const signed: ArtifactSnapshot = {
    ...selfApproved,
    meta: { ...selfApproved.meta, contentDigest: artifactDigest(selfApproved) },
  };
  await expect(x.artifacts.create(signed)).rejects.toThrow(
    /Human approval is not verified/,
  );
});

test("S18 rejects an unsupported verified state and wrong Run origin", async () => {
  const x = await setup("s18-experience-validation");
  await boundInputs(x);
  const noEvidence = x.scenarios.find(
    (scenario) => scenario.mode === "reject-no-evidence",
  )!;
  const wrongRun = x.scenarios.find(
    (scenario) => scenario.mode === "reject-run",
  )!;
  const invalid = candidate(x, noEvidence.id, {
    ...(x.output.content as Record<string, unknown>),
    state: "PASS",
    evidenceRefs: [],
  } as ArtifactSnapshot["content"]);
  await expect(x.artifacts.create(invalid)).rejects.toThrow();
  expect(invalid.meta.type).toBe(noEvidence.output);
  const draft = candidate(x, wrongRun.id);
  expect(draft.meta.type).toBe(wrongRun.output);
  const wrong: ArtifactSnapshot = {
    ...draft,
    origin: {
      actorKind: "skill",
      actorId: x.skill.manifest.skillId,
      runId: "other_run",
      createdAt: at,
    },
  };
  await x.artifacts.create(wrong);
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_quality",
      tasks: [x.task],
      taskId: "quality",
      at,
      executor: async ({ invocation }) => ({
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [exact(wrong)],
        },
      }),
    }),
  ).rejects.toThrow(/Output origin mismatch/);
});

test("S17 returns an unchanged approved asset from exact Run context", async () => {
  const x = await setup("s17-knowledge-curator");
  const reuseCase = x.scenarios.find(
    (scenario) => scenario.mode === "reuse-approved",
  )!;
  await boundInputs(x, ["design-system-asset"]);
  const before = await x.registry.snapshot();
  const approved = before.canonical.art_extra_design_system_asset!.ref;
  expect(
    (await x.artifacts.read(approved.artifactId, approved.revision)).artifact
      .meta.type,
  ).toBe(reuseCase.output);
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_quality",
    tasks: [x.task],
    taskId: "quality",
    at,
    executor: async ({ invocation, inputs }) => {
      expect(
        inputs.find((input) => input.name === "existing-asset")?.ref,
      ).toEqual(approved);
      return {
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [approved],
        },
      };
    },
  });
  expect(work.result.outputRefs).toEqual([approved]);
  expect((await x.registry.run("run_quality")).run.artifacts).toEqual([]);
  expect(
    (await x.registry.snapshot()).canonical.art_extra_design_system_asset!.ref,
  ).toEqual(approved);
});

test("S17 cannot replay a rejected proposal or produce after its task closes", async () => {
  const x = await setup("s17-knowledge-curator");
  const replayCase = x.scenarios.find(
    (scenario) => scenario.mode === "reject-replay",
  )!;
  const second: RoutedTask = { ...x.task, id: "second" };
  const tasks = [x.task, second];
  await boundInputs(x, [], tasks);
  const draft = candidate(x, replayCase.id);
  expect(draft.meta.type).toBe(replayCase.output);
  const proposed: ArtifactSnapshot = {
    ...draft,
    lifecycle: { status: "proposed", freshness: "valid" },
  };
  await x.artifacts.create(proposed);
  const proposal = {
    packetId: "packet_replay",
    items: [
      {
        id: "proposal_replay",
        ref: exact(proposed),
        alternatives: ["approve", "reject"],
        rationale: "Review disposition",
        evidenceLimits: ["Illustrative fixture"],
        dependents: [],
      },
    ],
    reason: "Human review of promotion",
  };
  await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_quality",
    tasks,
    taskId: "quality",
    at,
    executor: async ({ invocation }) => ({
      result: {
        runId: invocation.runId,
        taskId: invocation.taskId,
        skillId: invocation.skillId,
        inputRefs: invocation.inputRefs,
        outputRefs: [exact(proposed)],
        proposal,
      },
    }),
  });
  const rejected: ArtifactSnapshot = {
    ...proposed,
    meta: { ...proposed.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "rejected", freshness: "valid" },
    approval: {
      status: "rejected",
      decisionId: "decision_replay",
      actorId: "human_1",
      at,
    },
  };
  const rejectedEnvelope: ArtifactSnapshot = {
    ...rejected,
    meta: { ...rejected.meta, contentDigest: artifactDigest(rejected) },
  };
  await x.registry.decide({
    id: "decision_replay",
    packetId: "packet_replay",
    proposalId: "proposal_replay",
    outcome: "rejected",
    actor: { kind: "human", id: "human_1" },
    at,
    rationale: "Reject fixture",
    output: { ref: exact(rejectedEnvelope), artifact: rejectedEnvelope },
  });
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_quality",
      tasks,
      taskId: "second",
      at,
      executor: async ({ invocation }) => ({
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [exact(proposed)],
        },
      }),
    }),
  ).rejects.toThrow(/Rejected or resolved output|Existing output belongs/);
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_quality",
      tasks,
      taskId: "quality",
      at,
      executor: async () => {
        throw new Error("closed task executed");
      },
    }),
  ).rejects.toThrow(/not routable|not available|closed/i);
});
