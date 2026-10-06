import { afterEach, expect, test } from "vitest";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
  type SkillResult,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";
import { loadSkillPackage, runSkillPackage } from "./index.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemasRoot = path.join(repository, "schemas");
const fixture = path.join(repository, "fixtures/skill-runtime/demo");
const now = "2026-10-06T12:00:00Z";
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function copyPackage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-skill-package-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  const file = path.join(root, "manifest.yaml");
  const source = await readFile(file, "utf8");
  return {
    root,
    file,
    source,
    update: (value: string) => writeFile(file, value),
  };
}

test("loads the merged manifest, instructions, examples and tests", async () => {
  const skill = await loadSkillPackage(fixture, schemasRoot);
  expect(skill.manifest.skillId).toBe("mimic.runtime.demo");
  expect(skill.instructions).toContain("provisional product-definition");
  expect(skill.examples["examples/intent.json"]).toContain("intent");
  expect(skill.tests["tests/contract-case.json"]).toContain("provisional");
});

test("rejects malformed versions, declarations and package references", async () => {
  const x = await copyPackage();
  for (const [source, expected] of [
    [
      x.source.replace("manifestVersion: 1.0.0", "manifestVersion: 2.0.0"),
      /Manifest shape/,
    ],
    [
      x.source.replace("packageVersion: 0.1.0", "packageVersion: 01.0.0"),
      /Manifest shape/,
    ],
    [
      x.source.replace("schemaVersion: 1.0.0", "schemaVersion: 2.0.0"),
      /Manifest shape/,
    ],
    [
      x.source.replace("artifactType: decision", "artifactType: imaginary"),
      /Unsupported artifact type/,
    ],
    [
      x.source.replace("examples/intent.json", "../demo/SKILL.md"),
      /Manifest shape|Path escapes/,
    ],
    [
      x.source.replace("examples/intent.json", "examples/missing.json"),
      /ENOENT/,
    ],
    [
      x.source.replace("examples/intent.json", "examples//intent.json"),
      /Non-canonical/,
    ],
    [x.source.replace("  - decision\n", "  - brand\n"), /Undeclared output/],
  ] as const) {
    await x.update(source);
    await expect(loadSkillPackage(x.root, schemasRoot)).rejects.toThrow(
      expected,
    );
  }
  await x.update(x.source);
  await rm(path.join(x.root, "examples/intent.json"));
  await symlink(
    path.join(fixture, "examples/intent.json"),
    path.join(x.root, "examples/intent.json"),
  );
  await expect(loadSkillPackage(x.root, schemasRoot)).rejects.toThrow(
    /Symlink/,
  );
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-skill-run-"));
  roots.push(root);
  const workspace = new FileWorkspaceStorage(path.join(root, "workspace.json"));
  const schemas = await loadSchemaDirectory(
    path.join(schemasRoot, "artifacts"),
  );
  const authority = {
    async verify(record: { actor: { kind: string; id: string } }) {
      return record.actor.kind === "human" && record.actor.id === "human_1";
    },
    async allowCommit() {
      return true;
    },
  };
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    scopes,
    authority,
  );
  const skill = await loadSkillPackage(fixture, schemasRoot);
  const task: RoutedTask = {
    id: "demo",
    skillId: skill.manifest.skillId,
    outputType: "product-definition",
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    humanBrief: "Bounded human intent",
    evidenceFiles: ["research.txt"],
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }],
      optional: [{ name: "research", kind: "evidence-file" }],
      alternatives: [
        {
          oneOf: [
            {
              name: "existing-definition",
              kind: "artifact",
              artifactType: "product-definition",
              schemaVersion: "1.0.0",
            },
            { name: "context-brief", kind: "human-brief" },
          ],
        },
      ],
    },
  };
  const start = (tasks: readonly RoutedTask[] = [task]) =>
    runtime.orchestrator.start({
      id: "run_skill",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: { kind: "agent", id: "agent_1" },
      at: now,
      tasks,
    });
  const template = JSON.parse(
    await readFile(
      path.join(repository, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  function candidate(
    id: string,
    skillId = task.skillId,
    dependencies: ArtifactSnapshot["dependencies"] = [],
  ): ArtifactSnapshot {
    return {
      ...template,
      meta: { ...template.meta, id },
      origin: {
        actorKind: "skill",
        actorId: skillId,
        runId: "run_skill",
        createdAt: now,
      },
      dependencies,
    };
  }
  const ref = (artifact: ArtifactSnapshot) => ({
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  });
  return { ...runtime, skill, task, start, candidate, ref };
}

async function execute(
  x: Awaited<ReturnType<typeof setup>>,
  result: SkillResult,
  mutate?: (
    context: Parameters<Parameters<typeof runSkillPackage>[0]["executor"]>[0],
  ) => void,
) {
  return runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks: [x.task],
    taskId: "demo",
    at: now,
    executor: async (context) => {
      mutate?.(context);
      return { result };
    },
  });
}

