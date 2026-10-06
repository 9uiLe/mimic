import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest, type JsonValue } from "../artifact-canonical.js";
import { parseArtifactYaml } from "../artifact-codec.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { loadSkillPackage, runSkillPackage } from "../skill-runtime/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemaRoot = path.join(repository, "schemas");
const at = "2026-10-06T12:00:00Z";
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
const packageNames = [
  "s10-design-direction-generator",
  "s11-direction-evaluator",
] as const;
type PackageName = (typeof packageNames)[number];
type Scenario = { id: string; expected: string; [key: string]: unknown };
type Axes = Record<
  "navigation" | "ia" | "interaction" | "spatial" | "density" | "temporal",
  string
>;
type PortfolioItem = {
  id: string;
  axes: Axes;
  mechanisms: string[];
  references: string[];
  visual?: { color: string; typography: string };
};
type DirectionExample = {
  candidate: ArtifactSnapshot;
  portfolio: PortfolioItem[];
  visualOnlyVariant: PortfolioItem & {
    visual: { color: string; typography: string };
    sameStructureAs: string;
    disposition: string;
  };
  relaxation: Record<string, string>;
  redundantOption: {
    id: string;
    sameStructureAs: string;
    visualChanges: string[];
    disposition: string;
  };
};
const roots: string[] = [];
const scenarioFields: Record<PackageName, Record<string, readonly string[]>> = {
  "s10-design-direction-generator": {
    "default-portfolio": ["expected", "min", "max"],
    "pairwise-axes": ["expected", "minimumDifferences"],
    "visual-only": ["expected", "differenceCount"],
    "redundant-regeneration": ["expected", "optionId", "sameStructureAs"],
    "constraint-relaxation": ["expected", "fields"],
    "combined-transfer": ["expected", "directionId", "references"],
    "contract-input": ["expected", "changedTerm"],
    "provisional-capability": ["expected", "availability"],
    "rejection-history": ["expected", "rejectedRevision", "newRevision"],
    "no-safe-direction": ["expected", "outputCount"],
    "exact-locks": ["expected", "minimumInputs"],
    "self-approval": ["expected", "forbiddenStatus"],
  },
  "s11-direction-evaluator": {
    "per-target": ["expected", "targets"],
    "source-criteria": ["expected", "sources"],
    "changed-goal": ["expected", "goal"],
    "unverified-empirical": ["expected", "criterion"],
    "no-score": ["expected", "field"],
    "recommend-alternative-hybrid-return": ["expected", "alternatives"],
    "failure-return": ["expected", "severity"],
    "missing-target": ["expected", "outputCount"],
    "wrong-lock": ["expected", "message"],
    "rejection-history": ["expected", "rejectedRevision", "newRevision"],
    "human-commit": ["expected", "outcome"],
    "self-approval": ["expected", "forbiddenOutcome"],
  },
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const exact = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
const exactLabel = (artifact: ArtifactSnapshot) =>
  `${artifact.meta.id}@${artifact.meta.revision}#${exact(artifact).lockDigest}`;
const structuralDifferences = (a: Axes, b: Axes) =>
  (Object.keys(a) as (keyof Axes)[]).filter((axis) => a[axis] !== b[axis]);

async function setup(name: PackageName, authorityFixture = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-direction-skills-"));
  roots.push(root);
  const schemas = await loadSchemaDirectory(path.join(schemaRoot, "artifacts"));
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
    scopes,
    {
      async verify(record: { actor: { kind: string; id: string } }) {
        return (
          authorityFixture &&
          record.actor.kind === "human" &&
          record.actor.id === "human_1"
        );
      },
      async allowCommit() {
        return authorityFixture;
      },
    },
    authorityFixture
      ? {
          async verifyApproval(approval) {
            return (
              approval.decisionId === "seed_human" &&
              approval.actorId === "human_1"
            );
          },
          async verifyDecision(id) {
            return id === "seed_human";
          },
        }
      : undefined,
  );
  const skill = await loadSkillPackage(
    path.join(repository, "skills", name),
    schemaRoot,
  );
  const scenarios = (
    JSON.parse(skill.tests["tests/scenarios.json"]!) as {
      scenarios: Scenario[];
    }
  ).scenarios;
  expect(new Set(scenarios.map((item) => item.id)).size).toBe(scenarios.length);
  expect(scenarios.map((item) => item.id).sort()).toEqual(
    Object.keys(scenarioFields[name]).sort(),
  );
  for (const scenario of scenarios)
    expect(Object.keys(scenario).sort()).toEqual(
      ["id", ...scenarioFields[name][scenario.id]!].sort(),
    );
  const task: RoutedTask = {
    id: "target",
    skillId: skill.manifest.skillId,
    outputType: skill.manifest.outputs[0]!,
    additionalOutputTypes: skill.manifest.outputs.slice(1),
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: {
      required: skill.manifest.inputs.required.map((input) => ({ ...input })),
      optional: skill.manifest.inputs.optional.map((input) => ({ ...input })),
      alternatives: skill.manifest.inputs.alternatives.map((group) => ({
        oneOf: group.oneOf.map((input) => ({ ...input })),
      })),
    },
  };
  return { ...runtime, schemas, skill, scenarios, task };
}

async function fixture(type: string): Promise<ArtifactSnapshot> {
  const file =
    type === "problem-profile"
      ? "skills/s08-design-problem-profiler/examples/profile.json"
      : type === "reference-selection"
        ? "skills/s09-design-space-explorer/examples/selection.json"
        : type === "product-ui-contract"
          ? "fixtures/artifacts/valid/proposed-product-ui-contract.yaml"
          : type === "design-direction"
            ? "skills/s10-design-direction-generator/examples/directions.json"
            : `fixtures/artifacts/valid/${type}.json`;
  const value = parseArtifactYaml(
    await readFile(path.join(repository, file), "utf8"),
  );
  return (
    type === "design-direction" ? (value as DirectionExample).candidate : value
  ) as ArtifactSnapshot;
}

