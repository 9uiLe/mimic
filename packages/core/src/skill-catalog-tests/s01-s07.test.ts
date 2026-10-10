import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
  type SkillInvocation,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { assessProvenance } from "../runtime-engines/provenance.js";
import {
  loadSkillPackage,
  runSkillPackage,
  type SkillManifest,
  type SkillPackage,
  type SkillContext,
} from "../skill-runtime/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemasRoot = path.join(repository, "schemas");
const now = "2026-10-06T12:00:00Z";
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
const packages = [
  "s01-product-definition",
  "s02-user-task-modeling",
  "s03-brand-builder",
  "s04-system-capability-extractor",
  "s05-ui-contract-manager",
  "s06-product-design-principles",
  "s07-experience-architecture",
];
const commonScenarios = [
  "missing-input",
  "valid-candidate",
  "optional-gap",
  "exact-lock",
  "mismatched-input-lock",
];
const semanticScenarios: Record<string, readonly string[]> = {
  "s01-product-definition": [],
  "s02-user-task-modeling": ["behavior-centered-user"],
  "s03-brand-builder": ["inherited-brand"],
  "s04-system-capability-extractor": [
    "unverified-current",
    "semantic-unknown",
    "invented-semantic-meaning",
  ],
  "s05-ui-contract-manager": [
    "current-required-proposed-unresolved",
    "gui-feedback",
    "mode-convergence",
    "proposed-as-current",
  ],
  "s06-product-design-principles": [],
  "s07-experience-architecture": [
    "same-interaction-different-url",
    "cross-domain-context",
    "lost-cross-domain-state",
  ],
};
const requiredNegativeEffects = [
  "approved-output",
  "canonical-write",
  "direct-skill-call",
];
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("S07 duplicate provenance from a generated candidate is rejected", async () => {
  const skill = await loadSkillPackage(
    path.join(repository, "skills/s07-experience-architecture"),
    schemasRoot,
  );
  expect(skill.instructions).toContain(
    "each exact `/content` provenance pointer at most once",
  );
  const candidate = JSON.parse(
    skill.examples["examples/candidate.json"]!,
  ) as ArtifactSnapshot;
  const reproduction = JSON.parse(
    skill.tests["tests/provenance-duplicate.json"]!,
  ) as { provenance: ArtifactSnapshot["provenance"] };
  const rejectedCandidate = {
    ...candidate,
    provenance: reproduction.provenance,
  };
  expect(
    (await loadSchemaDirectory(path.join(schemasRoot, "artifacts"))).validate(
      rejectedCandidate,
    ).valid,
  ).toBe(true);
  await expect(assessProvenance(rejectedCandidate)).rejects.toThrow(
    "Duplicate provenance pointer: /content/summary",
  );
  expect(
    (await assessProvenance(candidate)).map((item) => item.status),
  ).toEqual(["DECLARED"]);
});
const ref = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
const need = (item: SkillManifest["inputs"]["required"][number]) => ({
  ...item,
});
const taskInputs = (manifest: SkillManifest): RoutedTask["inputs"] => ({
  required: manifest.inputs.required.map(need),
  optional: manifest.inputs.optional.map(need),
  alternatives: manifest.inputs.alternatives.map((group) => ({
    oneOf: group.oneOf.map(need),
  })),
});
const fixtureName = (type: string) =>
  type === "product-ui-contract" ? "proposed-product-ui-contract" : type;