async function seedApprovedDefinition(
  x: Awaited<ReturnType<typeof setup>>,
): Promise<ArtifactSnapshot> {
  const seedTask = { ...x.task, id: "seed" };
  await x.orchestrator.start({
    id: "run_seed",
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks: [seedTask],
  });
  const proposed = {
    ...x.candidate("art_approved_reuse"),
    lifecycle: { status: "proposed" as const, freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: x.task.skillId,
      runId: "run_seed",
      createdAt: now,
    },
  } as ArtifactSnapshot;
  await x.artifacts.create(proposed);
  await x.registry.produce({
    runId: "run_seed",
    ref: x.ref(proposed),
    inputs: [],
    actor: { kind: "skill", id: x.task.skillId },
    at: now,
    reason: "Propose definition",
  });
  await x.registry.submit({
    runId: "run_seed",
    packetId: "packet_reuse",
    proposals: [
      {
        id: "proposal_reuse",
        ref: x.ref(proposed),
        alternatives: ["approve", "reject"],
        rationale: "Review product scope",
        evidenceLimits: [],
        dependents: [],
      },
    ],
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    reason: "Human review",
  });
  const approvedBare: ArtifactSnapshot = {
    ...proposed,
    meta: { ...proposed.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_reuse",
      actorId: "human_1",
      at: now,
    },
  };
  const approved: ArtifactSnapshot = {
    ...approvedBare,
    meta: { ...approvedBare.meta, contentDigest: artifactDigest(approvedBare) },
  };
  await x.registry.decide({
    id: "decision_reuse",
    packetId: "packet_reuse",
    proposalId: "proposal_reuse",
    outcome: "approved",
    actor: { kind: "human", id: "human_1" },
    at: now,
    rationale: "Approve exact scope",
    output: { ref: x.ref(approved), artifact: approved },
  });
  await x.registry.commit({
    id: "commit_reuse",
    packetId: "packet_reuse",
    approvals: [{ proposalId: "proposal_reuse", decisionId: "decision_reuse" }],
    actor: { kind: "human", id: "human_1" },
    at: now,
    reason: "Human commit",
  });
  return approved;
}

test("recovers a partial produce/submit failure without duplicate ownership", async () => {
  const x = await setup();
  await x.start();
  const artifact = x.candidate("art_demo_output");
  await x.artifacts.create(artifact);
  const result: SkillResult = {
    runId: "run_skill",
    taskId: "demo",
    skillId: x.task.skillId,
    inputRefs: [],
    outputRefs: [x.ref(artifact)],
    proposal: {
      packetId: "packet_demo",
      items: [
        {
          id: "proposal_demo",
          ref: x.ref(artifact),
          alternatives: ["approve", "reject"],
          rationale: "Human product choice",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      reason: "Human review",
    },
  };
  // A proposal must name a proposed snapshot; a provisional output can still be accepted without a packet.
  await expect(execute(x, result)).rejects.toThrow(
    /Proposal must be fresh and pending/,
  );
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(artifact),
  ]);
  const retry = structuredClone(result);
  delete (retry as { proposal?: SkillResult["proposal"] }).proposal;
  await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks: [x.task],
    taskId: "demo",
    at: now,
    executor: async ({ invocation }) => ({
      result: { ...retry, inputRefs: invocation.inputRefs },
    }),
  });
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(artifact),
  ]);
});

test("accepts blocked zero-output work and rejects direct or canonical effects", async () => {
  const x = await setup();
  await x.start();
  const base: SkillResult = {
    runId: "run_skill",
    taskId: "demo",
    skillId: x.task.skillId,
    inputRefs: [],
    outputRefs: [],
    blocked: { reason: "No honest candidate", affectedTaskIds: ["demo"] },
  };
  await expect(
    execute(x, {
      ...base,
      directSkillCalls: ["other"],
    } as unknown as SkillResult),
  ).rejects.toThrow(/Direct Skill invocation/);
  await expect(
    execute(x, { ...base, canonicalWrite: true } as unknown as SkillResult),
  ).rejects.toThrow(/Unexpected Skill result effect/);
  await execute(x, base);
  expect((await x.registry.run("run_skill")).run.blockers.demo).toBe(
    "No honest candidate",
  );
});