async function seed(
  x: Awaited<ReturnType<typeof setup>>,
  runId: string,
  type: string,
  id: string,
  contentChange?: (content: JsonValue) => JsonValue,
) {
  const source = await fixture(type);
  const artifact: ArtifactSnapshot = {
    ...source,
    meta: {
      id,
      type,
      schemaVersion: "1.0.0",
      revision: 1,
      title: `Fixture ${type}`,
      createdAt: at,
    },
    lifecycle: { status: "provisional", freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: "mimic.fixture",
      runId,
      createdAt: at,
    },
    dependencies: [],
    approval: { status: "pending" },
    content: contentChange ? contentChange(source.content) : source.content,
    provenance: [
      {
        path: "/content",
        kind: "assumption",
        rationale: "Synthetic fixture, not observed behavior",
      },
    ],
  };
  await x.artifacts.create(artifact);
  await x.registry.produce({
    runId,
    ref: exact(artifact),
    inputs: [],
    actor: { kind: "skill", id: "mimic.fixture" },
    at,
    reason: "Synthetic locked input",
  });
  return artifact;
}

async function startWithInputs(
  x: Awaited<ReturnType<typeof setup>>,
  inputTypes: readonly string[],
  runId: string,
  changes: Record<string, (content: JsonValue) => JsonValue> = {},
  extraTaskIds: readonly string[] = [],
) {
  const tasks: RoutedTask[] = [
    ...inputTypes.map((type, index) => ({
      id: `seed-${index}`,
      skillId: "mimic.fixture",
      outputType: type,
      scopeOwnerId: "product_mimic",
      intent: "create" as const,
      authority: "AUTONOMOUS" as const,
      inputs: { required: [], optional: [], alternatives: [] },
    })),
    x.task,
    ...extraTaskIds.map((id) => ({ ...x.task, id })),
  ];
  await x.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks,
  });
  const inputs: ArtifactSnapshot[] = [];
  for (const [index, type] of inputTypes.entries())
    inputs.push(
      await seed(x, runId, type, `art_${runId}_input_${index}`, changes[type]),
    );
  const required = x.skill.manifest.inputs.required;
  const optional = x.skill.manifest.inputs.optional;
  const bound = new Set<number>();
  const bind = (need: (typeof required)[number]) => {
    if (need.kind !== "artifact") return { ...need };
    const positions = inputTypes.flatMap((type, index) =>
      type === need.artifactType ? [index] : [],
    );
    if (!positions.length) return { ...need };
    positions.forEach((index) => bound.add(index));
    return { ...need, refs: positions.map((index) => exact(inputs[index]!)) };
  };
  const target: RoutedTask = {
    ...x.task,
    inputs: {
      required: required.map(bind),
      optional: optional.map(bind),
      alternatives: [],
    },
  };
  expect(bound.size).toBe(inputTypes.length);
  const routed = [
    ...tasks.slice(0, -(extraTaskIds.length + 1)),
    target,
    ...extraTaskIds.map((id) => ({ ...target, id })),
  ];
  await x.registry.setWork({
    runId,
    safeActions: ["target", ...extraTaskIds],
    blockers: {},
    actor: { kind: "agent", id: "agent_1" },
    at,
    reason: "Inputs ready",
  });
  return { inputs, tasks: routed };
}

function proposal(
  example: ArtifactSnapshot,
  id: string,
  skillId: string,
  runId: string,
  inputs: readonly ArtifactSnapshot[],
  content: JsonValue,
  provenance: ArtifactSnapshot["provenance"],
): ArtifactSnapshot {
  return {
    ...example,
    meta: { ...example.meta, id, title: id, createdAt: at },
    origin: { actorKind: "skill", actorId: skillId, runId, createdAt: at },
    dependencies: inputs.map((input) => ({
      ...exact(input),
      onChange: "validate" as const,
    })),
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    content,
    provenance,
  };
}

