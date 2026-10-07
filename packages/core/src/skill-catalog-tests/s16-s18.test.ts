import { expect, test } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
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
const testRoots = new AsyncLocalStorage<string[]>();
function catalogTest(name: string, run: () => Promise<void>) {
  test(name, () =>
    testRoots.run([], async () => {
      try {
        await run();
      } finally {
        await Promise.all(
          testRoots
            .getStore()!
            .map((root) => rm(root, { recursive: true, force: true })),
        );
      }
    }),
  );
}

type Scenario = {
  id: string;
  mode: string;
  inputType: string;
  contextType?: string;
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
    "direction-critique": "produce",
    "journey-critique": "produce",
    "system-choice-critique": "produce",
    "task-model-context-critique": "produce",
    "problem-profile-context-critique": "produce",
  },
  "s17-knowledge-curator": {
    "local-disposition": "produce",
    "approved-reuse": "reuse-approved",
    "untraceable-source": "blocked",
    "self-approval": "reject-self-approval",
    "rejected-replay": "reject-replay",
    "validation-source-disposition": "produce",
    "profile-source-disposition": "produce",
    "reference-source-disposition": "produce",
  },
  "s18-experience-validation": {
    "unobserved-plan": "produce",
    "missing-target": "blocked",
    "unsupported-claim": "reject-no-evidence",
    "wrong-run": "reject-run",
    "evidence-supported": "produce",
    "evidence-mixed": "produce",
    "evidence-unsupported": "produce",
    "journey-plan": "produce",
    "direction-plan": "produce",
    "evidence-inconsistent": "produce",
    "evidence-wrong-target": "produce",
  },
};