test("keeps stored input separate from executor mutation and enforces exact output declarations", async () => {
  const x = await setup();
  const producer: RoutedTask = {
    id: "producer",
    skillId: "mimic.producer",
    outputType: "product-definition",
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "AUTONOMOUS",
    inputs: { required: [], optional: [], alternatives: [] },
  };
  const artifact = x.candidate("art_input", producer.skillId);
  await x.start([producer, x.task]);
  await x.artifacts.create(artifact);
  await x.registry.produce({
    runId: "run_skill",
    ref: x.ref(artifact),
    inputs: [],
    actor: { kind: "skill", id: producer.skillId },
    at: now,
    reason: "Prior task output",
  });
  const task = { ...x.task, humanBrief: "Bounded human intent" };
  const output = x.candidate("art_output", task.skillId, [
    { ...x.ref(artifact), onChange: "validate" },
  ]);
  await x.artifacts.create(output);
  const result: SkillResult = {
    runId: "run_skill",
    taskId: "demo",
    skillId: task.skillId,
    inputRefs: [x.ref(artifact)],
    outputRefs: [x.ref(output)],
  };
  await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks: [producer, task],
    taskId: "demo",
    at: now,
    executor: async (context) => {
      expect(context.inputs).toHaveLength(1);
      expect(context.gaps).toEqual([]);
      expect(context.inputs[0]?.name).toBe("existing-definition");
      (context.inputs[0]!.artifact.content as { summary: string }).summary =
        "executor mutation";
      return {
        result,
        findings: [
          { claim: "Needs review", evidenceRefs: [], status: "UNVERIFIED" },
        ],
      };
    },
  });
  expect(
    (await x.artifacts.read(artifact.meta.id, 1)).artifact.content,
  ).toEqual(artifact.content);
  expect((await x.registry.run("run_skill")).run.artifacts).toContainEqual(
    x.ref(output),
  );
});

test("rejects wrong Run origin, undeclared output type and wrong exact references", async () => {
  const x = await setup();
  await x.start();
  const wrongOrigin = x.candidate("art_wrong_origin", "mimic.other");
  await x.artifacts.create(wrongOrigin);
  const base = {
    runId: "run_skill",
    taskId: "demo",
    skillId: x.task.skillId,
    inputRefs: [],
    outputRefs: [x.ref(wrongOrigin)],
  };
  await expect(execute(x, base)).rejects.toThrow(/Output origin mismatch/);
  const wrongRef = {
    ...base,
    outputRefs: [
      { ...x.ref(wrongOrigin), lockDigest: `sha256:${"0".repeat(64)}` },
    ],
  };
  await expect(execute(x, wrongRef)).rejects.toThrow(/lock mismatch/i);
  const foreignBase = x.candidate("art_foreign_type");
  const foreign: ArtifactSnapshot = {
    ...foreignBase,
    meta: { ...foreignBase.meta, type: "brand" },
    content: {
      summary: "A brand",
      attributes: ["clear"],
      voice: "plain",
      visualIntent: "quiet",
    },
  };
  await x.artifacts.create(foreign);
  await expect(
    execute(x, { ...base, outputRefs: [x.ref(foreign)] }),
  ).rejects.toThrow(/Skill output cannot be durable/);
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_skill",
      tasks: [{ ...x.task, outputType: "brand" }],
      taskId: "demo",
      at: now,
      executor: async () => ({ result: base }),
    }),
  ).rejects.toThrow(/undeclared output type/);
});

test("missing required intent blocks only its task; optional evidence is an explicit gap", async () => {
  const x = await setup();
  const withoutBrief = structuredClone(x.task);
  delete (withoutBrief as { humanBrief?: string }).humanBrief;
  await x.start([withoutBrief]);
  const plan = await x.orchestrator.next("run_skill", [withoutBrief]);
  expect(plan.actions[0]?.action).toBe("BLOCK");
  expect(plan.actions[0]?.reason).toMatch(/Missing required brief/);
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_skill",
      tasks: [withoutBrief],
      taskId: "demo",
      at: now,
      executor: async () => {
        throw new Error("must not run");
      },
    }),
  ).rejects.toThrow(/not routable/);

  const y = await setup();
  await y.start();
  const artifact = y.candidate("art_optional_gap");
  await y.artifacts.create(artifact);
  await runSkillPackage({
    orchestrator: y.orchestrator,
    package: y.skill,
    runId: "run_skill",
    tasks: [{ ...y.task, evidenceFiles: [] }],
    taskId: "demo",
    at: now,
    executor: async (context) => {
      expect(context.gaps).toEqual(["research"]);
      return {
        result: {
          runId: "run_skill",
          taskId: "demo",
          skillId: y.task.skillId,
          inputRefs: [],
          outputRefs: [y.ref(artifact)],
        },
      };
    },
  });
});