test("S10 scenario inventory checks divergence semantics independently", async () => {
  const x = await setup(packageNames[0]);
  const example = JSON.parse(
    x.skill.examples["examples/directions.json"]!,
  ) as DirectionExample;
  const decision = JSON.parse(
    x.skill.examples["examples/selection-proposal.json"]!,
  ) as ArtifactSnapshot;
  expect(x.schemas.validate(example.candidate).valid).toBe(true);
  expect(x.schemas.validate(decision).valid).toBe(true);
  expect(new Set(x.scenarios.map((item) => item.id)).size).toBe(
    x.scenarios.length,
  );
  expect(x.scenarios.map((item) => item.id).sort()).toEqual(
    [
      "default-portfolio",
      "pairwise-axes",
      "visual-only",
      "redundant-regeneration",
      "constraint-relaxation",
      "combined-transfer",
      "contract-input",
      "provisional-capability",
      "rejection-history",
      "no-safe-direction",
      "exact-locks",
      "self-approval",
    ].sort(),
  );
  for (const item of x.scenarios)
    switch (item.id) {
      case "default-portfolio":
        expect(item.expected).toBe("ready");
        expect(example.portfolio.length).toBeGreaterThanOrEqual(
          item.min as number,
        );
        expect(example.portfolio.length).toBeLessThanOrEqual(
          item.max as number,
        );
        break;
      case "pairwise-axes":
        expect(item.expected).toBe("distinct");
        for (const [i, a] of example.portfolio.entries())
          for (const b of example.portfolio.slice(i + 1))
            expect(
              structuralDifferences(a.axes, b.axes).length,
            ).toBeGreaterThanOrEqual(item.minimumDifferences as number);
        break;
      case "visual-only":
        expect(item.expected).toBe("redundant");
        expect(example.visualOnlyVariant.id).not.toBe(example.portfolio[0]!.id);
        expect(example.visualOnlyVariant.sameStructureAs).toBe(
          example.portfolio[0]!.id,
        );
        expect(
          structuralDifferences(
            example.portfolio[0]!.axes,
            example.visualOnlyVariant.axes,
          ).length,
        ).toBe(item.differenceCount);
        expect(example.visualOnlyVariant.mechanisms).toEqual(
          example.portfolio[0]!.mechanisms,
        );
        expect(example.visualOnlyVariant.visual?.color).not.toBe(
          example.portfolio[0]!.visual?.color,
        );
        expect(example.visualOnlyVariant.visual?.typography).not.toBe(
          example.portfolio[0]!.visual?.typography,
        );
        expect(example.visualOnlyVariant.disposition).toMatch(
          /merge.*regenerate/,
        );
        break;
      case "redundant-regeneration":
        expect(item.expected).toBe("regenerate");
        expect(example.redundantOption.id).toBe(item.optionId);
        expect(example.redundantOption.sameStructureAs).toBe(
          item.sameStructureAs,
        );
        expect(example.redundantOption.disposition).toMatch(/regenerate/);
        expect(example.visualOnlyVariant.disposition).toBe(
          example.redundantOption.disposition,
        );
        break;
      case "constraint-relaxation":
        expect(item.expected).toBe("recorded");
        for (const field of item.fields as string[])
          expect(example.relaxation[field]?.trim()).toBeTruthy();
        expect(example.relaxation.result).toMatch(/original|preserve/i);
        break;
      case "combined-transfer": {
        const direction = example.portfolio.find(
          (entry) => entry.id === item.directionId,
        );
        expect(item.expected).toBe("combined");
        expect(direction?.references).toEqual(item.references);
        expect(
          example.candidate.provenance.filter((entry) =>
            entry.path.startsWith("/content/mechanisms/"),
          ).length,
        ).toBe(2);
        break;
      }
      case "contract-input":
        expect(item.expected).toBe("changes-output");
        expect(item.changedTerm as string).not.toBe("Incident ID");
        break;
      case "provisional-capability":
        expect(item.expected).toBe("candidate");
        expect(item.availability).toBe("proposed");
        expect(example.candidate.content).toHaveProperty(
          "selectionStatus",
          "candidate",
        );
        break;
      case "rejection-history":
        expect(item.expected).toBe("preserved");
        expect(item.newRevision).toBe((item.rejectedRevision as number) + 1);
        expect(x.skill.instructions).toMatch(/rejected revision/);
        break;
      case "no-safe-direction":
        expect(item.expected).toBe("blocked");
        expect(item.outputCount).toBe(0);
        break;
      case "exact-locks":
        expect(item.expected).toBe("preserved");
        expect(x.skill.manifest.inputs.required.length).toBeGreaterThanOrEqual(
          item.minimumInputs as number,
        );
        break;
      case "self-approval":
        expect(item.expected).toBe("rejected");
        expect(item.forbiddenStatus).toBe("selected");
        expect(decision.content).toHaveProperty("outcome", "proposed");
        break;
      default:
        throw new Error(`Unhandled S10 scenario ${item.id}`);
    }
});

test("S10 bridge creates several candidate artifacts from exact inputs and records a blocked zero-output task", async () => {
  const x = await setup(packageNames[0]);
  const runId = "run_s10_bridge";
  const { inputs, tasks } = await startWithInputs(
    x,
    [
      "problem-profile",
      "product-ui-contract",
      "reference-selection",
      "system-capability",
    ],
    runId,
  );
  const example = JSON.parse(
    x.skill.examples["examples/directions.json"]!,
  ) as DirectionExample;
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId,
    tasks,
    taskId: "target",
    at,
    executor: async ({ invocation, inputs: bound, gaps }) => {
      expect(bound.map((input) => input.ref)).toEqual(invocation.inputRefs);
      expect(gaps).toContain("brand");
      const contract = bound.find(
        (input) => input.name === "product-ui-contract",
      )!.artifact;
      const context = (
        contract.content as { entityContext: string[] }
      ).entityContext.join(" ");
      const profile = bound.find(
        (input) => input.name === "problem-profile",
      )!.artifact;
      const principle = (profile.content as { principles: string[] })
        .principles[0]!;
      const outputs: ArtifactSnapshot[] = [];
      for (const [index, entry] of example.portfolio.entries()) {
        const content = {
          summary: `${entry.id} preserves ${context}; proposed capability remains mock-only.`,
          principles: [principle],
          mechanisms: entry.mechanisms.map(
            (mechanism) => `${mechanism}; preserve ${context}`,
          ),
          selectionStatus: "candidate",
        };
        const artifact = proposal(
          example.candidate,
          `art_s10_${entry.id}`,
          x.skill.manifest.skillId,
          runId,
          inputs,
          content,
          [
            {
              path: "/content/principles/0",
              kind: "derived",
              inputRefs: [exactLabel(inputs[0]!)],
              rationale: "Profile principle",
            },
            {
              path: "/content/mechanisms",
              kind: "derived",
              inputRefs: [exactLabel(inputs[1]!), exactLabel(inputs[2]!)],
              rationale: `Structural mechanisms and contract context; ${entry.references.join(" + ")}; no copied UI.`,
            },
            {
              path: "/content/summary",
              kind: "assumption",
              rationale:
                "Capability is proposed; preview behavior is mock only.",
            },
          ],
        );
        await x.artifacts.create(artifact);
        outputs.push(artifact);
        expect(index).toBeLessThan(7);
      }
      return {
        result: {
          runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: outputs.map(exact),
        },
      };
    },
  });
  expect(work.result.outputRefs).toHaveLength(example.portfolio.length);
  for (const ref of work.result.outputRefs) {
    const stored = (await x.artifacts.read(ref.artifactId, ref.revision))
      .artifact;
    expect(
      stored.dependencies.map(({ artifactId, revision, lockDigest }) => ({
        artifactId,
        revision,
        lockDigest,
      })),
    ).toEqual(inputs.map(exact));
    expect(stored.content).toHaveProperty("selectionStatus", "candidate");
    expect(stored.approval.status).toBe("pending");
    expect(
      stored.provenance.some(
        (entry) =>
          entry.kind === "derived" &&
          Array.isArray(entry.inputRefs) &&
          entry.inputRefs.includes(exactLabel(inputs[1]!)),
      ),
    ).toBe(true);
  }
  const changed = {
    ...(inputs[1]!.content as Record<string, unknown>),
    entityContext: ["Case ID"],
  };
  expect(JSON.stringify(changed)).not.toEqual(
    JSON.stringify(inputs[1]!.content),
  );
  expect(work.result.outputRefs.length).toBeGreaterThanOrEqual(4);
  const y = await setup(packageNames[0]);
  const blockedScenario = y.scenarios.find(
    (item) => item.id === "no-safe-direction",
  )!;
  const blockedRun = "run_s10_blocked";
  const prepared = await startWithInputs(
    y,
    ["problem-profile", "product-ui-contract", "reference-selection"],
    blockedRun,
  );
  const count = (await y.registry.run(blockedRun)).run.artifacts.length;
  const blocked = await runSkillPackage({
    orchestrator: y.orchestrator,
    package: y.skill,
    runId: blockedRun,
    tasks: prepared.tasks,
    taskId: "target",
    at,
    executor: async ({ invocation }) => ({
      result: {
        runId: blockedRun,
        taskId: invocation.taskId,
        skillId: invocation.skillId,
        inputRefs: invocation.inputRefs,
        outputRefs: [],
        blocked: {
          reason: "No direction preserves the required entity return path",
          affectedTaskIds: [invocation.taskId],
        },
      },
    }),
  });
  expect(blockedScenario.expected).toBe("blocked");
  expect(blocked.result.outputRefs).toHaveLength(
    blockedScenario.outputCount as number,
  );
  expect((await y.registry.run(blockedRun)).run.artifacts).toHaveLength(count);
  expect((await y.registry.run(blockedRun)).run.blockers.target).toMatch(
    /return path/,
  );
});

