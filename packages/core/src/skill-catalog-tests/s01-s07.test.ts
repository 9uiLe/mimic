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
import {
  loadSkillPackage,
  runSkillPackage,
  type SkillManifest,
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
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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

for (const slug of packages)
  test(`${slug}: package, scenarios, runtime routing and boundary`, async () => {
    const directory = path.join(repository, "skills", slug);
    const skill = await loadSkillPackage(directory, schemasRoot);
    const scenarios = JSON.parse(skill.tests["tests/scenarios.json"]!) as {
      cases: { name: string; expected: string }[];
    };
    const negative = JSON.parse(skill.tests["tests/negative.json"]!) as {
      cases: { effect: string; expected: string }[];
    };
    expect(scenarios.cases.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "missing-input",
        "valid-candidate",
        "optional-gap",
        "exact-lock",
      ]),
    );
    expect(negative.cases.map((item) => item.effect)).toEqual(
      expect.arrayContaining([
        "approved-output",
        "canonical-write",
        "direct-skill-call",
      ]),
    );
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
    if (slug === "s02-user-task-modeling") {
      expect(
        example.provenance.some((item) => item.kind === "assumption"),
      ).toBe(true);
      expect(skill.instructions).toMatch(/behavior|Behavior/);
    }
    if (slug === "s03-brand-builder") {
      expect(
        skill.manifest.inputs.alternatives[0]?.oneOf.some(
          (item) => item.kind === "artifact" && item.artifactType === "brand",
        ),
      ).toBe(true);
      expect(skill.instructions).toContain(
        "Reuse an inherited brand unchanged",
      );
    }
    if (slug === "s05-ui-contract-manager") {
      for (const state of ["current", "required", "proposed", "unresolved"])
        expect(
          (example.content as { summary: string }).summary.toLowerCase(),
        ).toContain(state);
      expect(
        JSON.parse(skill.examples["examples/system-request.json"]!).content
          .changeType,
      ).toBe("capability");
    }
    if (slug === "s07-experience-architecture") {
      expect(
        JSON.parse(skill.examples["examples/journey.json"]!).content
          .preservedContext,
      ).toEqual([
        "entity",
        "terminology",
        "navigation",
        "return-path",
        "state",
      ]);
      expect(skill.instructions).toContain("never merely for a URL");
    }

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
    if (slug === "s04-system-capability-extractor") {
      const unevidenced: ArtifactSnapshot = {
        ...example,
        meta: { ...example.meta, id: "art_unevidenced_current" },
        content: { ...(example.content as object), availability: "current" },
      };
      await expect(runtime.artifacts.create(unevidenced)).rejects.toThrow();
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
    expect(
      (await runtime.orchestrator.next("run_missing", [missing])).actions[0]
        ?.action,
    ).toBe("BLOCK");
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
    await expect(runtime.artifacts.create(fakeApproval)).rejects.toThrow(
      /Human approval is not verified/,
    );
    await expect(
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
    ).rejects.toThrow(/Result does not match invocation/);
    await expect(
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
    ).rejects.toThrow(
      /Unexpected Skill result effect|Unexpected Skill work effect/,
    );
    await expect(
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
    ).rejects.toThrow(/Direct Skill invocation/);
    const valid = await runSkillPackage({
      orchestrator: runtime.orchestrator,
      package: skill,
      runId: "run_catalog",
      tasks,
      taskId: "target",
      at: now,
      executor: async ({ invocation, inputs, gaps }) => {
        expect(inputs.map((item) => item.ref)).toEqual(invocation.inputRefs);
        expect(gaps).toEqual(
          skill.manifest.inputs.optional
            .filter(
              (item) =>
                item.kind === "artifact" &&
                !requiredTypes.includes(item.artifactType),
            )
            .map((item) => item.name),
        );
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
  });

test("S03 reuses an approved organization Brand by exact lock without creating a duplicate", async () => {
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
  expect(result.result.outputRefs).toEqual([ref(approved)]);
  expect(
    (await runtime.registry.run("run_brand_inherit")).run.artifacts,
  ).not.toContainEqual(ref(approved));
});