test("reuses an unchanged approved exact output from the Run base", async () => {
  const x = await setup();
  const approved = await seedApprovedDefinition(x);
  const task = {
    ...x.task,
    intent: "revise" as const,
    targetArtifactId: approved.meta.id,
  };
  await x.orchestrator.start({
    id: "run_skill",
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks: [task],
  });
  await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks: [task],
    taskId: "demo",
    at: now,
    executor: async ({ invocation }) => {
      expect(invocation.inputRefs).toEqual([x.ref(approved)]);
      return {
        result: {
          runId: "run_skill",
          taskId: "demo",
          skillId: task.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [x.ref(approved)],
        },
      };
    },
  });
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([]);
  expect(
    (await x.registry.snapshot()).canonical[approved.meta.id]?.ref,
  ).toEqual(x.ref(approved));
});

test("rejects replay of another task’s rejected candidate and packet", async () => {
  const x = await setup();
  const second = { ...x.task, id: "second" };
  const tasks = [x.task, second];
  await x.start(tasks);
  const candidate = {
    ...x.candidate("art_rejected_candidate"),
    lifecycle: { status: "proposed" as const, freshness: "valid" },
  };
  await x.artifacts.create(candidate);
  await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks,
    taskId: "demo",
    at: now,
    executor: async () => ({
      result: {
        runId: "run_skill",
        taskId: "demo",
        skillId: x.task.skillId,
        inputRefs: [],
        outputRefs: [x.ref(candidate)],
        proposal: {
          packetId: "packet_reject",
          items: [
            {
              id: "proposal_reject",
              ref: x.ref(candidate),
              alternatives: ["approve", "reject"],
              rationale: "Review the product definition",
              evidenceLimits: [],
              dependents: [],
            },
          ],
          reason: "Human choice",
        },
      },
    }),
  });
  expect(
    (await x.registry.run("run_skill")).run.proposals.proposal_reject.status,
  ).toBe("pending");
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_skill",
      tasks,
      taskId: "second",
      at: now,
      executor: async ({ invocation }) => ({
        result: {
          runId: "run_skill",
          taskId: "second",
          skillId: second.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [x.ref(candidate)],
        },
      }),
    }),
  ).rejects.toThrow(/Existing output belongs to another task/);
  const rejectedBare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "rejected", freshness: "valid" },
    approval: {
      status: "rejected",
      decisionId: "decision_reject",
      actorId: "human_1",
      at: now,
    },
  };
  const rejected: ArtifactSnapshot = {
    ...rejectedBare,
    meta: { ...rejectedBare.meta, contentDigest: artifactDigest(rejectedBare) },
  };
  await x.registry.decide({
    id: "decision_reject",
    packetId: "packet_reject",
    proposalId: "proposal_reject",
    outcome: "rejected",
    actor: { kind: "human", id: "human_1" },
    at: now,
    rationale: "Reject this candidate",
    output: { ref: x.ref(rejected), artifact: rejected },
  });
  expect(
    (await x.registry.run("run_skill")).run.proposals.proposal_reject.status,
  ).toBe("rejected");
  expect(
    (await x.registry.snapshot()).canonical[candidate.meta.id],
  ).toBeUndefined();
  expect(
    (await x.artifacts.read(candidate.meta.id, 2)).artifact.lifecycle.status,
  ).toBe("rejected");
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_skill",
      tasks,
      taskId: "second",
      at: now,
      executor: async ({ invocation }) => ({
        result: {
          runId: "run_skill",
          taskId: "second",
          skillId: second.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [x.ref(candidate)],
          proposal: {
            packetId: "packet_reject",
            items: [
              {
                id: "proposal_reject",
                ref: x.ref(candidate),
                alternatives: ["approve", "reject"],
                rationale: "Review the product definition",
                evidenceLimits: [],
                dependents: [],
              },
            ],
            reason: "Human choice",
          },
        },
      }),
    }),
  ).rejects.toThrow(
    /Rejected or resolved output|Result packet belongs to another task/,
  );
  expect((await x.registry.run("run_skill")).run.safeActions).toContain(
    "second",
  );
});