test("S11 inventory and bridge retain source-specific findings and pending alternatives", async () => {
  const x = await setup(packageNames[1]);
  const runId = "run_s11_bridge";
  const { inputs, tasks } = await startWithInputs(
    x,
    [
      "design-direction",
      "design-direction",
      "problem-profile",
      "product-ui-contract",
      "brand",
      "product-definition",
    ],
    runId,
  );
  const outputExample = JSON.parse(
    x.skill.examples["examples/evaluation.json"]!,
  ) as ArtifactSnapshot;
  const choiceExample = JSON.parse(
    x.skill.examples["examples/decision.json"]!,
  ) as ArtifactSnapshot;
  expect(x.schemas.validate(outputExample).valid).toBe(true);
  expect(x.schemas.validate(choiceExample).valid).toBe(true);
  expect(x.scenarios.map((item) => item.id).sort()).toEqual(
    [
      "per-target",
      "source-criteria",
      "changed-goal",
      "unverified-empirical",
      "no-score",
      "recommend-alternative-hybrid-return",
      "failure-return",
      "missing-target",
      "wrong-lock",
      "rejection-history",
      "human-commit",
      "self-approval",
    ].sort(),
  );
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId,
    tasks,
    taskId: "target",
    at,
    executor: async ({ invocation, inputs: bound }) => {
      expect(bound.map((input) => input.ref)).toEqual(invocation.inputRefs);
      const directions = bound.filter(
        (input) => input.name === "design-direction",
      );
      expect(directions).toHaveLength(2);
      const profile = bound.find((input) => input.name === "problem-profile")!;
      const contract = bound.find(
        (input) => input.name === "product-ui-contract",
      )!;
      const brand = bound.find((input) => input.name === "brand")!;
      const goal = bound.find((input) => input.name === "product-definition")!;
      const criteria = [
        {
          criterion: `Task: ${(profile.artifact.content as { traits: string[] }).traits[0]}`,
          state: "PASS",
          severity: "MAJOR",
          reason:
            "Candidate describes an accountable handoff structure; task outcome is not empirically established.",
        },
        {
          criterion: `Contract: ${(contract.artifact.content as { entityContext: string[] }).entityContext[0]}`,
          state: "CONCERN",
          severity: "MAJOR",
          reason: "Check entity continuity in a prototype before adoption.",
        },
        {
          criterion: `Brand: ${(brand.artifact.content as { attributes: string[] }).attributes[0]}`,
          state: "UNVERIFIED",
          severity: "MINOR",
          reason: "Brand expression has not yet been designed.",
        },
        {
          criterion: `Goal: ${(goal.artifact.content as { goals: string[] }).goals[0]}`,
          state: "CONCERN",
          severity: "MINOR",
          reason: "Goal fit needs a task walkthrough.",
        },
        {
          criterion: "Actual handoff comprehension",
          state: "UNVERIFIED",
          severity: "MAJOR",
          reason: "No operator observation was supplied.",
        },
      ];
      const evaluations: ArtifactSnapshot[] = [];
      for (const [index, direction] of directions.entries()) {
        const artifact = proposal(
          outputExample,
          `art_eval_${index}`,
          x.skill.manifest.skillId,
          runId,
          inputs,
          {
            summary: "Scoped structural comparison, with empirical gaps.",
            target: `${direction.artifact.meta.id}@${direction.artifact.meta.revision}`,
            findings: criteria,
          },
          [
            ...[profile, contract, brand, goal].map((source, position) => ({
              path: `/content/findings/${position}`,
              kind: "derived" as const,
              inputRefs: [
                exactLabel(source.artifact),
                exactLabel(direction.artifact),
              ],
              rationale: `Criterion derived from ${source.artifact.meta.type} exact input.`,
            })),
            {
              path: "/content/findings/4",
              kind: "unknown",
              rationale:
                "No operator observation supplied; cannot mark empirical comprehension PASS.",
            },
          ],
        );
        await x.artifacts.create(artifact);
        evaluations.push(artifact);
      }
      const choice = proposal(
        choiceExample,
        "art_eval_choice",
        x.skill.manifest.skillId,
        runId,
        inputs,
        choiceExample.content,
        [
          {
            path: "/content/alternatives",
            kind: "derived",
            inputRefs: directions.map((entry) => exactLabel(entry.artifact)),
            rationale: `Per-target evaluations ${evaluations.map(exactLabel).join(", ")} inform proposals for human selection.`,
          },
        ],
      );
      await x.artifacts.create(choice);
      return {
        result: {
          runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [...evaluations, choice].map(exact),
        },
      };
    },
  });
  const outputs = await Promise.all(
    work.result.outputRefs.map(
      async (ref) =>
        (await x.artifacts.read(ref.artifactId, ref.revision)).artifact,
    ),
  );
  const evaluations = outputs.filter(
    (output) => output.meta.type === "evaluation",
  );
  const choice = outputs.find((output) => output.meta.type === "decision")!;
  for (const item of x.scenarios)
    switch (item.id) {
      case "per-target":
        expect(item.expected).toBe("evaluated");
        expect(evaluations).toHaveLength(item.targets as number);
        break;
      case "source-criteria":
        expect(item.expected).toBe("sourced");
        for (const source of item.sources as string[])
          expect(
            evaluations[0]!.provenance.some((entry) =>
              entry.rationale?.includes(source),
            ),
          ).toBe(true);
        break;
      case "changed-goal":
        expect(item.expected).toBe("changes-criteria");
        expect(`Goal: ${item.goal}`).not.toBe(
          (
            evaluations[0]!.content as { findings: { criterion: string }[] }
          ).findings.find((finding) => finding.criterion.startsWith("Goal:"))
            ?.criterion,
        );
        break;
      case "unverified-empirical":
        expect(
          (
            evaluations[0]!.content as {
              findings: { criterion: string; state: string }[];
            }
          ).findings.find((finding) => finding.criterion === item.criterion)
            ?.state,
        ).toBe(item.expected);
        break;
      case "no-score":
        expect(item.expected).toBe("absent");
        for (const evaluation of evaluations)
          expect(evaluation.content).not.toHaveProperty(item.field as string);
        break;
      case "recommend-alternative-hybrid-return":
        expect(choice.content).toHaveProperty(
          "alternatives",
          item.alternatives,
        );
        expect(choice.content).toHaveProperty("outcome", item.expected);
        break;
      case "failure-return":
        // Exercised with two FAIL/BLOCKER candidates in the separate bridge test.
        break;
      case "missing-target":
        // Exercised by the missing-direction router test.
        break;
      case "wrong-lock":
        expect(item.expected).toBe("rejected");
        // The declared message is asserted against ArtifactStore below.
        break;
      case "rejection-history":
        // Exercised with a human rejection and new revision below.
        break;
      case "human-commit":
        expect(choice.approval.status).toBe(item.expected);
        expect(choice.content).toHaveProperty("outcome", item.outcome);
        expect(choice.lifecycle.status).toBe("proposed");
        break;
      case "self-approval":
        // Exercised against the shared runtime below.
        break;
      default:
        throw new Error(`Unhandled S11 scenario ${item.id}`);
    }
  for (const evaluation of evaluations) {
    expect(
      evaluation.dependencies.map(({ artifactId, revision, lockDigest }) => ({
        artifactId,
        revision,
        lockDigest,
      })),
    ).toEqual(inputs.map(exact));
    expect(evaluation.approval.status).toBe("pending");
  }
  expect(choice.dependencies).toHaveLength(inputs.length);
  expect((await x.registry.run(runId)).run.artifacts).toEqual(
    expect.arrayContaining([...work.result.outputRefs]),
  );
  const wrong: ArtifactSnapshot = {
    ...evaluations[0]!,
    meta: { ...evaluations[0]!.meta, id: "art_bad_lock" },
    dependencies: [
      {
        ...evaluations[0]!.dependencies[0]!,
        lockDigest: `sha256:${"0".repeat(64)}`,
      },
    ],
  };
  await expect(x.artifacts.create(wrong)).rejects.toThrow(
    x.scenarios.find((item) => item.id === "wrong-lock")!.message as string,
  );
});