type ScenarioCase = {
  name: string;
  expected: string;
  reason?: string;
  example?: string;
  errorContains?: string;
  source?: string;
  factKey?: string;
  factText?: string;
  unknownText?: string;
  forbiddenClaim?: string;
  claims?: readonly {
    state: string;
    path: string;
    kind: string;
    text: string;
    source?: string;
    request?: string;
  }[];
  contract?: string;
  missingBehavior?: string;
  expectedChangeType?: string;
  modes?: readonly string[];
  fixture?: string;
  exploration?: string;
  review?: string;
  userIncludes?: readonly string[];
  taskIncludes?: readonly string[];
  provenanceKind?: string;
  forbidden?: readonly string[];
  claimPath?: string;
  claimState?: string;
  claimKind?: string;
  field?: string;
};
type NegativeCase = { effect: string; expected: string; errorContains: string };
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing scenario field: ${label}`);
  return value;
}
function atPointer(value: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((node, key) => {
      if (!node || typeof node !== "object")
        throw new Error(`Unresolved pointer: ${pointer}`);
      return (node as Record<string, unknown>)[key];
    }, value);
}
async function rejected(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected rejection, but action succeeded");
}
function assertNoInventedMeaning(
  artifact: ArtifactSnapshot,
  forbiddenClaim: string,
): void {
  const description = String(
    (artifact.content as { description: string }).description,
  );
  const semanticUnknown = artifact.provenance.some(
    (item) =>
      item.kind === "unknown" && item.rationale?.includes("approval semantics"),
  );
  if (semanticUnknown && description.includes(forbiddenClaim))
    throw new Error("Semantic meaning lacks evidence");
}
function assertClaimStatus(
  artifact: ArtifactSnapshot,
  pointer: string,
  state: string,
  kind: string,
): void {
  const text = atPointer(artifact, pointer);
  const provenance = artifact.provenance.find((item) => item.path === pointer);
  if (
    typeof text !== "string" ||
    !text.toLowerCase().startsWith(`${state}:`) ||
    provenance?.kind !== kind
  )
    throw new Error("Claim status/provenance mismatch");
}
function assertPreservedContext(fixture: {
  from: Record<string, string>;
  to: Record<string, string>;
  keys: Record<string, string>;
}): void {
  for (const [context, key] of Object.entries(fixture.keys)) {
    if (!fixture.from[key] || fixture.to[key] !== fixture.from[key])
      throw new Error(`Cross-domain context lost: ${context}`);
  }
}
async function modeContract(
  mode: "system-first" | "experience-first",
  skill: SkillPackage,
  example: ArtifactSnapshot,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), `mimic-contract-${mode}-`));
  temporary.push(root);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    await loadSchemaDirectory(path.join(schemasRoot, "artifacts")),
    scopes,
    {
      async verify() {
        return false;
      },
      async allowCommit() {
        return false;
      },
    },
  );
  const types = skill.manifest.inputs.required
    .filter((item) => item.kind === "artifact")
    .map((item) => item.artifactType);
  const target: RoutedTask = {
    id: "contract",
    skillId: skill.manifest.skillId,
    outputType: "product-ui-contract",
    additionalOutputTypes: ["system-request"],
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: taskInputs(skill.manifest),
  };
  const tasks: RoutedTask[] = [
    ...types.map((type) => ({
      id: `seed-${type}`,
      skillId: "mimic.fixture.producer",
      outputType: type,
      scopeOwnerId: "product_mimic",
      intent: "create" as const,
      authority: "AUTONOMOUS" as const,
      inputs: { required: [], optional: [], alternatives: [] },
    })),
    target,
  ];
  const runId = "run_contract_mode";
  await runtime.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: mode,
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks,
  });
  const seeded: ArtifactSnapshot[] = [];
  for (const type of types) {
    const source = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid",
          `${fixtureName(type)}.json`,
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const artifact: ArtifactSnapshot = {
      ...source,
      meta: {
        ...source.meta,
        id: `art_mode_input_${type.replaceAll("-", "_")}`,
      },
      lifecycle: { status: "provisional", freshness: "valid" },
      approval: { status: "pending" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.fixture.producer",
        runId,
        createdAt: now,
      },
    };
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId,
      ref: ref(artifact),
      inputs: [],
      actor: { kind: "skill", id: "mimic.fixture.producer" },
      at: now,
      reason: "Mode input",
    });
    seeded.push(artifact);
  }
  await runtime.registry.setWork({
    runId,
    safeActions: ["contract"],
    blockers: {},
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    reason: "Inputs available",
  });
  const candidate: ArtifactSnapshot = {
    ...example,
    meta: { ...example.meta, id: "art_mode_contract" },
    origin: {
      actorKind: "skill",
      actorId: skill.manifest.skillId,
      runId,
      createdAt: now,
    },
    dependencies: seeded.map((item) => ({
      ...ref(item),
      onChange: "validate",
    })),
  };
  await runtime.artifacts.create(candidate);
  const routed = (await runtime.orchestrator.next(runId, tasks)).actions.find(
    (item) => item.taskId === "contract",
  )?.invocation;
  expect(routed).toBeDefined();
  let observedInvocation: SkillInvocation | undefined;
  let observedInputs: SkillContext["inputs"] | undefined;
  const work = await runSkillPackage({
    orchestrator: runtime.orchestrator,
    package: skill,
    runId,
    tasks,
    taskId: "contract",
    at: now,
    executor: async ({ invocation, inputs }) => {
      observedInvocation = invocation;
      observedInputs = inputs;
      return {
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [ref(candidate)],
        },
      };
    },
  });
  const invocation = required(observedInvocation, "observed invocation");
  const inputs = required(observedInputs, "observed context inputs");
  expect(invocation).toEqual(routed);
  const acceptedRef = required(work.result.outputRefs[0], "accepted output");
  const stored = await runtime.artifacts.read(
    acceptedRef.artifactId,
    acceptedRef.revision,
  );
  const accepted = (await runtime.registry.run(runId)).run.artifacts;
  expect(accepted).toContainEqual(acceptedRef);
  expect(stored.digest).toBe(acceptedRef.lockDigest);
  return {
    routedInputs: required(routed, "routed invocation").inputRefs,
    invocationInputs: invocation.inputRefs,
    bindings: invocation.inputBindings,
    contextInputs: inputs.map((item) => ({
      name: item.name,
      ref: item.ref,
      type: item.artifact.meta.type,
      content: item.artifact.content,
    })),
    outputRef: acceptedRef,
    outputContent: stored.artifact.content,
    outputDependencies: stored.artifact.dependencies,
    accepted,
  };
}

for (const slug of packages)
  test(`${slug}: package, scenarios, runtime routing and boundary`, async () => {
    const directory = path.join(repository, "skills", slug);
    const skill = await loadSkillPackage(directory, schemasRoot);
    const scenarios = JSON.parse(skill.tests["tests/scenarios.json"]!) as {
      cases: ScenarioCase[];
    };
    const negative = JSON.parse(skill.tests["tests/negative.json"]!) as {
      cases: NegativeCase[];
    };
    const scenarioNames = scenarios.cases.map((item) => item.name);
    const negativeEffects = negative.cases.map((item) => item.effect);
    expect(scenarioNames.sort()).toEqual(
      [
        ...commonScenarios,
        ...required(semanticScenarios[slug], "semantic inventory"),
      ].sort(),
    );
    expect(negativeEffects.sort()).toEqual([...requiredNegativeEffects].sort());
    expect(new Set(scenarioNames).size).toBe(scenarios.cases.length);
    expect(new Set(negativeEffects).size).toBe(negative.cases.length);
    expect(skill.instructions).toContain("Orchestrator");
    expect(skill.instructions).toContain("approved");
    const example = JSON.parse(
      skill.examples["examples/candidate.json"]!,
    ) as ArtifactSnapshot;
    expect(example.meta.type).toBe(skill.manifest.outputs[0]);
    expect((example.origin as { actorKind: string }).actorKind).toBe("skill");
    expect((example.origin as { actorId: string }).actorId).toBe(
      skill.manifest.skillId,
    );
    expect(example.lifecycle.status).toBe("provisional");
    expect(example.approval.status).toBe("pending");
    const root = await mkdtemp(path.join(os.tmpdir(), "mimic-s01-s07-"));
    temporary.push(root);
    const runtime = createOrchestratorRuntime(
      new FileWorkspaceStorage(path.join(root, "workspace.json")),
      await loadSchemaDirectory(path.join(schemasRoot, "artifacts")),
      scopes,
      {
        async verify() {
          return false;
        },
        async allowCommit() {
          return false;
        },
      },
    );
    for (const source of Object.values(skill.examples)) {
      const sample = JSON.parse(source) as ArtifactSnapshot;
      expect(skill.manifest.outputs).toContain(sample.meta.type);
      await runtime.artifacts.create(sample);
      expect(
        (await runtime.artifacts.read(sample.meta.id, sample.meta.revision))
          .artifact,
      ).toEqual(sample);
    }
    const requiredTypes = skill.manifest.inputs.required
      .filter((item) => item.kind === "artifact")
      .map((item) => item.artifactType);
    const producerTasks: RoutedTask[] = requiredTypes.map((type) => ({
      id: `seed-${type}`,
      skillId: "mimic.fixture.producer",
      outputType: type,
      scopeOwnerId: "product_mimic",
      intent: "create",
      authority: "AUTONOMOUS",
      inputs: { required: [], optional: [], alternatives: [] },
    }));
    const target: RoutedTask = {
      id: "target",
      skillId: skill.manifest.skillId,
      outputType: skill.manifest.outputs[0]!,
      additionalOutputTypes: skill.manifest.outputs.slice(1),
      scopeOwnerId: "product_mimic",
      intent: "create",
      authority: "PROPOSE_ONLY",
      inputs: taskInputs(skill.manifest),
      humanBrief:
        "Human supplied product, user and brand intent with explicit task assumptions.",
      evidenceFiles: ["system-source.txt"],
    };
    const tasks = [...producerTasks, target];
    const missing = structuredClone(target) as RoutedTask & {
      humanBrief?: string;
      evidenceFiles: string[];
    };
    delete missing.humanBrief;
    missing.evidenceFiles = [];
    await runtime.orchestrator.start({
      id: "run_missing",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: { kind: "agent", id: "agent_1" },
      at: now,
      tasks: [missing],
    });
    const missingAction = (
      await runtime.orchestrator.next("run_missing", [missing])
    ).actions[0];
    await runtime.orchestrator.start({
      id: "run_catalog",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: { kind: "agent", id: "agent_1" },
      at: now,
      tasks,
    });
    const seeded: ArtifactSnapshot[] = [];
    for (const type of requiredTypes) {
      const source = JSON.parse(
        await readFile(
          path.join(
            repository,
            "fixtures/artifacts/valid",
            `${fixtureName(type)}.json`,
          ),
          "utf8",
        ),
      ) as ArtifactSnapshot;
      const artifact: ArtifactSnapshot = {
        ...source,
        meta: { ...source.meta, id: `art_seed_${type.replaceAll("-", "_")}` },
        lifecycle: { status: "provisional", freshness: "valid" },
        approval: { status: "pending" },
        origin: {
          actorKind: "skill",
          actorId: "mimic.fixture.producer",
          runId: "run_catalog",
          createdAt: now,
        },
      };
      await runtime.artifacts.create(artifact);
      await runtime.registry.produce({
        runId: "run_catalog",
        ref: ref(artifact),
        inputs: [],
        actor: { kind: "skill", id: "mimic.fixture.producer" },
        at: now,
        reason: "Seed exact shared-workspace input",
      });
      seeded.push(artifact);
    }
    // The required-input blocker is resolved after the producer has supplied exact snapshots.
    await runtime.registry.setWork({
      runId: "run_catalog",
      safeActions: ["target"],
      blockers: {},
      actor: { kind: "agent", id: "agent_1" },
      at: now,
      reason: "Required input snapshots are now available",
    });
    const plan = await runtime.orchestrator.next("run_catalog", tasks);
    expect(
      plan.actions.find((action) => action.taskId === "target")?.invocation,
    ).toBeDefined();
    const candidate: ArtifactSnapshot = {
      ...example,
      meta: { ...example.meta, id: `art_catalog_${slug.replaceAll("-", "_")}` },
      origin: {
        actorKind: "skill",
        actorId: skill.manifest.skillId,
        runId: "run_catalog",
        createdAt: now,
      },
      dependencies: seeded.map((artifact) => ({
        ...ref(artifact),
        onChange: "validate",
      })),
    };
    await runtime.artifacts.create(candidate); // canonical schema validation of every package example
    const fakeBare: ArtifactSnapshot = {
      ...candidate,
      meta: {
        ...candidate.meta,
        id: `art_fake_approval_${slug.replaceAll("-", "_")}`,
      },
      lifecycle: { status: "approved", freshness: "valid" },
      approval: {
        status: "approved",
        decisionId: "decision_fake",
        actorId: "human_fake",
        at: now,
      },
    };
    const fakeApproval: ArtifactSnapshot = {
      ...fakeBare,
      meta: { ...fakeBare.meta, contentDigest: artifactDigest(fakeBare) },
    };
    const failures: Record<string, string> = {};
    failures["approved-output"] = await rejected(() =>
      runtime.artifacts.create(fakeApproval),
    );
    failures["mismatched-input-lock"] = await rejected(() =>
      runSkillPackage({
        orchestrator: runtime.orchestrator,
        package: skill,
        runId: "run_catalog",
        tasks,
        taskId: "target",
        at: now,
        executor: async ({ invocation }) => ({
          result: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: [
              {
                artifactId: "art_wrong",
                revision: 1,
                lockDigest: `sha256:${"0".repeat(64)}`,
              },
            ],
            outputRefs: [ref(candidate)],
          },
        }),
      }),
    );
    failures["canonical-write"] = await rejected(() =>
      runSkillPackage({
        orchestrator: runtime.orchestrator,
        package: skill,
        runId: "run_catalog",
        tasks,
        taskId: "target",
        at: now,
        executor: async ({ invocation }) => ({
          result: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [],
            canonicalWrite: true,
          } as never,
        }),
      }),
    );
    failures["direct-skill-call"] = await rejected(() =>
      runSkillPackage({
        orchestrator: runtime.orchestrator,
        package: skill,
        runId: "run_catalog",
        tasks,
        taskId: "target",
        at: now,
        executor: async ({ invocation }) => ({
          result: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [],
            directSkillCalls: ["mimic.other"],
          } as never,
        }),
      }),
    );
    let observedGaps: readonly string[] = [];
    const valid = await runSkillPackage({
      orchestrator: runtime.orchestrator,
      package: skill,
      runId: "run_catalog",
      tasks,
      taskId: "target",
      at: now,
      executor: async ({ invocation, inputs, gaps }) => {
        expect(inputs.map((item) => item.ref)).toEqual(invocation.inputRefs);
        observedGaps = gaps;
        return {
          result: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [ref(candidate)],
          },
        };
      },
    });
    expect(valid.result.outputRefs).toEqual([ref(candidate)]);
    expect(
      (await runtime.registry.run("run_catalog")).run.artifacts,
    ).toContainEqual(ref(candidate));
    const expectedGaps = skill.manifest.inputs.optional
      .filter(
        (item) =>
          item.kind === "artifact" &&
          !requiredTypes.includes(item.artifactType),
      )
      .map((item) => item.name);
    for (const caseData of scenarios.cases) {
      switch (caseData.name) {
        case "missing-input":
          expect(caseData.expected).toBe("blocked");
          expect(missingAction?.action).toBe("BLOCK");
          expect(skill.instructions).toContain(
            required(caseData.reason, "reason"),
          );
          break;
        case "valid-candidate": {
          const sample = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          expect(candidate.content).toEqual(sample.content);
          expect(candidate.lifecycle.status).toBe(caseData.expected);
          expect(valid.result.outputRefs).toEqual([ref(candidate)]);
          break;
        }
        case "optional-gap":
          expect(caseData.expected).toBe("reported");
          expect(observedGaps).toEqual(expectedGaps);
          expect(skill.instructions).toContain(
            required(caseData.reason, "reason"),
          );
          break;
        case "exact-lock":
          expect(caseData.expected).toBe("preserved");
          expect(skill.instructions).toContain(
            required(caseData.reason, "reason"),
          );
          expect(
            candidate.dependencies.map(
              ({ artifactId, revision, lockDigest }) => ({
                artifactId,
                revision,
                lockDigest,
              }),
            ),
          ).toEqual(seeded.map(ref));
          break;
        case "mismatched-input-lock":
          expect(caseData.expected).toBe("rejected");
          expect(failures[caseData.name]).toContain(
            required(caseData.errorContains, "errorContains"),
          );
          break;
        case "behavior-centered-user": {
          expect(caseData.expected).toBe("assumption-backed-behavior");
          const model = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const content = model.content as { users: string[]; tasks: string[] };
          const user = content.users.join(" ").toLowerCase();
          const task = content.tasks.join(" ").toLowerCase();
          for (const phrase of required(caseData.userIncludes, "userIncludes"))
            expect(user).toContain(phrase.toLowerCase());
          for (const phrase of required(caseData.taskIncludes, "taskIncludes"))
            expect(task).toContain(phrase.toLowerCase());
          for (const phrase of required(caseData.forbidden, "forbidden"))
            expect(user).not.toContain(phrase.toLowerCase());
          expect(
            model.provenance.some(
              (item) =>
                item.kind ===
                required(caseData.provenanceKind, "provenanceKind"),
            ),
          ).toBe(true);
          expect(skill.instructions).toContain("not demographic personas");
          break;
        }
        case "inherited-brand": {
          expect(caseData.expected).toBe("reuse-exact-approved-ref");
          const inherited = await exerciseInheritedBrand();
          expect(inherited.outputRefs).toEqual([inherited.approvedRef]);
          expect(inherited.newArtifacts).not.toContainEqual(
            inherited.approvedRef,
          );
          break;
        }
        case "unverified-current": {
          expect(caseData.expected).toBe("rejected");
          const source = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const unevidenced: ArtifactSnapshot = {
            ...source,
            meta: { ...source.meta, id: "art_unevidenced_current" },
            content: { ...(source.content as object), availability: "current" },
          };
          const failure = await rejected(() =>
            runtime.artifacts.create(unevidenced),
          );
          expect(failure).toContain(
            required(caseData.errorContains, "errorContains"),
          );
          break;
        }
        case "semantic-unknown": {
          expect(caseData.expected).toBe("unresolved");
          const known = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const source = JSON.parse(
            required(
              skill.tests[required(caseData.source, "source")],
              "source fixture",
            ),
          ) as { response: Record<string, unknown> };
          const factKey = required(caseData.factKey, "factKey");
          expect(source.response).toHaveProperty(factKey);
          const content = known.content as {
            availability: string;
            description: string;
            supportingEvidence: string[];
          };
          expect(content.availability).toBe("current");
          expect(content.supportingEvidence).toContain(caseData.source);
          expect(content.description).toContain(
            required(caseData.factText, "factText"),
          );
          const fact = known.provenance.find((item) => item.kind === "fact");
          expect(fact?.evidenceRefs).toContain(caseData.source);
          const unknown = known.provenance.find(
            (item) => item.kind === "unknown",
          );
          expect(unknown?.rationale).toContain(
            required(caseData.unknownText, "unknownText"),
          );
          expect(content.description).not.toContain(
            required(caseData.forbiddenClaim, "forbiddenClaim"),
          );
          assertNoInventedMeaning(
            known,
            required(caseData.forbiddenClaim, "forbiddenClaim"),
          );
          break;
        }
        case "current-required-proposed-unresolved": {
          expect(caseData.expected).toBe("separated");
          const contract = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const claims = required(caseData.claims, "claims");
          expect(claims.map((item) => item.state)).toEqual([
            "current",
            "required",
            "proposed",
            "unresolved",
          ]);
          for (const claim of claims) {
            const value = atPointer(contract, claim.path);
            expect(value).toEqual(expect.any(String));
            expect(String(value).toLowerCase()).toContain(`${claim.state}:`);
            expect(String(value).toLowerCase()).toContain(
              claim.text.toLowerCase(),
            );
            assertClaimStatus(contract, claim.path, claim.state, claim.kind);
            const provenance = contract.provenance.find(
              (item) => item.path === claim.path,
            );
            expect(provenance?.kind).toBe(claim.kind);
            if (claim.state === "current") {
              const system = JSON.parse(
                await readFile(
                  path.join(repository, required(claim.source, "source")),
                  "utf8",
                ),
              ) as ArtifactSnapshot;
              expect(
                (system.content as { availability: string }).availability,
              ).toBe("current");
              const support = (
                system.content as { supportingEvidence: string[] }
              ).supportingEvidence;
              const packageRoot = required(claim.source, "source")
                .split("/")
                .slice(0, -2)
                .join("/");
              expect(provenance?.evidenceRefs).toContain(
                `${packageRoot}/${support[0]}`,
              );
            } else if (claim.state === "required") {
              const users = JSON.parse(
                await readFile(
                  path.join(repository, required(claim.source, "source")),
                  "utf8",
                ),
              ) as ArtifactSnapshot;
              expect(
                (users.content as { tasks: string[] }).tasks.join(" "),
              ).toContain("resume review");
            } else if (claim.state === "proposed") {
              const request = JSON.parse(
                required(
                  skill.examples[required(claim.request, "request")],
                  "request source",
                ),
              ) as ArtifactSnapshot;
              expect(
                (request.content as { request: string }).request.toLowerCase(),
              ).toContain(claim.text.toLowerCase());
            } else if (claim.state === "unresolved") {
              const system = JSON.parse(
                await readFile(
                  path.join(repository, required(claim.source, "source")),
                  "utf8",
                ),
              ) as ArtifactSnapshot;
              expect(
                system.provenance.some(
                  (item) =>
                    item.kind === "unknown" &&
                    item.rationale?.includes(claim.text),
                ),
              ).toBe(true);
            } else throw new Error(`Unhandled claim state: ${claim.state}`);
          }
          break;
        }
        case "gui-feedback": {
          expect(caseData.expected).toBe("system-request");
          const request = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const contract = JSON.parse(
            required(
              skill.examples[required(caseData.contract, "contract")],
              "contract source",
            ),
          ) as ArtifactSnapshot;
          const need = required(caseData.missingBehavior, "missingBehavior");
          expect(JSON.stringify(contract.content).toLowerCase()).toContain(
            need.toLowerCase(),
          );
          expect((request.content as { changeType: string }).changeType).toBe(
            required(caseData.expectedChangeType, "expectedChangeType"),
          );
          expect(
            (request.content as { request: string }).request.toLowerCase(),
          ).toContain(need.toLowerCase());
          expect(request.lifecycle.status).toBe("provisional");
          break;
        }
        case "mode-convergence": {
          expect(caseData.expected).toBe("equivalent-contract");
          const modes = required(caseData.modes, "modes");
          expect(modes).toEqual(["system-first", "experience-first"]);
          const source = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const results = await Promise.all(
            modes.map((mode) =>
              modeContract(
                mode as "system-first" | "experience-first",
                skill,
                source,
              ),
            ),
          );
          const [system, experience] = results;
          expect(system?.routedInputs).toEqual(experience?.routedInputs);
          expect(system?.invocationInputs).toEqual(
            experience?.invocationInputs,
          );
          expect(system?.bindings).toEqual(experience?.bindings);
          expect(system?.contextInputs).toEqual(experience?.contextInputs);
          expect(system?.outputContent).toEqual(experience?.outputContent);
          expect(system?.outputDependencies).toEqual(
            experience?.outputDependencies,
          );
          expect(system?.outputRef).toEqual(experience?.outputRef);
          expect(system?.accepted).toEqual(experience?.accepted);
          for (const observed of results) {
            expect(observed.routedInputs).toEqual(observed.invocationInputs);
            expect(observed.contextInputs.map((item) => item.ref)).toEqual(
              observed.invocationInputs,
            );
            expect(
              observed.outputDependencies.map(
                ({ artifactId, revision, lockDigest }) => ({
                  artifactId,
                  revision,
                  lockDigest,
                }),
              ),
            ).toEqual(observed.invocationInputs);
            expect(observed.accepted).toContainEqual(observed.outputRef);
          }
          break;
        }
        case "same-interaction-different-url": {
          expect(caseData.expected).toBe("same-domain");
          const fixture = JSON.parse(
            required(
              skill.tests[required(caseData.fixture, "fixture")],
              "fixture source",
            ),
          ) as {
            surfaces: {
              url: string;
              domain: string;
              primaryGoal: string;
              interactionModel: string;
              riskModel: string;
            }[];
            sameDomain: string[];
            differentDomain: string[];
          };
          const exploration = JSON.parse(
            required(
              skill.examples[required(caseData.exploration, "exploration")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const review = JSON.parse(
            required(
              skill.examples[required(caseData.review, "review")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const signature = (item: {
            primaryGoal: string;
            interactionModel: string;
            riskModel: string;
          }) => [item.primaryGoal, item.interactionModel, item.riskModel];
          for (const surface of fixture.surfaces) {
            const domain =
              surface.domain === "exploration"
                ? exploration
                : surface.domain === "review"
                  ? review
                  : undefined;
            if (!domain) throw new Error(`Unknown domain: ${surface.domain}`);
            expect(signature(surface)).toEqual(
              signature(domain.content as typeof surface),
            );
          }
          const byUrl = (url: string) =>
            required(
              fixture.surfaces.find((item) => item.url === url),
              `surface ${url}`,
            );
          const [left, right] = fixture.sameDomain.map(byUrl);
          expect(left?.url).not.toBe(right?.url);
          expect(left?.domain).toBe(right?.domain);
          expect(signature(left!)).toEqual(signature(right!));
          const [otherLeft, otherRight] = fixture.differentDomain.map(byUrl);
          expect(otherLeft?.domain).not.toBe(otherRight?.domain);
          expect(signature(otherLeft!)).not.toEqual(signature(otherRight!));
          break;
        }
        case "cross-domain-context": {
          expect(caseData.expected).toBe("preserved");
          const fixture = JSON.parse(
            required(
              skill.tests[required(caseData.fixture, "fixture")],
              "fixture source",
            ),
          ) as {
            from: Record<string, string>;
            to: Record<string, string>;
            expectedDomains: string[];
            expectedSteps: string[];
            keys: Record<string, string>;
          };
          const journey = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const content = journey.content as {
            domains: string[];
            steps: string[];
            preservedContext: string[];
          };
          expect(content.domains).toEqual(fixture.expectedDomains);
          expect(content.steps).toEqual(fixture.expectedSteps);
          expect(content.preservedContext).toEqual(Object.keys(fixture.keys));
          expect(fixture.from.domain).toBe(content.domains[0]);
          expect(fixture.to.domain).toBe(content.domains[1]);
          assertPreservedContext(fixture);
          for (const [context, key] of Object.entries(fixture.keys)) {
            expect(content.preservedContext).toContain(context);
            expect(fixture.from[key]).toBeTruthy();
            expect(fixture.to[key]).toBe(fixture.from[key]);
          }
          break;
        }
        case "invented-semantic-meaning": {
          expect(caseData.expected).toBe("rejected");
          const known = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const forbidden = required(caseData.forbiddenClaim, "forbiddenClaim");
          const altered: ArtifactSnapshot = {
            ...known,
            content: { ...(known.content as object), description: forbidden },
          };
          expect(() => assertNoInventedMeaning(altered, forbidden)).toThrow(
            required(caseData.errorContains, "errorContains"),
          );
          break;
        }
        case "proposed-as-current": {
          expect(caseData.expected).toBe("rejected");
          const contract = JSON.parse(
            required(
              skill.examples[required(caseData.example, "example")],
              "example source",
            ),
          ) as ArtifactSnapshot;
          const pointer = required(caseData.claimPath, "claimPath");
          const original = String(atPointer(contract, pointer));
          const content = structuredClone(contract.content) as {
            entityContext: string[];
          };
          content.entityContext[1] = original.replace(/^Proposed:/, "Current:");
          const altered: ArtifactSnapshot = { ...contract, content };
          expect(() =>
            assertClaimStatus(
              altered,
              pointer,
              required(caseData.claimState, "claimState"),
              required(caseData.claimKind, "claimKind"),
            ),
          ).toThrow(required(caseData.errorContains, "errorContains"));
          break;
        }
        case "lost-cross-domain-state": {
          expect(caseData.expected).toBe("rejected");
          const fixture = JSON.parse(
            required(
              skill.tests[required(caseData.fixture, "fixture")],
              "fixture source",
            ),
          ) as {
            from: Record<string, string>;
            to: Record<string, string>;
            keys: Record<string, string>;
          };
          const field = required(caseData.field, "field");
          expect(fixture.keys).toHaveProperty(field);
          const altered = structuredClone(fixture);
          altered.to[required(fixture.keys[field], "context key")] = "lost";
          expect(() => assertPreservedContext(altered)).toThrow(
            required(caseData.errorContains, "errorContains"),
          );
          break;
        }
        default:
          throw new Error(`Unhandled scenario: ${caseData.name}`);
      }
    }
    for (const caseData of negative.cases) {
      switch (caseData.effect) {
        case "approved-output":
        case "canonical-write":
        case "direct-skill-call":
          expect(caseData.expected).toBe("rejected");
          expect(failures[caseData.effect]).toContain(caseData.errorContains);
          break;
        default:
          throw new Error(`Unhandled negative effect: ${caseData.effect}`);
      }
    }
  });

async function exerciseInheritedBrand() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-brand-inherit-"));
  temporary.push(root);
  const authority = {
    async verify(record: { actor: { kind: string; id: string } }) {
      return record.actor.kind === "human" && record.actor.id === "human_1";
    },
    async allowCommit() {
      return true;
    },
  };
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    await loadSchemaDirectory(path.join(schemasRoot, "artifacts")),
    scopes,
    authority,
  );
  const skill = await loadSkillPackage(
    path.join(repository, "skills/s03-brand-builder"),
    schemasRoot,
  );
  const seed: RoutedTask = {
    id: "seed",
    skillId: "mimic.fixture.producer",
    outputType: "brand",
    scopeOwnerId: "org_9uile",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: { required: [], optional: [], alternatives: [] },
  };
  await runtime.orchestrator.start({
    id: "run_brand_seed",
    scopeOwnerId: "org_9uile",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks: [seed],
  });
  const example = JSON.parse(
    skill.examples["examples/candidate.json"]!,
  ) as ArtifactSnapshot;
  const proposed: ArtifactSnapshot = {
    ...example,
    meta: { ...example.meta, id: "art_organization_brand" },
    scope: { level: "organization", ownerId: "org_9uile" },
    lifecycle: { status: "proposed", freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: seed.skillId,
      runId: "run_brand_seed",
      createdAt: now,
    },
  };
  await runtime.artifacts.create(proposed);
  await runtime.registry.produce({
    runId: "run_brand_seed",
    ref: ref(proposed),
    inputs: [],
    actor: { kind: "skill", id: seed.skillId },
    at: now,
    reason: "Candidate organization brand",
  });
  await runtime.registry.submit({
    runId: "run_brand_seed",
    packetId: "packet_brand",
    proposals: [
      {
        id: "proposal_brand",
        ref: ref(proposed),
        alternatives: ["approve", "reject"],
        rationale: "Reuse an organization brand",
        evidenceLimits: [],
        dependents: [],
      },
    ],
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    reason: "Human brand review",
  });
  const approvedBare: ArtifactSnapshot = {
    ...proposed,
    meta: { ...proposed.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_brand",
      actorId: "human_1",
      at: now,
    },
  };
  const approved: ArtifactSnapshot = {
    ...approvedBare,
    meta: { ...approvedBare.meta, contentDigest: artifactDigest(approvedBare) },
  };
  await runtime.registry.decide({
    id: "decision_brand",
    packetId: "packet_brand",
    proposalId: "proposal_brand",
    outcome: "approved",
    actor: { kind: "human", id: "human_1" },
    at: now,
    rationale: "Approved reusable identity",
    output: { ref: ref(approved), artifact: approved },
  });
  await runtime.registry.commit({
    id: "commit_brand",
    packetId: "packet_brand",
    approvals: [{ proposalId: "proposal_brand", decisionId: "decision_brand" }],
    actor: { kind: "human", id: "human_1" },
    at: now,
    reason: "Human commit",
  });
  const task: RoutedTask = {
    id: "inherit",
    skillId: skill.manifest.skillId,
    outputType: "brand",
    additionalOutputTypes: ["decision"],
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: taskInputs(skill.manifest),
    evidenceFiles: [],
  };
  await runtime.orchestrator.start({
    id: "run_brand_inherit",
    scopeOwnerId: "product_mimic",
    entryMode: "experience-first",
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks: [task],
  });
  const result = await runSkillPackage({
    orchestrator: runtime.orchestrator,
    package: skill,
    runId: "run_brand_inherit",
    tasks: [task],
    taskId: "inherit",
    at: now,
    executor: async ({ invocation, inputs }) => {
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.name).toBe("existing-brand");
      expect(inputs[0]?.ref).toEqual(ref(approved));
      return {
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [ref(approved)],
        },
      };
    },
  });
  return {
    outputRefs: result.result.outputRefs,
    approvedRef: ref(approved),
    newArtifacts: (await runtime.registry.run("run_brand_inherit")).run
      .artifacts,
  };
}