test("routes an accepted upstream revision request once after the harness closes its task", async () => {
  const x = await setup();
  const source = await seedApprovedDefinition(x);
  const task: RoutedTask = {
    ...x.task,
    outputType: "system-request",
    intent: "create",
  };
  await x.orchestrator.start({
    id: "run_skill",
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at: now,
    tasks: [task],
  });
  const systemTemplate = JSON.parse(
    await readFile(
      path.join(repository, "fixtures/artifacts/valid/system-request.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const request: ArtifactSnapshot = {
    ...systemTemplate,
    meta: { ...systemTemplate.meta, id: "art_upstream_request" },
    origin: {
      actorKind: "skill",
      actorId: task.skillId,
      runId: "run_skill",
      createdAt: now,
    },
    dependencies: [{ ...x.ref(source), onChange: "validate" }],
    provenance: [
      {
        path: "/content",
        kind: "assumption",
        rationale: "Request based on observed design constraint",
        evidenceRefs: ["evidence://constraint"],
      },
    ],
  };
  await x.artifacts.create(request);
  const revisionRequest = {
    runId: "run_skill",
    source: x.ref(source),
    request: x.ref(request),
    affectedLocks: [x.ref(source)],
    evidenceRefs: ["evidence://constraint"],
    reason: "Revise upstream product scope",
  };
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_skill",
    tasks: [task],
    taskId: "demo",
    at: now,
    executor: async ({ invocation }) => ({
      result: {
        runId: "run_skill",
        taskId: "demo",
        skillId: task.skillId,
        inputRefs: invocation.inputRefs,
        outputRefs: [x.ref(request)],
      },
      revisionRequests: [revisionRequest],
    }),
  });
  expect(work.revisionRequests).toEqual([revisionRequest]);
  expect((await x.registry.run("run_skill")).run.closed).toBeDefined();
  await expect(
    x.orchestrator.requestUpstream(
      revisionRequest,
      { kind: "skill", id: task.skillId },
      now,
    ),
  ).resolves.toBeUndefined();
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(request),
  ]);
  await expect(
    x.orchestrator.requestUpstream(
      revisionRequest,
      { kind: "skill", id: task.skillId },
      now,
    ),
  ).resolves.toBeUndefined();
  await expect(
    x.orchestrator.requestUpstream(
      { ...revisionRequest, evidenceRefs: ["evidence://invented"] },
      { kind: "skill", id: task.skillId },
      now,
    ),
  ).rejects.toThrow(/evidence is absent/);
  await expect(
    x.orchestrator.requestUpstream(
      revisionRequest,
      { kind: "agent", id: task.skillId },
      now,
    ),
  ).rejects.toThrow(/cannot mutate approved source/);
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(request),
  ]);
  const lateRequest: ArtifactSnapshot = {
    ...request,
    meta: { ...request.meta, id: "art_late_request" },
  };
  await x.artifacts.create(lateRequest);
  await expect(
    x.orchestrator.requestUpstream(
      { ...revisionRequest, request: x.ref(lateRequest) },
      { kind: "skill", id: task.skillId },
      now,
    ),
  ).rejects.toThrow(/Run cannot produce provisional work/);
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(request),
  ]);
});

test("retries only the same live packet after an accepted proposal loses its response", async () => {
  const x = await setup();
  await x.start();
  const candidate = {
    ...x.candidate("art_packet_retry"),
    lifecycle: { status: "proposed" as const, freshness: "valid" },
  };
  await x.artifacts.create(candidate);
  const proposal = {
    packetId: "packet_retry",
    items: [
      {
        id: "proposal_retry",
        ref: x.ref(candidate),
        alternatives: ["approve", "reject"],
        rationale: "Review exact definition",
        evidenceLimits: [],
        dependents: [],
      },
    ],
    reason: "Human review",
  };
  const originalSetWork = x.registry.setWork.bind(x.registry);
  let fail = true;
  x.registry.setWork = async (input) => {
    if (fail) {
      fail = false;
      throw new Error("lost acceptance response");
    }
    return originalSetWork(input);
  };
  const attempt = (rationale = proposal.items[0]!.rationale) =>
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_skill",
      tasks: [x.task],
      taskId: "demo",
      at: now,
      executor: async ({ invocation }) => ({
        result: {
          runId: "run_skill",
          taskId: "demo",
          skillId: x.task.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [x.ref(candidate)],
          proposal: {
            ...proposal,
            items: [{ ...proposal.items[0]!, rationale }],
          },
        },
      }),
    });
  await expect(attempt()).rejects.toThrow(/lost acceptance response/);
  expect(
    (await x.registry.run("run_skill")).run.proposals.proposal_retry.status,
  ).toBe("pending");
  await expect(attempt("Different packet rationale")).rejects.toThrow(
    /no longer live/,
  );
  await expect(attempt()).resolves.toBeDefined();
  expect((await x.registry.run("run_skill")).run.artifacts).toEqual([
    x.ref(candidate),
  ]);
  expect((await x.registry.run("run_skill")).run.safeActions).not.toContain(
    "demo",
  );
});