test("changed locked inputs change S10 mechanisms and S11 criteria", async () => {
  const s10 = await setup(packageNames[0]);
  const changedContract = s10.scenarios.find(
    (item) => item.id === "contract-input",
  )!;
  const s11 = await setup(packageNames[1]);
  const changedGoal = s11.scenarios.find((item) => item.id === "changed-goal")!;
  async function directionFor(entity: string) {
    const x = await setup(packageNames[0]);
    const runId = `run_s10_${entity.replaceAll(" ", "_")}`;
    const { inputs, tasks } = await startWithInputs(
      x,
      ["problem-profile", "product-ui-contract", "reference-selection"],
      runId,
      {
        "product-ui-contract": (value) => ({
          ...(value as Record<string, JsonValue>),
          entityContext: [entity],
        }),
      },
    );
    const example = (
      JSON.parse(
        x.skill.examples["examples/directions.json"]!,
      ) as DirectionExample
    ).candidate;
    const work = await runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks,
      taskId: "target",
      at,
      executor: async ({ invocation, inputs: bound }) => {
        const contract = bound.find(
          (input) => input.name === "product-ui-contract",
        )!.artifact;
        const entityName = (contract.content as { entityContext: string[] })
          .entityContext[0]!;
        const output = proposal(
          example,
          "art_direction",
          x.skill.manifest.skillId,
          runId,
          inputs,
          {
            summary: `Preserve ${entityName} across handoff`,
            principles: ["Preserve entity continuity"],
            mechanisms: [`Navigate by ${entityName}`, "Acknowledge next actor"],
            selectionStatus: "candidate",
          },
          [
            {
              path: "/content/mechanisms/0",
              kind: "derived",
              inputRefs: [exactLabel(contract)],
              rationale: "The navigation key comes from the exact contract.",
            },
          ],
        );
        await x.artifacts.create(output);
        return {
          result: {
            runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [exact(output)],
          },
        };
      },
    });
    return {
      artifact: (await x.artifacts.read("art_direction", 1)).artifact,
      locks: work.result.inputRefs,
    };
  }
  const incident = await directionFor("Incident ID");
  const caseId = await directionFor(changedContract.changedTerm as string);
  expect(changedContract.expected).toBe("changes-output");
  expect(incident.artifact.content).not.toEqual(caseId.artifact.content);
  expect(incident.locks[1]?.lockDigest).not.toBe(caseId.locks[1]?.lockDigest);
  expect(caseId.artifact.provenance[0]?.inputRefs).toContain(
    `${caseId.locks[1]!.artifactId}@1#${caseId.locks[1]!.lockDigest}`,
  );

  async function criteriaFor(goalText: string) {
    const x = await setup(packageNames[1]);
    const runId = `run_s11_${goalText.replaceAll(" ", "_")}`;
    const { inputs, tasks } = await startWithInputs(
      x,
      [
        "design-direction",
        "problem-profile",
        "product-ui-contract",
        "product-definition",
      ],
      runId,
      {
        "product-definition": (value) => ({
          ...(value as Record<string, JsonValue>),
          goals: [goalText],
        }),
      },
    );
    const example = JSON.parse(
      x.skill.examples["examples/evaluation.json"]!,
    ) as ArtifactSnapshot;
    await runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks,
      taskId: "target",
      at,
      executor: async ({ invocation, inputs: bound }) => {
        const goal = bound.find(
          (input) => input.name === "product-definition",
        )!.artifact;
        const text = (goal.content as { goals: string[] }).goals[0]!;
        const output = proposal(
          example,
          "art_evaluation",
          x.skill.manifest.skillId,
          runId,
          inputs,
          {
            summary: `Evaluate ${text} against this candidate`,
            target: `${inputs[0]!.meta.id}@1`,
            findings: [
              {
                criterion: `Goal: ${text}`,
                state: "UNVERIFIED",
                severity: "MAJOR",
                reason: "No user observation establishes goal attainment.",
              },
            ],
          },
          [
            {
              path: "/content/findings/0",
              kind: "derived",
              inputRefs: [exactLabel(goal)],
              rationale: "The criterion comes from the exact product goal.",
            },
          ],
        );
        await x.artifacts.create(output);
        return {
          result: {
            runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [exact(output)],
          },
        };
      },
    });
    return (await x.artifacts.read("art_evaluation", 1)).artifact;
  }
  const traceability = await criteriaFor("Versioned Design Package");
  const escalation = await criteriaFor(changedGoal.goal as string);
  expect(changedGoal.expected).toBe("changes-criteria");
  expect(traceability.content).not.toEqual(escalation.content);
  expect(
    (escalation.content as { findings: { criterion: string }[] }).findings[0]
      ?.criterion,
  ).toBe(`Goal: ${changedGoal.goal}`);
  expect(
    (escalation.content as { findings: { state: string }[] }).findings[0]
      ?.state,
  ).toBe("UNVERIFIED");
});