async function setup(packageName: (typeof packages)[number]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-quality-skills-"));
  const roots = testRoots.getStore();
  if (!roots) throw new Error("setup must run inside catalogTest");
  roots.push(root);
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
    ...(packageName === "s16-design-critic"
      ? { humanBrief: "Bounded synthetic task and risk context" }
      : {}),
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
      {
        "product-ui-contract": "proposed-product-ui-contract",
        "design-direction": "approved-design-direction",
        "reference-selection": "far-reference-selection",
      }[type] ?? type;
    const fixture = JSON.parse(
      await readFile(
        path.join(repository, "fixtures/artifacts/valid", `${filename}.json`),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const proposed: ArtifactSnapshot = {
      ...fixture,
      meta: {
        id,
        type,
        schemaVersion: "1.0.0",
        revision: 1,
        title: `Fixture ${type}`,
        createdAt: at,
      },
      lifecycle: { status: "proposed", freshness: "valid" },
      approval: { status: "pending" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.fixture",
        runId: "run_seed",
        createdAt: at,
      },
      dependencies: [],
      provenance: [
        {
          path: "/content",
          kind: "assumption",
          rationale: "Synthetic fixture input",
        },
      ],
      content:
        type === "design-direction"
          ? {
              ...(fixture.content as Record<string, unknown>),
              selectionStatus: "candidate",
            }
          : fixture.content,
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
  alternativeType?: string,
  contextType?: string,
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
  const group = x.skill.manifest.inputs.alternatives[0];
  const chosen = group?.oneOf.find(
    (input) =>
      input.kind === "artifact" &&
      (!alternativeType || input.artifactType === alternativeType),
  );
  if (!chosen || chosen.kind !== "artifact")
    throw new Error(`Unsupported alternative: ${alternativeType}`);
  const chosenId = `art_${chosen.name.replaceAll("-", "_")}`;
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
  sources.push(await x.source(chosen.artifactType, chosenId));
  const contextChoice = x.skill.manifest.inputs.alternatives[1]?.oneOf.find(
    (input) => input.kind === "artifact" && input.artifactType === contextType,
  );
  if (contextType && (!contextChoice || contextChoice.kind !== "artifact"))
    throw new Error(`Unsupported task context: ${contextType}`);
  const contextId = contextChoice
    ? `art_${contextChoice.name.replaceAll("-", "_")}`
    : undefined;
  if (contextChoice && contextChoice.kind === "artifact")
    sources.push(await x.source(contextChoice.artifactType, contextId!));
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
  const ref = (await x.registry.snapshot()).canonical[chosenId]?.ref;
  if (!ref) throw new Error("Approved alternative source missing");
  const contextRef = contextId
    ? (await x.registry.snapshot()).canonical[contextId]?.ref
    : undefined;
  return {
    name: chosen.name,
    type: chosen.artifactType,
    ref,
    contextName: contextChoice?.name,
    contextRef,
  };
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

type SyntheticObservation = {
  target: string;
  device: string;
  goalCompleted: boolean;
  recordedOutcome: "completed" | "failed";
  recoveryNeeded: boolean;
  observation: string;
};
function observationState(
  observation: SyntheticObservation | undefined,
  target: string,
) {
  if (!observation || observation.target !== target) return "UNVERIFIED";
  if (observation.goalCompleted && observation.recordedOutcome === "completed")
    return observation.recoveryNeeded ? "CONCERN" : "PASS";
  if (!observation.goalCompleted && observation.recordedOutcome === "failed")
    return "FAIL";
  return "UNVERIFIED";
}

for (const packageName of packages) {
  catalogTest(
    `${packageName} declares every alternative and productive scenario`,
    async () => {
      const declared = await setup(packageName);
      expect(declared.skill.instructions.length).toBeGreaterThan(500);
      expect(declared.schemas.validate(declared.output)).toEqual({
        valid: true,
        diagnostics: [],
      });
      expect(
        Object.fromEntries(
          declared.scenarios.map(({ id, mode }) => [id, mode]),
        ),
      ).toEqual(declaredCases[packageName]);
      expect(declared.scenarios.length).toBe(
        Object.keys(declaredCases[packageName]).length,
      );
      const productive = declared.scenarios.filter(
        (scenario) => scenario.mode === "produce",
      );
      expect(new Set(productive.map((scenario) => scenario.inputType))).toEqual(
        new Set(
          declared.skill.manifest.inputs.alternatives[0]!.oneOf.filter(
            (input) => input.kind === "artifact",
          ).map((input) => input.artifactType),
        ),
      );
      if (packageName === "s16-design-critic") {
        expect(
          new Set(
            productive.flatMap((scenario) =>
              scenario.contextType ? [scenario.contextType] : [],
            ),
          ),
        ).toEqual(
          new Set(
            declared.skill.manifest.inputs.alternatives[1]!.oneOf.filter(
              (input) => input.kind === "artifact",
            ).map((input) => input.artifactType),
          ),
        );
        expect(productive.some((scenario) => !scenario.contextType)).toBe(true);
      }
    },
  );
  for (const [scenarioId, mode] of Object.entries(declaredCases[packageName])) {
    if (mode !== "produce") continue;
    catalogTest(`${packageName} executes ${scenarioId}`, async () => {
      const x = await setup(packageName);
      const scenario = x.scenarios.find((item) => item.id === scenarioId)!;
      expect(scenario.mode).toBe("produce");
      const selected = await boundInputs(
        x,
        [],
        [x.task],
        scenario.inputType,
        scenario.contextType,
      );
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
          expect(context.invocation.runId).toBe("run_quality");
          expect(context.inputs.map((input) => input.name)).toEqual([
            ...x.skill.manifest.inputs.required.map((input) => input.name),
            selected.name,
            ...(selected.contextName ? [selected.contextName] : []),
          ]);
          if (packageName === "s16-design-critic") {
            if (selected.contextRef)
              expect(
                context.inputs.find(
                  (input) => input.name === selected.contextName,
                )?.ref,
              ).toEqual(selected.contextRef);
            else
              expect(context.invocation.humanBrief).toBe(
                "Bounded synthetic task and risk context",
              );
          }
          const boundTarget = context.inputs.find(
            (input) => input.name === selected.name,
          )!;
          expect(boundTarget.ref).toEqual(selected.ref);
          expect(boundTarget.artifact.meta.type).toBe(scenario.inputType);
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

          const target = `${selected.ref.artifactId}@${selected.ref.revision}`;
          let content = structuredClone(x.output.content) as Record<
            string,
            unknown
          >;
          let provenance = x.output.provenance.map((entry) =>
            entry.kind === "derived"
              ? { ...entry, inputRefs: [target] }
              : entry,
          );
          if (
            packageName === "s16-design-critic" ||
            packageName === "s18-experience-validation"
          )
            content = { ...content, target };
          if (packageName === "s17-knowledge-curator")
            content = {
              ...content,
              question: `What is the disposition of ${target}?`,
            };
          if (packageName === "s18-experience-validation") {
            const observations = JSON.parse(
              context.package.tests["tests/observations.json"]!,
            ) as {
              synthetic: boolean;
              method: string;
              cases: Record<string, SyntheticObservation>;
            };
            expect(observations.synthetic).toBe(true);
            const key = scenario.id.startsWith("evidence-")
              ? scenario.id.slice("evidence-".length)
              : undefined;
            const record = key ? observations.cases[key] : undefined;
            if (key && !record)
              throw new Error(`Missing synthetic observation: ${key}`);
            const state = observationState(record, target);
            const evidenceRefs = key ? [`tests/observations.json#${key}`] : [];
            content = {
              ...content,
              summary: `${state} for ${target} under a synthetic fixture; no product research claim.`,
              target,
              method: observations.method,
              state,
              evidenceRefs,
              limitations: [
                record?.observation ?? "No task observation supplied",
                "Synthetic fixture only",
              ],
            };
            provenance =
              state === "UNVERIFIED"
                ? [
                    {
                      path: "/content",
                      kind: "unknown",
                      rationale:
                        "No applicable consistent empirical observation",
                    },
                  ]
                : [{ path: "/content", kind: "fact", evidenceRefs }];
          }
          const draft = candidate(
            x,
            scenario.id,
            content as ArtifactSnapshot["content"],
          );
          const output: ArtifactSnapshot = {
            ...draft,
            dependencies: context.invocation.inputRefs.map((ref) => ({
              ...ref,
              onChange: "validate",
            })),
            provenance,
          };
          await x.artifacts.create(output);
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
      const outputRef = work.result.outputRefs[0]!;
      const output = (
        await x.artifacts.read(outputRef.artifactId, outputRef.revision)
      ).artifact;
      expect(output.meta.type).toBe(scenario.output);
      expect(
        output.dependencies.some(
          (dependency) =>
            dependency.artifactId === selected.ref.artifactId &&
            dependency.revision === selected.ref.revision &&
            dependency.lockDigest === selected.ref.lockDigest,
        ),
      ).toBe(true);
      expect(
        (await x.registry.run("run_quality")).run.artifacts,
      ).toContainEqual(outputRef);
      const expectedKeys = Object.keys(scenario).filter(
        (key) => key.startsWith("expect") || key === "evidenceRefs",
      );
      const supportedExpectations: Record<string, string[]> = {
        evaluation: ["expectCriteria", "expectStates", "evidenceRefs"],
        decision: ["expectAlternatives", "expectOutcome"],
        validation: ["expectState", "expectEvidenceRefs", "evidenceRefs"],
      };
      for (const key of expectedKeys)
        expect(supportedExpectations[output.meta.type]).toContain(key);
      if (scenario.expectCriteria)
        expect(
          (
            output.content as { findings: Array<{ criterion: string }> }
          ).findings.map((item) => item.criterion),
        ).toEqual(scenario.expectCriteria);
      if (scenario.expectStates) {
        const findings = (
          output.content as {
            findings: Array<{ criterion: string; state: string }>;
          }
        ).findings;
        for (const [criterion, state] of Object.entries(scenario.expectStates))
          expect(
            findings.find((finding) => finding.criterion === criterion)?.state,
          ).toBe(state);
      }
      if (scenario.expectAlternatives)
        expect(
          (output.content as { alternatives: string[] }).alternatives,
        ).toEqual(scenario.expectAlternatives);
      if (scenario.expectOutcome)
        expect((output.content as { outcome: string }).outcome).toBe(
          scenario.expectOutcome,
        );
      if (scenario.expectState)
        expect((output.content as { state: string }).state).toBe(
          scenario.expectState,
        );
      if (scenario.expectEvidenceRefs)
        expect(
          (output.content as { evidenceRefs: string[] }).evidenceRefs,
        ).toEqual(scenario.expectEvidenceRefs);
      if (scenario.evidenceRefs) {
        const actual =
          output.meta.type === "validation"
            ? (output.content as { evidenceRefs: string[] }).evidenceRefs
            : output.provenance
                .filter((entry) => entry.kind === "fact")
                .flatMap((entry) => entry.evidenceRefs ?? []);
        expect(actual).toEqual(scenario.evidenceRefs);
      }
      if (output.meta.type === "decision")
        expect(output.approval.status).toBe("pending");
    });
  }
}

catalogTest(
  "blocked scenarios return zero outputs and retain a specific reason",
  async () => {
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
  },
);

catalogTest(
  "undeclared output and self approval cannot cross the runtime boundary",
  async () => {
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
      meta: {
        ...selfApproved.meta,
        contentDigest: artifactDigest(selfApproved),
      },
    };
    await expect(x.artifacts.create(signed)).rejects.toThrow(
      /Human approval is not verified/,
    );
  },
);

catalogTest(
  "S18 rejects an unsupported verified state and wrong Run origin",
  async () => {
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
  },
);

catalogTest(
  "S17 returns an unchanged approved asset from exact Run context",
  async () => {
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
      (await x.registry.snapshot()).canonical.art_extra_design_system_asset!
        .ref,
    ).toEqual(approved);
  },
);

catalogTest(
  "S17 cannot replay a rejected proposal or produce after its task closes",
  async () => {
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
  },
);
