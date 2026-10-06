import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest, type JsonValue } from "../artifact-canonical.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { loadSkillPackage, runSkillPackage } from "../skill-runtime/index.js";
import { compileApprovedTokenAssets } from "../token-compiler/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const at = "2026-10-06T12:00:00Z";
const human = { kind: "human" as const, id: "human_s13_fixture" };
const agent = { kind: "agent" as const, id: "agent_s13_fixture" };
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
const ref = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-s13-token-"));
  roots.push(root);
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const skill = await loadSkillPackage(
    path.join(repository, "skills/s13-visual-system-builder"),
    path.join(repository, "schemas"),
  );
  const example = JSON.parse(skill.examples["examples/output.json"]!) as {
    assets: ArtifactSnapshot[];
  };
  const seedDigests = new Map<string, string>();
  const isExactSeed = (artifact: ArtifactSnapshot) =>
    artifact.meta.revision === 1 &&
    artifact.approval.status === "approved" &&
    artifact.approval.decisionId === "seed_s13" &&
    artifact.approval.actorId === human.id &&
    artifact.approval.at === at &&
    seedDigests.get(artifact.meta.id) === artifactDigest(artifact);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
    scopes,
    {
      async verify(record, proposal) {
        return (
          record.actor.kind === "human" &&
          record.actor.id === human.id &&
          ["approved", "rejected"].includes(record.outcome) &&
          record.output?.ref.artifactId === proposal.ref.artifactId &&
          record.output.ref.revision === proposal.ref.revision + 1
        );
      },
      async allowCommit(request) {
        return request.actor.kind === "human" && request.actor.id === human.id;
      },
    },
    {
      async verifyApproval(approval, artifact) {
        return approval.decisionId === "seed_s13" && isExactSeed(artifact);
      },
      async verifyDecision(id, artifact) {
        return id === "seed_s13" && isExactSeed(artifact);
      },
    },
  );
  const filenames = [
    "brand.json",
    "approved-design-direction.json",
    "proposed-product-ui-contract.json",
  ];
  const fixtures = await Promise.all(
    filenames.map(
      async (file) =>
        JSON.parse(
          await readFile(
            path.join(repository, "fixtures/artifacts/valid", file),
            "utf8",
          ),
        ) as ArtifactSnapshot,
    ),
  );
  fixtures.push(example.assets[0]!);
  const seeds: ArtifactSnapshot[] = fixtures.map((fixture, index) => {
    const bare: ArtifactSnapshot = {
      ...fixture,
      meta: {
        id: `art_s13_input_${index}`,
        type: fixture.meta.type,
        schemaVersion: "1.0.0",
        revision: 1,
        title: `S13 input ${index}`,
        createdAt: at,
      },
      lifecycle: { status: "approved", freshness: "valid" },
      approval: {
        status: "approved",
        decisionId: "seed_s13",
        actorId: human.id,
        at,
      },
      dependencies: [],
      provenance: [
        {
          path: "/content",
          kind: "assumption",
          rationale: "Synthetic approved input for contract exercise",
        },
      ],
      content: fixture.content,
    };
    return {
      ...bare,
      meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
    };
  });
  for (const seed of seeds) seedDigests.set(seed.meta.id, artifactDigest(seed));
  for (const seed of seeds) await runtime.artifacts.create(seed);
  await runtime.registry.seedCanonical(seeds.map(ref));
  const task: RoutedTask = {
    id: "tokens",
    skillId: skill.manifest.skillId,
    outputType: "design-system-asset",
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: {
      required: skill.manifest.inputs.required.map((input, index) => ({
        ...input,
        refs: [ref(seeds[index]!)],
      })),
      optional: skill.manifest.inputs.optional,
      alternatives: [],
    },
  };
  const retryTask: RoutedTask = { ...task, id: "tokens-retry" };
  const keepOpen: RoutedTask = {
    id: "independent-followup",
    skillId: "mimic.fixture",
    outputType: "evaluation",
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "AUTONOMOUS",
    inputs: { required: [], optional: [], alternatives: [] },
  };
  const tasks = [task, retryTask, keepOpen];
  await runtime.orchestrator.start({
    id: "run_s13_tokens",
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: agent,
    at,
    tasks,
  });
  return {
    ...runtime,
    skill,
    example,
    task,
    retryTask,
    tasks,
    seeds,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;
function candidate(
  x: Setup,
  revision: number,
  tokens?: unknown,
): ArtifactSnapshot {
  const source = x.example.assets[1]!;
  const content = source.content as { definition: Record<string, unknown> };
  return {
    ...source,
    meta: {
      ...source.meta,
      id: "art_s13_compiler_bridge",
      revision,
      ...(revision > 1 ? { supersedesRevision: revision - 1 } : {}),
    },
    origin: {
      actorKind: "skill",
      actorId: x.skill.manifest.skillId,
      runId: "run_s13_tokens",
      createdAt: at,
    },
    dependencies: x.seeds.map((seed) => ({
      ...ref(seed),
      onChange: "validate",
    })),
    provenance: [
      {
        path: "/content/definition/tokens",
        kind: "derived",
        inputRefs: x.seeds.map((seed) => {
          const lock = ref(seed);
          return `${lock.artifactId}@${lock.revision}#${lock.lockDigest}`;
        }),
        rationale:
          "Synthetic package candidate from exact approved inputs; design quality unverified",
      },
    ],
    content:
      tokens === undefined
        ? source.content
        : {
            ...content,
            definition: { ...content.definition, tokens: tokens as JsonValue },
          },
  };
}

async function produce(x: Setup, output: ArtifactSnapshot, task = x.task) {
  return runSkillPackage({
    orchestrator: x.orchestrator,
    package: x.skill,
    runId: "run_s13_tokens",
    tasks: x.tasks,
    taskId: task.id,
    at,
    executor: async ({ invocation, inputs }) => {
      expect(inputs.map((item) => item.ref)).toEqual(x.seeds.map(ref));
      expect(invocation.inputRefs).toEqual(x.seeds.map(ref));
      await x.artifacts.create(output);
      return {
        result: {
          runId: invocation.runId,
          taskId: invocation.taskId,
          skillId: invocation.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [ref(output)],
        },
      };
    },
  });
}

function decided(
  candidate: ArtifactSnapshot,
  decisionId: string,
  outcome: "approved" | "rejected",
) {
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: {
      ...candidate.meta,
      revision: candidate.meta.revision + 1,
      supersedesRevision: candidate.meta.revision,
    },
    lifecycle: { status: outcome, freshness: "valid" },
    approval: { status: outcome, decisionId, actorId: human.id, at },
  };
  return {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
}

async function review(
  x: Setup,
  output: ArtifactSnapshot,
  outcome: "approved" | "rejected",
  suffix = "first",
  priorRejectionId?: string,
  commitApproved = true,
) {
  const packetId = `packet_s13_${suffix}`;
  const proposalId = `proposal_s13_${suffix}`;
  const decisionId = `decision_s13_${suffix}`;
  await x.registry.submit({
    runId: "run_s13_tokens",
    packetId,
    proposals: [
      {
        id: proposalId,
        ref: ref(output),
        alternatives: ["approve", "reject"],
        rationale: "Review exact synthetic token candidate",
        evidenceLimits: ["No human read or visual effectiveness is simulated"],
        dependents: [],
        ...(priorRejectionId ? { priorRejectionId } : {}),
      },
    ],
    actor: agent,
    at,
    reason: "Submit exact candidate for simulated review",
  });
  const envelope = decided(output, decisionId, outcome);
  await x.registry.decide({
    id: decisionId,
    packetId,
    proposalId,
    outcome,
    actor: human,
    at,
    rationale:
      "Test fixture simulates explicit human decision; no actual human review",
    output: { ref: ref(envelope), artifact: envelope },
  });
  if (outcome === "approved" && commitApproved) {
    await x.registry.commit({
      id: `commit_s13_${suffix}`,
      packetId,
      approvals: [{ proposalId, decisionId }],
      actor: human,
      at,
      reason: "Test fixture simulates explicit human commit",
    });
  }
  return envelope;
}

test("S13 package candidate compiles only its committed exact revision to CSS", async () => {
  const x = await setup();
  const proposal = candidate(x, 1);
  const work = await produce(x, proposal);
  expect(work.result.outputRefs).toEqual([ref(proposal)]);
  await expect(
    compileApprovedTokenAssets(x.artifacts, [ref(proposal)]),
  ).rejects.toThrow();
  const approved = await review(
    x,
    proposal,
    "approved",
    "first",
    undefined,
    false,
  );
  const approvedRef = ref(approved);
  expect(
    (await x.registry.snapshot()).decisions.decision_s13_first?.outcome,
  ).toBe("approved");
  expect(
    (await x.registry.snapshot()).commits.commit_s13_first,
  ).toBeUndefined();
  await expect(x.artifacts.create(approved)).rejects.toThrow(
    /approval|authority/i,
  );
  await expect(
    compileApprovedTokenAssets(x.artifacts, [approvedRef]),
  ).rejects.toThrow();
  expect(
    (await x.registry.snapshot()).canonical[approvedRef.artifactId],
  ).toBeUndefined();
  await x.registry.commit({
    id: "commit_s13_first",
    packetId: "packet_s13_first",
    approvals: [
      { proposalId: "proposal_s13_first", decisionId: "decision_s13_first" },
    ],
    actor: human,
    at,
    reason: "Test fixture simulates explicit human commit",
  });
  const stored = await x.artifacts.read(
    approvedRef.artifactId,
    approvedRef.revision,
  );
  expect(stored.artifact.dependencies).toEqual(
    x.seeds.map((seed) => ({ ...ref(seed), onChange: "validate" })),
  );
  expect(stored.artifact.provenance).toEqual(proposal.provenance);
  expect(
    (await x.registry.snapshot()).canonical[approvedRef.artifactId]?.ref,
  ).toEqual(approvedRef);
  const callerRef = { ...approvedRef };
  const result = await compileApprovedTokenAssets(x.artifacts, [callerRef]);
  callerRef.lockDigest = `sha256:${"0".repeat(64)}`;
  expect(result.sources).toEqual([approvedRef]);
  expect(
    result.tokens.every(
      (token) => token.source.lockDigest === approvedRef.lockDigest,
    ),
  ).toBe(true);
  expect(result.css).toBe(
    `:root {\n  --mimic-component-comparison-evidence-border: var(--mimic-semantic-color-evidence);\n  --mimic-component-comparison-section-gap: var(--mimic-primitive-space-section);\n  --mimic-primitive-color-evidence-ink: color(srgb 0.0862745 0.1960784 0.3098039);\n  --mimic-primitive-color-uncertainty-amber: color(srgb 0.5490196 0.3529412 0.0862745);\n  --mimic-primitive-space-section: 1rem;\n  --mimic-semantic-color-evidence: var(--mimic-primitive-color-evidence-ink);\n  --mimic-semantic-color-uncertain: var(--mimic-primitive-color-uncertainty-amber);\n}\n`,
  );
  await expect(
    compileApprovedTokenAssets(x.artifacts, [callerRef]),
  ).rejects.toThrow(/lock mismatch/i);
  expect(
    (await x.artifacts.read(proposal.meta.id, 1)).artifact.lifecycle.status,
  ).toBe("proposed");
});

test.each([
  ["legacy", /layer/i],
  ["invalid-color", /legacy/i],
  ["unsupported-type", /unsupported type/i],
  ["unresolved", /unresolved/i],
] as const)(
  "approved %s candidate fails closed on invalid tokens",
  async (name, error) => {
    const x = await setup();
    const original = (
      x.example.assets[1]!.content as {
        definition: { tokens: Record<string, unknown> };
      }
    ).definition.tokens;
    let tokens = structuredClone(original);
    if (name === "legacy") {
      tokens = { color: { evidence: { $type: "color", $value: "#16324f" } } };
    } else if (name === "invalid-color") {
      const primitive = tokens.primitive as {
        color: Record<string, { $value: unknown }>;
      };
      primitive.color["evidence-ink"]!.$value = "#16324f";
    } else if (name === "unsupported-type") {
      const primitive = tokens.primitive as {
        color: Record<string, { $type?: string }>;
      };
      primitive.color["evidence-ink"]!.$type = "fontFamily";
    } else {
      const semantic = tokens.semantic as {
        color: { evidence: { $value: unknown } };
      };
      semantic.color.evidence.$value = "{primitive.color.missing}";
    }
    const proposal = candidate(x, 1, tokens);
    await produce(x, proposal);
    const approved = await review(x, proposal, "approved");
    await expect(
      compileApprovedTokenAssets(x.artifacts, [ref(approved)]),
    ).rejects.toThrow(error);
  },
);

test("rejection preserves history and requires a later proposal before compilation", async () => {
  const x = await setup();
  const first = candidate(x, 1);
  await produce(x, first);
  const rejected = await review(x, first, "rejected");
  await expect(
    compileApprovedTokenAssets(x.artifacts, [ref(rejected)]),
  ).rejects.toThrow();
  const retry = candidate(x, 3);
  await produce(x, retry, x.retryTask);
  const approved = await review(
    x,
    retry,
    "approved",
    "retry",
    "decision_s13_first",
  );
  expect(approved.meta.revision).toBe(4);
  expect(
    (await x.artifacts.read(first.meta.id, 1)).artifact.lifecycle.status,
  ).toBe("proposed");
  expect(
    (await x.artifacts.read(rejected.meta.id, 2)).artifact.lifecycle.status,
  ).toBe("rejected");
  expect(
    (await compileApprovedTokenAssets(x.artifacts, [ref(approved)])).css,
  ).toContain(
    "--mimic-semantic-color-evidence: var(--mimic-primitive-color-evidence-ink)",
  );
});

test("wrong routed input digest makes required brand unavailable before execution", async () => {
  const x = await setup();
  const task: RoutedTask = {
    ...x.task,
    inputs: {
      ...x.task.inputs,
      required: x.task.inputs.required.map((input, index) =>
        index === 0 && input.kind === "artifact"
          ? {
              ...input,
              refs: [
                { ...ref(x.seeds[0]!), lockDigest: `sha256:${"0".repeat(64)}` },
              ],
            }
          : input,
      ),
    },
  };
  let called = false;
  const planned = await x.orchestrator.next("run_s13_tokens", [
    task,
    x.retryTask,
    x.tasks[2]!,
  ]);
  expect(
    planned.actions.find((action) => action.taskId === "tokens"),
  ).toMatchObject({
    action: "BLOCK",
    reason: expect.stringMatching(/Missing required brand/),
  });
  await expect(
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId: "run_s13_tokens",
      tasks: [task, x.retryTask, x.tasks[2]!],
      taskId: "tokens",
      at,
      executor: async () => {
        called = true;
        throw new Error("executor must not run");
      },
    }),
  ).rejects.toThrow(/not routable|lock mismatch/i);
  expect(called).toBe(false);
});