test("S11 returns to divergence when every candidate fails an essential contract criterion", async () => {
  const x = await setup(packageNames[1]);
  const scenario = x.scenarios.find((item) => item.id === "failure-return")!;
  const runId = "run_s11_failure";
  const { inputs, tasks } = await startWithInputs(
    x,
    [
      "design-direction",
      "design-direction",
      "problem-profile",
      "product-ui-contract",
    ],
    runId,
    {
      "design-direction": (value) => ({
        ...(value as Record<string, JsonValue>),
        summary: "A detached handoff queue without an incident return path",
        mechanisms: ["Role-only queue", "Send work to another role"],
      }),
    },
  );
  const outputExample = JSON.parse(
    x.skill.examples["examples/evaluation.json"]!,
  ) as ArtifactSnapshot;
  const decisionExample = JSON.parse(
    x.skill.examples["examples/decision.json"]!,
  ) as ArtifactSnapshot;
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId,
    tasks,
    taskId: "target",
    at,
    executor: async ({ invocation, inputs: bound }) => {
      const directions = bound.filter(
        (input) => input.name === "design-direction",
      );
      const contract = bound.find(
        (input) => input.name === "product-ui-contract",
      )!.artifact;
      const entity = (contract.content as { entityContext: string[] })
        .entityContext[0]!;
      const evaluations: ArtifactSnapshot[] = [];
      for (const [index, direction] of directions.entries()) {
        const mechanisms = (
          direction.artifact.content as { mechanisms: string[] }
        ).mechanisms;
        const preservesContext = mechanisms.some(
          (mechanism) =>
            mechanism.includes(entity) && mechanism.includes("return path"),
        );
        const evaluation = proposal(
          outputExample,
          `art_failed_eval_${index}`,
          x.skill.manifest.skillId,
          runId,
          inputs,
          {
            summary: `Candidate ${index} must retain ${entity} and a return path`,
            target: `${direction.artifact.meta.id}@1`,
            findings: [
              {
                criterion: `Contract: preserve ${entity} and return path`,
                state: preservesContext ? "PASS" : "FAIL",
                severity: preservesContext ? "MAJOR" : "BLOCKER",
                reason: preservesContext
                  ? "Both mechanisms are explicit."
                  : `No ${entity} return path is present in the stated mechanisms.`,
              },
            ],
          },
          [
            {
              path: "/content/findings/0",
              kind: "derived",
              inputRefs: [exactLabel(contract), exactLabel(direction.artifact)],
              rationale:
                "The essential criterion comes from the exact contract and target mechanism.",
            },
          ],
        );
        await x.artifacts.create(evaluation);
        evaluations.push(evaluation);
      }
      const allBlocked = evaluations.every((evaluation) =>
        (
          evaluation.content as {
            findings: { state: string; severity: string }[];
          }
        ).findings.some(
          (finding) =>
            finding.state === "FAIL" && finding.severity === "BLOCKER",
        ),
      );
      const choice = proposal(
        decisionExample,
        "art_failed_choice",
        x.skill.manifest.skillId,
        runId,
        inputs,
        {
          summary: "No candidate preserves essential entity continuity.",
          question: "Should the candidate set return to divergence?",
          alternatives: allBlocked
            ? ["Return to divergence"]
            : ["Review a viable candidate"],
          outcome: "proposed",
          rationale: allBlocked
            ? `Regenerate mechanisms that preserve ${entity} and a return path.`
            : "Review the passing structure.",
        },
        [
          {
            path: "/content/alternatives",
            kind: "derived",
            inputRefs: directions.map((direction) =>
              exactLabel(direction.artifact),
            ),
            rationale: `Each candidate was assessed against the exact ${entity} contract.`,
          },
        ],
      );
      await x.artifacts.create(choice);
      return {
        result: {
          runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [...evaluations, choice].map(exact),
        },
      };
    },
  });
  const outputs = await Promise.all(
    work.result.outputRefs.map(
      async (ref) =>
        (await x.artifacts.read(ref.artifactId, ref.revision)).artifact,
    ),
  );
  const evaluations = outputs.filter(
    (output) => output.meta.type === "evaluation",
  );
  const choice = outputs.find((output) => output.meta.type === "decision")!;
  const entity = (inputs[3]!.content as { entityContext: string[] })
    .entityContext[0]!;
  expect(evaluations).toHaveLength(2);
  for (const [index, evaluation] of evaluations.entries()) {
    const mechanisms = (
      inputs[index]!.content as { mechanisms: string[] }
    ).mechanisms.join(" ");
    expect(mechanisms).not.toContain(entity);
    expect(mechanisms).not.toContain("return path");
    expect(
      (
        evaluation.content as {
          findings: { state: string; severity: string }[];
        }
      ).findings[0],
    ).toEqual(
      expect.objectContaining({ state: "FAIL", severity: scenario.severity }),
    );
  }
  expect(scenario.expected).toBe("return-to-divergence");
  expect(choice.content).toHaveProperty("alternatives", [
    "Return to divergence",
  ]);
  expect(choice.content).toHaveProperty("outcome", "proposed");
  expect(choice.approval.status).toBe("pending");
});

test("S11 router blocks a missing direction before any evaluation is written", async () => {
  const x = await setup(packageNames[1]);
  const scenario = x.scenarios.find((item) => item.id === "missing-target")!;
  const runId = "run_s11_missing";
  const tasks: RoutedTask[] = [
    ...["problem-profile", "product-ui-contract"].map((type, index) => ({
      id: `seed-${index}`,
      skillId: "mimic.fixture",
      outputType: type,
      scopeOwnerId: "product_mimic",
      intent: "create" as const,
      authority: "AUTONOMOUS" as const,
      inputs: { required: [], optional: [], alternatives: [] },
    })),
    x.task,
  ];
  await x.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks,
  });
  await seed(x, runId, "problem-profile", "art_missing_profile");
  await seed(x, runId, "product-ui-contract", "art_missing_contract");
  const action = (await x.orchestrator.next(runId, tasks)).actions.find(
    (item) => item.taskId === "target",
  );
  expect(scenario.expected).toBe("blocked");
  expect(action?.action).toBe("BLOCK");
  expect(action?.reason).toContain("design-direction");
  expect((await x.registry.run(runId)).run.artifacts).toHaveLength(2);
  expect(
    (await x.registry.run(runId)).run.artifacts.filter((ref) =>
      ref.artifactId.startsWith("art_eval"),
    ),
  ).toHaveLength(scenario.outputCount as number);
});

for (const name of packageNames)
  test(`${name} preserves a human-rejected envelope and proposes a new revision`, async () => {
    const x = await setup(name, true);
    const scenario = x.scenarios.find(
      (item) => item.id === "rejection-history",
    )!;
    const runId = `run_history_${name.slice(0, 3)}`;
    const types =
      name === packageNames[0]
        ? ["problem-profile", "product-ui-contract", "reference-selection"]
        : ["design-direction", "problem-profile", "product-ui-contract"];
    const { inputs, tasks } = await startWithInputs(x, types, runId, {}, [
      "retry",
    ]);
    const example =
      name === packageNames[0]
        ? (
            JSON.parse(
              x.skill.examples["examples/directions.json"]!,
            ) as DirectionExample
          ).candidate
        : (JSON.parse(
            x.skill.examples["examples/evaluation.json"]!,
          ) as ArtifactSnapshot);
    const artifactId = `art_history_${name.slice(0, 3)}`;
    const first = proposal(
      example,
      artifactId,
      x.skill.manifest.skillId,
      runId,
      inputs,
      example.content,
      [
        {
          path: "/content",
          kind: "derived",
          inputRefs: inputs.map(exactLabel),
          rationale: "First synthetic candidate for human review.",
        },
      ],
    );
    await x.artifacts.create(first);
    await runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks,
      taskId: "target",
      at,
      executor: async ({ invocation }) => ({
        result: {
          runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [exact(first)],
          proposal: {
            packetId: `packet_${name.slice(0, 3)}`,
            items: [
              {
                id: `proposal_${name.slice(0, 3)}`,
                ref: exact(first),
                alternatives: ["approve", "reject"],
                rationale: "Human review of synthetic candidate",
                evidenceLimits: ["No empirical evidence"],
                dependents: [],
              },
            ],
            reason: "Request human review",
          },
        },
      }),
    });
    const rejectedBare: ArtifactSnapshot = {
      ...first,
      meta: {
        ...first.meta,
        revision: scenario.rejectedRevision as number,
        supersedesRevision: 1,
      },
      lifecycle: { status: "rejected", freshness: "valid" },
      approval: {
        status: "rejected",
        decisionId: `decision_${name.slice(0, 3)}`,
        actorId: "human_1",
        at,
      },
    };
    const rejected: ArtifactSnapshot = {
      ...rejectedBare,
      meta: {
        ...rejectedBare.meta,
        contentDigest: artifactDigest(rejectedBare),
      },
    };
    await x.registry.decide({
      id: `decision_${name.slice(0, 3)}`,
      packetId: `packet_${name.slice(0, 3)}`,
      proposalId: `proposal_${name.slice(0, 3)}`,
      outcome: "rejected",
      actor: { kind: "human", id: "human_1" },
      at,
      rationale: "Reject this candidate's unresolved continuity risk",
      output: { ref: exact(rejected), artifact: rejected },
    });
    const rejectedDigest = (
      await x.artifacts.read(artifactId, scenario.rejectedRevision as number)
    ).digest;
    const renewed: ArtifactSnapshot = {
      ...first,
      meta: {
        ...first.meta,
        revision: scenario.newRevision as number,
        supersedesRevision: scenario.rejectedRevision as number,
      },
      content: {
        ...(first.content as Record<string, JsonValue>),
        summary: "Revised proposal addresses the rejected continuity risk",
      },
      provenance: [
        {
          path: "/content/summary",
          kind: "derived",
          inputRefs: inputs.map(exactLabel),
          rationale: `New proposal after human rejection decision_${name.slice(0, 3)} of ${artifactId}@${scenario.rejectedRevision}; retain rejected envelope.`,
        },
      ],
    };
    await x.artifacts.create(renewed);
    const retried = await runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks,
      taskId: "retry",
      at,
      executor: async ({ invocation }) => ({
        result: {
          runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [exact(renewed)],
        },
      }),
    });
    expect(scenario.expected).toBe("preserved");
    expect(retried.result.outputRefs).toEqual([exact(renewed)]);
    expect(
      (await x.artifacts.read(artifactId, scenario.rejectedRevision as number))
        .digest,
    ).toBe(rejectedDigest);
    expect(
      (await x.artifacts.read(artifactId, scenario.rejectedRevision as number))
        .artifact.approval.status,
    ).toBe("rejected");
    expect(
      (await x.artifacts.read(artifactId, scenario.newRevision as number))
        .artifact.approval.status,
    ).toBe("pending");
    expect(
      (await x.artifacts.read(artifactId, scenario.newRevision as number))
        .artifact.meta.supersedesRevision,
    ).toBe(scenario.rejectedRevision);
    expect(renewed.provenance[0]?.rationale).toContain(
      `@${scenario.rejectedRevision}`,
    );
  });

test("invalid authority variants cannot become selected directions or committed decisions", async () => {
  const x = await setup(packageNames[0]);
  const direction = (
    JSON.parse(
      x.skill.examples["examples/directions.json"]!,
    ) as DirectionExample
  ).candidate;
  const decision = JSON.parse(
    x.skill.examples["examples/selection-proposal.json"]!,
  ) as ArtifactSnapshot;
  expect(x.schemas.validate(direction).valid).toBe(true);
  expect(x.schemas.validate(decision).valid).toBe(true);
  const selected = {
    ...direction,
    content: {
      ...(direction.content as Record<string, JsonValue>),
      selectionStatus: "selected",
    },
  };
  const committed = {
    ...decision,
    content: {
      ...(decision.content as Record<string, JsonValue>),
      outcome: "committed",
      chosenAlternative: "Timeline",
    },
  };
  expect(x.schemas.validate(selected).valid).toBe(false);
  expect(x.schemas.validate(committed).valid).toBe(false);
  const designExample = JSON.parse(
    x.skill.examples["examples/directions.json"]!,
  ) as DirectionExample;
  const visualOnly = designExample.portfolio;
  expect(
    structuralDifferences(
      visualOnly[0]!.axes,
      designExample.visualOnlyVariant.axes,
    ),
  ).toEqual([]);
  expect(
    structuralDifferences(visualOnly[0]!.axes, visualOnly[1]!.axes).length,
  ).toBeGreaterThanOrEqual(2);

  for (const name of packageNames) {
    const y = await setup(name, true);
    const scenario = y.scenarios.find((item) => item.id === "self-approval")!;
    const runId = `run_authority_${name.slice(0, 3)}`;
    const types =
      name === packageNames[0]
        ? ["problem-profile", "product-ui-contract", "reference-selection"]
        : ["design-direction", "problem-profile", "product-ui-contract"];
    const { inputs, tasks } = await startWithInputs(y, types, runId);
    const template =
      name === packageNames[0]
        ? (
            JSON.parse(
              y.skill.examples["examples/directions.json"]!,
            ) as DirectionExample
          ).candidate
        : (JSON.parse(
            y.skill.examples["examples/decision.json"]!,
          ) as ArtifactSnapshot);
    const content =
      name === packageNames[0]
        ? {
            ...(template.content as Record<string, JsonValue>),
            selectionStatus: scenario.forbiddenStatus as string,
          }
        : {
            ...(template.content as Record<string, JsonValue>),
            outcome: scenario.forbiddenOutcome as string,
            chosenAlternative: "Recommend timeline",
          };
    const pending = proposal(
      template,
      `art_durable_${name.slice(0, 3)}`,
      y.skill.manifest.skillId,
      runId,
      inputs,
      content,
      [
        {
          path: "/content",
          kind: "derived",
          inputRefs: inputs.map(exactLabel),
          rationale:
            "Synthetic approved fixture outside this Run's canonical selection.",
        },
      ],
    );
    const signedBare: ArtifactSnapshot = {
      ...pending,
      lifecycle: { status: "approved", freshness: "valid" },
      approval: {
        status: "approved",
        decisionId: "seed_human",
        actorId: "human_1",
        at,
      },
    };
    const approved: ArtifactSnapshot = {
      ...signedBare,
      meta: { ...signedBare.meta, contentDigest: artifactDigest(signedBare) },
    };
    expect(y.schemas.validate(approved).valid).toBe(true);
    const selfSignedBare: ArtifactSnapshot = {
      ...signedBare,
      meta: { ...signedBare.meta, id: `art_self_${name.slice(0, 3)}` },
      approval: { ...signedBare.approval, actorId: y.skill.manifest.skillId },
    };
    const selfSigned: ArtifactSnapshot = {
      ...selfSignedBare,
      meta: {
        ...selfSignedBare.meta,
        contentDigest: artifactDigest(selfSignedBare),
      },
    };
    await expect(y.artifacts.create(selfSigned)).rejects.toThrow(
      /Human approval is not verified/,
    );
    await y.artifacts.create(approved);
    const before = await y.registry.snapshot();
    await expect(
      runSkillPackage({
        orchestrator: y.orchestrator,
        package: y.skill,
        runId,
        tasks,
        taskId: "target",
        at,
        executor: async ({ invocation }) => ({
          result: {
            runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [exact(approved)],
          },
        }),
      }),
    ).rejects.toThrow(/Unchanged output is not verified approved Run context/);
    expect(scenario.expected).toBe("rejected");
    expect(await y.registry.snapshot()).toEqual(before);
    expect((await y.registry.run(runId)).run.artifacts).toEqual(
      inputs.map(exact),
    );
  }
});
