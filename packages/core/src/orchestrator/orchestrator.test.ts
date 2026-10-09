import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import type {
  DecisionRecord,
  RegistryAuthority,
} from "../run-registry/registry.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
  type InputNeed,
} from "./router.js";
import { resolveApprovedPolicy } from "./policy.js";

const now = "2026-10-06T12:00:00Z";
const human = { kind: "human" as const, id: "human_1" };
const agent = { kind: "agent" as const, id: "agent_1" };
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
  { level: "domain", ownerId: "domain_checkout", parentId: "product_mimic" },
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const repository = path.resolve(import.meta.dirname, "../../../..");
const reference = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
function asset(
  template: ArtifactSnapshot,
  id: string,
  scope: ScopeNode,
  content: Record<string, unknown>,
  status: "approved" | "proposed" = "approved",
  revision = 1,
  dependencies: ArtifactSnapshot["dependencies"] = [],
): ArtifactSnapshot {
  const bare: ArtifactSnapshot = {
    ...template,
    meta: {
      ...template.meta,
      id,
      revision,
      ...(revision > 1 ? { supersedesRevision: revision - 1 } : {}),
    },
    scope,
    lifecycle: { status, freshness: "valid" },
    approval:
      status === "approved"
        ? { status, decisionId: "seed", actorId: human.id, at: now }
        : { status: "pending" },
    dependencies,
    content: content as ArtifactSnapshot["content"],
  };
  return status === "approved"
    ? { ...bare, meta: { ...bare.meta, contentDigest: artifactDigest(bare) } }
    : bare;
}
function approved(
  candidate: ArtifactSnapshot,
  decisionId: string,
  status: "approved" | "rejected" = "approved",
): ArtifactSnapshot {
  const meta = { ...candidate.meta };
  delete meta.contentDigest;
  const output: ArtifactSnapshot = {
    ...candidate,
    meta: {
      ...meta,
      revision: candidate.meta.revision + 1,
      supersedesRevision: candidate.meta.revision,
    },
    lifecycle: { status, freshness: "valid" },
    approval: { status, decisionId, actorId: human.id, at: now },
  };
  return {
    ...output,
    meta: { ...output.meta, contentDigest: artifactDigest(output) },
  };
}
const content = (
  kind: string,
  name: string,
  definition: Record<string, unknown>,
) => ({
  summary: name,
  assetKind: kind,
  name,
  definition,
  usageRules: ["Use in task"],
  antiUsageRules: ["Do not misuse"],
});
const pathDensity = "/content/definition/density";
const route = (
  id: string,
  type: string,
  required: readonly InputNeed[] = [],
): RoutedTask => ({
  id,
  skillId: `skill.${id}`,
  outputType: type,
  scopeOwnerId: "product_mimic",
  inputs: { required, optional: [], alternatives: [] },
  intent: "create",
  authority: "AUTONOMOUS",
});

async function setup(runtimeScopes: readonly ScopeNode[] = scopes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-orchestrator-"));
  roots.push(root);
  let failBeforeRename = false;
  const workspace = new FileWorkspaceStorage(
    path.join(root, "workspace.json"),
    (phase) => {
      if (failBeforeRename && phase === "before-rename")
        throw new Error("injected publication failure");
    },
  );
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const template = JSON.parse(
    await readFile(
      path.join(
        repository,
        "fixtures/artifacts/valid/design-system-asset.json",
      ),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  let authorityOpen = true;
  const authority: RegistryAuthority = {
    async verify(record, proposal) {
      return (
        authorityOpen &&
        record.actor.id === human.id &&
        record.output?.ref.artifactId === proposal.ref.artifactId
      );
    },
    async allowCommit() {
      return authorityOpen;
    },
  };
  const seedAuthority = {
    async verifyApproval(approval: ArtifactSnapshot["approval"]) {
      return approval.decisionId === "seed" && approval.actorId === human.id;
    },
    async verifyDecision(id: string) {
      return id === "seed";
    },
  };
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    runtimeScopes,
    authority,
    seedAuthority,
  );
  const seed = async (artifact: ArtifactSnapshot) => {
    await runtime.artifacts.create(artifact);
    return reference(artifact);
  };
  return {
    ...runtime,
    workspace,
    template,
    seed,
    closeAuthority: () => {
      authorityOpen = false;
    },
    failPublication: (value: boolean) => {
      failBeforeRename = value;
    },
  };
}

async function stagePacket(
  x: Awaited<ReturnType<typeof setup>>,
  runId: string,
  packetId: string,
  candidates: readonly ArtifactSnapshot[],
) {
  await x.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: agent,
    at: now,
    tasks: [route("review", "design-system-asset")],
  });
  for (const candidate of candidates) {
    await x.artifacts.create(candidate);
    await x.registry.produce({
      runId,
      ref: reference(candidate),
      inputs: [],
      actor: agent,
      at: now,
      reason: "Stage human review",
    });
  }
  await x.registry.submit({
    runId,
    packetId,
    proposals: candidates.map((candidate, index) => ({
      id: `${packetId}_proposal_${index}`,
      ref: reference(candidate),
      alternatives: ["approve", "reject"],
      rationale: "Review exact candidate",
      evidenceLimits: [],
      dependents: [],
    })),
    actor: agent,
    at: now,
    reason: "Named human commit point",
  });
  const approvals = [];
  for (const [index, candidate] of candidates.entries()) {
    const proposalId = `${packetId}_proposal_${index}`;
    const decisionId = `${packetId}_decision_${index}`;
    const output = approved(candidate, decisionId);
    await x.registry.decide({
      id: decisionId,
      packetId,
      proposalId,
      outcome: "approved",
      actor: human,
      at: now,
      rationale: "Approve exact candidate",
      output: { ref: reference(output), artifact: output },
    });
    approvals.push({ proposalId, decisionId });
  }
  return approvals;
}

describe("orchestrator over shared workspace", () => {
  test("routes independent work while a required contract is blocked and batches named review", async () => {
    const x = await setup();
    const tasks = [
      route("profile", "problem-profile", [
        {
          kind: "artifact",
          name: "contract",
          artifactType: "product-ui-contract",
        },
      ]),
      route("capability", "system-capability"),
    ];
    await x.orchestrator.start({
      id: "run_route",
      scopeOwnerId: "product_mimic",
      entryMode: "system-first",
      actor: agent,
      at: now,
      tasks,
    });
    const next = await x.orchestrator.next("run_route", tasks);
    expect(next.state).toBe("active");
    expect(next.actions.map(({ taskId, action }) => [taskId, action])).toEqual([
      ["capability", "GENERATE"],
      ["profile", "BLOCK"],
    ]);
    expect(next.blockers.profile).toMatch(/product-ui-contract/);
    const pending = await x.orchestrator.next("run_route", [
      {
        ...route("capability", "system-capability"),
        uncertainties: [
          {
            kind: "hypothesis",
            reason: "Likely supported",
            affectedTaskIds: ["capability"],
          },
        ],
      },
    ]);
    expect(pending.actions[0].invocation?.assumptions).toContain(
      "hypothesis: Likely supported",
    );
  });

  test("a produced prerequisite unblocks dependent work and completes its own route", async () => {
    const x = await setup();
    const contract: RoutedTask = {
      ...route("contract", "product-ui-contract"),
      targetArtifactId: "art_dynamic_contract",
    };
    const profile: RoutedTask = {
      ...route("profile", "problem-profile", [
        {
          kind: "artifact",
          name: "contract",
          artifactType: "product-ui-contract",
        },
      ]),
      dependsOn: ["contract"],
    };
    const tasks = [contract, profile];
    await x.orchestrator.start({
      id: "run_dynamic",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks,
    });
    const before = await x.orchestrator.next("run_dynamic", tasks);
    expect(
      before.actions.find((item) => item.taskId === "profile")?.blockKind,
    ).toBe("transient");
    expect(
      (await x.registry.run("run_dynamic")).run.blockers.profile,
    ).toBeUndefined();
    const fixture = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/proposed-product-ui-contract.json",
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const output: ArtifactSnapshot = {
      ...fixture,
      meta: { ...fixture.meta, id: "art_dynamic_contract" },
      lifecycle: { status: "provisional", freshness: "valid" },
      origin: {
        actorKind: "skill",
        actorId: contract.skillId,
        runId: "run_dynamic",
        createdAt: now,
      },
    };
    await x.artifacts.create(output);
    const invocation = before.actions.find(
      (item) => item.taskId === "contract",
    )!.invocation!;
    await x.orchestrator.accept(
      invocation,
      {
        runId: "run_dynamic",
        taskId: "contract",
        skillId: contract.skillId,
        inputRefs: [],
        outputRefs: [reference(output)],
      },
      { kind: "skill", id: contract.skillId },
      now,
    );
    const after = await x.orchestrator.next("run_dynamic", tasks);
    expect(
      after.actions.find((item) => item.taskId === "contract")?.action,
    ).toBe("IGNORE");
    const downstream = after.actions.find((item) => item.taskId === "profile")!;
    expect(downstream.action).toBe("GENERATE");
    expect(downstream.invocation?.inputBindings).toEqual([
      { name: "contract", refs: [reference(output)] },
    ]);
    expect(downstream.invocation?.assumptions).toContain(
      `Provisional input ${output.meta.id}@1 is not approved canonical state`,
    );
  });

  test("a blocked upstream is not mistaken for successful completion", async () => {
    const x = await setup();
    const upstream: RoutedTask = {
      ...route("upstream", "system-capability"),
      uncertainties: [
        {
          kind: "blocking-unknown",
          reason: "Required API contract is unknown",
          affectedTaskIds: ["upstream"],
        },
      ],
    };
    const downstream: RoutedTask = {
      ...route("downstream", "product-ui-contract"),
      dependsOn: ["upstream"],
    };
    const tasks = [upstream, downstream];
    await x.orchestrator.start({
      id: "run_blocked_upstream",
      scopeOwnerId: "product_mimic",
      entryMode: "system-first",
      actor: agent,
      at: now,
      tasks,
    });
    const plan = await x.orchestrator.next("run_blocked_upstream", tasks);
    expect(plan.actions.map(({ taskId, action }) => [taskId, action])).toEqual([
      ["upstream", "BLOCK"],
      ["downstream", "BLOCK"],
    ]);
    expect(plan.state).toBe("blocked");
    expect(plan.blockers.downstream).toMatch(/upstream/);
  });

  test("a Skill blocker also blocks its sole consumer and the dynamic Run view", async () => {
    const x = await setup();
    const upstream = route("producer", "product-ui-contract");
    const downstream: RoutedTask = {
      ...route("consumer", "problem-profile", [
        {
          kind: "artifact",
          name: "contract",
          artifactType: "product-ui-contract",
        },
      ]),
      dependsOn: ["producer"],
    };
    const tasks = [upstream, downstream];
    await x.orchestrator.start({
      id: "run_skill_block",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks,
    });
    const invocation = (
      await x.orchestrator.next("run_skill_block", tasks)
    ).actions.find((action) => action.taskId === "producer")!.invocation!;
    await x.orchestrator.accept(
      invocation,
      {
        runId: invocation.runId,
        taskId: invocation.taskId,
        skillId: invocation.skillId,
        inputRefs: [],
        outputRefs: [],
        blocked: {
          reason: "Real prerequisite absent",
          affectedTaskIds: ["producer"],
        },
      },
      { kind: "skill", id: upstream.skillId },
      now,
    );
    const plan = await x.orchestrator.next("run_skill_block", tasks);
    expect(plan.actions.map(({ taskId, action }) => [taskId, action])).toEqual([
      ["producer", "BLOCK"],
      ["consumer", "BLOCK"],
    ]);
    expect(plan.state).toBe("blocked");
    expect(plan.blockers.producer).toBe("Real prerequisite absent");
    expect(plan.blockers.consumer).toMatch(/upstream/);
  });

  test("rejected proposed directions are excluded from later Skill context", async () => {
    const x = await setup();
    const direction: RoutedTask = {
      ...route("direction", "design-direction"),
      authority: "PROPOSE_ONLY",
      targetArtifactId: "art_rejected_direction",
    };
    const critique: RoutedTask = {
      ...route("critique", "evaluation", [
        {
          kind: "artifact",
          name: "direction",
          artifactType: "design-direction",
        },
      ]),
      dependsOn: ["direction"],
    };
    const tasks = [direction, critique];
    await x.orchestrator.start({
      id: "run_rejected_route",
      scopeOwnerId: "product_mimic",
      entryMode: "experience-first",
      actor: agent,
      at: now,
      tasks,
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/approved-design-direction.json",
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const meta = { ...fixture.meta, id: "art_rejected_direction" };
    delete meta.contentDigest;
    const candidate: ArtifactSnapshot = {
      ...fixture,
      meta,
      lifecycle: { status: "proposed", freshness: "valid" },
      approval: { status: "pending" },
      origin: {
        actorKind: "skill",
        actorId: direction.skillId,
        runId: "run_rejected_route",
        createdAt: now,
      },
      provenance: [
        {
          path: "/content",
          kind: "assumption",
          rationale: "Candidate direction",
        },
      ],
      content: {
        ...(fixture.content as Record<string, unknown>),
        selectionStatus: "candidate",
      } as ArtifactSnapshot["content"],
    };
    await x.artifacts.create(candidate);
    const invocation = (
      await x.orchestrator.next("run_rejected_route", tasks)
    ).actions.find((item) => item.taskId === "direction")!.invocation!;
    await x.orchestrator.accept(
      invocation,
      {
        runId: "run_rejected_route",
        taskId: "direction",
        skillId: direction.skillId,
        inputRefs: [],
        outputRefs: [reference(candidate)],
        proposal: {
          packetId: "packet_direction",
          items: [
            {
              id: "proposal_direction",
              ref: reference(candidate),
              alternatives: ["use", "reject"],
              rationale: "Choose direction",
              evidenceLimits: [],
              dependents: [],
            },
          ],
          reason: "Review direction",
        },
      },
      { kind: "skill", id: direction.skillId },
      now,
    );
    const before = await x.orchestrator.next("run_rejected_route", tasks);
    expect(
      before.actions.find((item) => item.taskId === "critique")?.invocation
        ?.inputRefs,
    ).toEqual([reference(candidate)]);
    expect(
      before.actions.find((item) => item.taskId === "critique")?.invocation
        ?.assumptions,
    ).toContain(
      `Provisional input ${candidate.meta.id}@1 is not approved canonical state`,
    );
    const rejected = approved(
      candidate,
      "decision_rejected_direction",
      "rejected",
    );
    await x.registry.decide({
      id: "decision_rejected_direction",
      packetId: "packet_direction",
      proposalId: "proposal_direction",
      outcome: "rejected",
      actor: human,
      at: now,
      rationale: "Reject direction",
      output: { ref: reference(rejected), artifact: rejected },
    });
    const after = await x.orchestrator.next("run_rejected_route", tasks);
    expect(
      after.actions.find((item) => item.taskId === "critique")?.action,
    ).toBe("BLOCK");
    expect(
      after.actions.find((item) => item.taskId === "critique")?.invocation,
    ).toBeUndefined();
  });

  test("named exact bindings include all requested directions and distinct design-system assets; approved reuse stays unchanged", async () => {
    const x = await setup();
    const directionFixture = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/approved-design-direction.json",
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const direction = (id: string): ArtifactSnapshot => {
      const meta = { ...directionFixture.meta, id };
      delete meta.contentDigest;
      const raw: ArtifactSnapshot = {
        ...directionFixture,
        meta,
        approval: {
          status: "approved",
          decisionId: "seed",
          actorId: human.id,
          at: now,
        },
        provenance: [
          {
            path: "/content/selectionStatus",
            kind: "human-decision",
            decisionId: "seed",
          },
        ],
      };
      return {
        ...raw,
        meta: { ...raw.meta, contentDigest: artifactDigest(raw) },
      };
    };
    const directions = [
      direction("art_direction_a"),
      direction("art_direction_b"),
    ];
    const assets = [
      asset(
        x.template,
        "art_pattern",
        scopes[1],
        content("pattern", "Pattern", { intent: "Compare" }),
      ),
      asset(
        x.template,
        "art_layout",
        scopes[1],
        content("layout", "Layout", { intent: "Grid" }),
      ),
      asset(
        x.template,
        "art_component",
        scopes[1],
        content("component", "Component", { intent: "Button" }),
      ),
      asset(
        x.template,
        "art_rules",
        scopes[1],
        content("governance", "Rules", {
          rules: [
            {
              targetAssetKind: "component",
              path: pathDensity,
              policy: "locked",
              value: "comfortable",
            },
          ],
        }),
      ),
    ];
    const refs = [];
    for (const item of [...directions, ...assets])
      refs.push(await x.seed(item));
    await x.registry.seedCanonical(refs);
    const compare = route("compare", "evaluation", [
      {
        kind: "artifact",
        name: "directions",
        artifactType: "design-direction",
        refs: refs.slice(0, 2),
      },
    ]);
    const ambiguous = route("ambiguous", "evaluation", [
      { kind: "artifact", name: "direction", artifactType: "design-direction" },
    ]);
    const compose = route("compose", "scenario", [
      {
        kind: "artifact",
        name: "pattern",
        artifactType: "design-system-asset",
        refs: [refs[2]],
      },
      {
        kind: "artifact",
        name: "layout",
        artifactType: "design-system-asset",
        refs: [refs[3]],
      },
      {
        kind: "artifact",
        name: "component",
        artifactType: "design-system-asset",
        refs: [refs[4]],
      },
      {
        kind: "artifact",
        name: "governance",
        artifactType: "design-system-asset",
        refs: [refs[5]],
      },
    ]);
    const reuse = route("reuse", "design-system-asset", [
      {
        kind: "artifact",
        name: "pattern",
        artifactType: "design-system-asset",
        refs: [refs[2]],
      },
    ]);
    const tasks = [compare, ambiguous, compose, reuse];
    await x.orchestrator.start({
      id: "run_bindings",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks,
    });
    const plan = await x.orchestrator.next("run_bindings", tasks);
    expect(
      plan.actions.find((item) => item.taskId === "compare")?.invocation
        ?.inputBindings,
    ).toEqual([{ name: "directions", refs: refs.slice(0, 2) }]);
    expect(
      plan.actions.find((item) => item.taskId === "compose")?.invocation
        ?.inputBindings,
    ).toEqual([
      { name: "pattern", refs: [refs[2]] },
      { name: "layout", refs: [refs[3]] },
      { name: "component", refs: [refs[4]] },
      { name: "governance", refs: [refs[5]] },
    ]);
    expect(
      plan.actions.find((item) => item.taskId === "ambiguous")?.action,
    ).toBe("BLOCK");
    const invocation = plan.actions.find(
      (item) => item.taskId === "reuse",
    )!.invocation!;
    const before = await x.registry.snapshot();
    await x.orchestrator.accept(
      invocation,
      {
        runId: "run_bindings",
        taskId: "reuse",
        skillId: reuse.skillId,
        inputRefs: invocation.inputRefs,
        outputRefs: [refs[2]],
      },
      { kind: "skill", id: reuse.skillId },
      now,
    );
    const after = await x.registry.snapshot();
    expect(after.canonical[refs[2].artifactId]).toEqual(
      before.canonical[refs[2].artifactId],
    );
    expect(after.runs.run_bindings.artifacts).toEqual([]);
    expect(
      after.events.filter((event) => event.action === "produce-provisional"),
    ).toEqual([]);
  });

  test("binds all and only the exact outputs of a completed producer task", async () => {
    const x = await setup();
    const source = route("diverge", "design-direction");
    const compare: RoutedTask = {
      ...route("compare", "evaluation", [
        {
          kind: "artifact",
          name: "directions",
          artifactType: "design-direction",
          refsFromTask: source.id,
        },
      ]),
      dependsOn: [source.id],
    };
    const tasks = [source, compare];
    await x.orchestrator.start({
      id: "run_producer_refs",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks,
    });
    expect(
      (await x.orchestrator.next("run_producer_refs", tasks)).actions.find(
        (action) => action.taskId === compare.id,
      )?.action,
    ).toBe("BLOCK");
    const sourceInvocation = (
      await x.orchestrator.next("run_producer_refs", tasks)
    ).actions.find((action) => action.taskId === source.id)!.invocation!;
    const outputs: ArtifactSnapshot[] = [];
    for (const id of ["art_direction_a", "art_direction_b"]) {
      const candidate: ArtifactSnapshot = {
        ...x.template,
        meta: {
          id,
          type: "design-direction",
          schemaVersion: "1.0.0",
          revision: 1,
          title: id,
          createdAt: now,
        },
        scope: scopes[1]!,
        lifecycle: { status: "provisional", freshness: "valid" },
        origin: {
          actorKind: "skill",
          actorId: source.skillId,
          runId: "run_producer_refs",
          createdAt: now,
        },
        approval: { status: "pending" },
        dependencies: [],
        provenance: [
          { path: "/content", kind: "assumption", rationale: "Test candidate" },
        ],
        content: {
          summary: id,
          principles: ["Keep task context"],
          mechanisms: [id],
          selectionStatus: "candidate",
        },
      };
      await x.artifacts.create(candidate);
      outputs.push(candidate);
    }
    const refs = outputs.map(reference);
    await x.orchestrator.accept(
      sourceInvocation,
      {
        runId: "run_producer_refs",
        taskId: source.id,
        skillId: source.skillId,
        inputRefs: [],
        outputRefs: refs,
      },
      { kind: "skill", id: source.skillId },
      now,
    );
    const next = await x.orchestrator.next("run_producer_refs", tasks);
    expect(
      next.actions.find((action) => action.taskId === compare.id)?.invocation
        ?.inputBindings,
    ).toEqual([{ name: "directions", refs }]);
    const completion = (await x.registry.snapshot()).events.find(
      (event) =>
        event.reason ===
        `Skill task ${JSON.stringify(source.id)} completed with verified exact outputs`,
    );
    expect(completion?.outputs).toEqual(refs);
  });

  test("one-of inputs choose only the supplied brief and optional gaps remain explicit", async () => {
    const x = await setup();
    const task: RoutedTask = {
      ...route("definition", "product-definition"),
      humanBrief: "A compact comparison tool",
      inputs: {
        required: [],
        optional: [{ kind: "evidence-file", name: "research" }],
        alternatives: [
          {
            oneOf: [
              {
                kind: "artifact",
                name: "definition",
                artifactType: "product-definition",
              },
              { kind: "human-brief", name: "intent" },
            ],
          },
        ],
      },
    };
    await x.orchestrator.start({
      id: "run_brief",
      scopeOwnerId: "product_mimic",
      entryMode: "experience-first",
      actor: agent,
      at: now,
      tasks: [task],
    });
    const action = (await x.orchestrator.next("run_brief", [task])).actions[0];
    expect(action.action).toBe("GENERATE");
    expect(action.invocation?.inputRefs).toEqual([]);
    expect(action.invocation?.humanBrief).toBe("A compact comparison tool");
    expect(action.gaps).toContain("Optional research unavailable");
  });

  test("copies Skill result before asynchronous validation and refuses direct invocation", async () => {
    const x = await setup();
    const task = route("draft", "design-system-asset");
    await x.orchestrator.start({
      id: "run_copy",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks: [task],
    });
    const invocation = (await x.orchestrator.next("run_copy", [task]))
      .actions[0].invocation!;
    const candidate = asset(
      x.template,
      "art_skill_draft",
      scopes[1],
      content("component", "Standalone", { density: "comfortable" }),
      "proposed",
    );
    const produced: ArtifactSnapshot = {
      ...candidate,
      lifecycle: { status: "provisional", freshness: "valid" },
      origin: {
        actorKind: "skill",
        actorId: task.skillId,
        runId: "run_copy",
        createdAt: now,
      },
    };
    await x.artifacts.create(produced);
    const output = reference(produced);
    const result = {
      runId: "run_copy",
      taskId: task.id,
      skillId: task.skillId,
      inputRefs: [],
      outputRefs: [output],
    };
    await expect(
      x.orchestrator.accept(
        invocation,
        { ...result, directSkillCalls: [] } as never,
        { kind: "skill", id: task.skillId },
        now,
      ),
    ).rejects.toThrow(/direct Skill/i);
    await expect(
      x.orchestrator.accept(
        invocation,
        {
          ...result,
          outputRefs: [],
          blocked: {
            reason: "A missing fact",
            affectedTaskIds: [task.id, "unrelated"],
          },
        },
        { kind: "skill", id: task.skillId },
        now,
      ),
    ).rejects.toThrow(/blocked reason/i);
    await expect(
      x.orchestrator.accept(
        { ...invocation, targetArtifactId: "art_other" },
        result,
        { kind: "skill", id: task.skillId },
        now,
      ),
    ).rejects.toThrow(/Skill output cannot be durable/);
    const read = x.artifacts.read.bind(x.artifacts);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    x.artifacts.read = async (id, revision) => {
      await gate;
      return read(id, revision);
    };
    const accepting = x.orchestrator.accept(
      invocation,
      result,
      { kind: "skill", id: task.skillId },
      now,
    );
    result.outputRefs[0] = {
      ...output,
      lockDigest: `sha256:${"0".repeat(64)}`,
    };
    resume();
    await accepting;
    expect((await x.registry.run("run_copy")).run.artifacts).toEqual([output]);
  });

  test("approved ancestor provenance, inherited locks, freshness and exact refs govern selection", async () => {
    const x = await setup();
    const locked = asset(
      x.template,
      "art_org_governance",
      scopes[0],
      content("governance", "Organization rules", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
    );
    const child = asset(
      x.template,
      "art_product_governance",
      scopes[1],
      content("governance", "Product rules", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "configurable",
            value: "comfortable",
            allowedValues: ["comfortable", "compact"],
          },
        ],
      }),
    );
    await x.seed(locked);
    await x.seed(child);
    await x.registry.seedCanonical([reference(locked), reference(child)]);
    const check = {
      scopeOwnerId: "domain_checkout",
      targetAssetKind: "component",
      targetName: "Button",
      path: pathDensity,
      value: "compact" as const,
      intent: "commit" as const,
      rationale: "Dense comparison",
    };
    const state = await x.registry.snapshot();
    expect(
      (await resolveApprovedPolicy(x.artifacts, state, scopes, check)).allowed,
    ).toBe(false);
    const tampered = structuredClone(state);
    tampered.canonical[locked.meta.id].ref = {
      ...tampered.canonical[locked.meta.id].ref,
      lockDigest: reference(child).lockDigest,
    };
    expect(
      (await resolveApprovedPolicy(x.artifacts, tampered, scopes, check))
        .allowed,
    ).toBe(false);
    const invalidScope = { ...check, scopeOwnerId: "unregistered" };
    expect(
      (await resolveApprovedPolicy(x.artifacts, state, scopes, invalidScope))
        .allowed,
    ).toBe(false);
    delete state.canonical[child.meta.id];
    expect(
      (
        await resolveApprovedPolicy(x.artifacts, state, scopes, {
          ...check,
          value: "comfortable",
        })
      ).allowed,
    ).toBe(true);
    expect(
      (await resolveApprovedPolicy(x.artifacts, state, scopes, check)).allowed,
    ).toBe(false);
    state.freshness[locked.meta.id] = {
      ref: reference(locked),
      status: "stale",
      reason: "changed upstream",
    };
    expect(
      (
        await resolveApprovedPolicy(x.artifacts, state, scopes, {
          ...check,
          value: "comfortable",
        })
      ).allowed,
    ).toBe(false);
  });

  test("governance checks the whole transitive dependency chain", async () => {
    const x = await setup();
    const root = asset(
      x.template,
      "art_policy_root",
      scopes[0],
      content("foundation", "Root", { intent: "Stable" }),
    );
    const rootRef = await x.seed(root);
    const middle = asset(
      x.template,
      "art_policy_middle",
      scopes[0],
      content("foundation", "Middle", { intent: "Derived" }),
      "approved",
      1,
      [
        {
          artifactId: rootRef.artifactId,
          revision: rootRef.revision,
          lockDigest: rootRef.lockDigest,
          onChange: "invalidate",
        },
      ],
    );
    const middleRef = await x.seed(middle);
    const governance = asset(
      x.template,
      "art_policy_chain",
      scopes[0],
      content("governance", "Rule", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
      "approved",
      1,
      [
        {
          artifactId: middleRef.artifactId,
          revision: middleRef.revision,
          lockDigest: middleRef.lockDigest,
          onChange: "invalidate",
        },
      ],
    );
    const governanceRef = await x.seed(governance);
    await x.registry.seedCanonical([rootRef, middleRef, governanceRef]);
    const state = await x.registry.snapshot();
    const check = {
      scopeOwnerId: "product_mimic",
      targetAssetKind: "component",
      targetName: "Button",
      path: pathDensity,
      value: "comfortable" as const,
      intent: "commit" as const,
    };
    expect(
      (await resolveApprovedPolicy(x.artifacts, state, scopes, check)).allowed,
    ).toBe(true);
    state.freshness[rootRef.artifactId] = {
      ref: rootRef,
      status: "blocked",
      reason: "Upstream invalidated",
    };
    expect(
      (await resolveApprovedPolicy(x.artifacts, state, scopes, check)).allowed,
    ).toBe(false);
  });

  test("publication rechecks approved policy, refuses forged labels and permits exact allowed choice", async () => {
    const x = await setup();
    const governance = asset(
      x.template,
      "art_governance",
      scopes[0],
      content("governance", "Organization rules", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "configurable",
            value: "comfortable",
            allowedValues: ["comfortable", "compact"],
          },
        ],
      }),
    );
    const governanceRef = await x.seed(governance);
    await x.registry.seedCanonical([governanceRef]);
    const buttonTask: RoutedTask = {
      ...route("button", "design-system-asset"),
      targetArtifactId: "art_button",
    };
    const independentTask = route("critique", "evaluation");
    await x.orchestrator.start({
      id: "run_policy",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks: [buttonTask, independentTask],
    });
    const dependency = [
      {
        artifactId: governanceRef.artifactId,
        revision: governanceRef.revision,
        lockDigest: governanceRef.lockDigest,
        onChange: "invalidate",
      },
    ];
    const candidate = asset(
      x.template,
      "art_button",
      scopes[1],
      content("component", "Button", {
        density: "compact",
        propertySelections: [{ path: pathDensity, rationale: "Dense task" }],
      }),
      "proposed",
      1,
      dependency,
    );
    await x.artifacts.create(candidate);
    const candidateRef = reference(candidate);
    await x.registry.produce({
      runId: "run_policy",
      ref: candidateRef,
      inputs: [governanceRef],
      actor: agent,
      at: now,
      reason: "Propose bounded component",
    });
    await x.registry.submit({
      runId: "run_policy",
      packetId: "packet_button",
      proposals: [
        {
          id: "proposal_button",
          ref: candidateRef,
          alternatives: ["compact", "comfortable"],
          rationale: "Compare density",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at: now,
      reason: "Named button review",
    });
    const pending = await x.orchestrator.next("run_policy", [
      buttonTask,
      independentTask,
    ]);
    expect(pending.commitPoints).toEqual([
      { packetId: "packet_button", proposalIds: ["proposal_button"] },
    ]);
    expect(
      pending.actions.find((item) => item.taskId === "button")?.action,
    ).toBe("REQUEST_DECISION");
    expect(
      pending.actions.find((item) => item.taskId === "critique")?.action,
    ).toBe("GENERATE");
    const output = approved(candidate, "decision_button");
    const decision: DecisionRecord = {
      id: "decision_button",
      packetId: "packet_button",
      proposalId: "proposal_button",
      outcome: "approved",
      actor: human,
      at: now,
      rationale: "Approve compact button",
      output: { ref: reference(output), artifact: output },
    };
    await x.registry.decide(decision);
    const commit = {
      id: "commit_button",
      packetId: "packet_button",
      approvals: [{ proposalId: "proposal_button", decisionId: decision.id }],
      actor: human,
      at: now,
      reason: "Approve bounded choice",
    };
    x.failPublication(true);
    await expect(x.registry.commit(commit)).rejects.toThrow(
      /injected publication failure/,
    );
    expect(
      (await x.registry.snapshot()).canonical[candidate.meta.id],
    ).toBeUndefined();
    expect(
      await x.workspace.snapshots.read(candidate.meta.id, 2),
    ).toBeUndefined();
    x.failPublication(false);
    await x.registry.commit(commit);
    expect(
      (await x.artifacts.read(output.meta.id, output.meta.revision)).artifact
        .approval.decisionId,
    ).toBe(decision.id);
    await expect(x.registry.commit(commit)).resolves.toBeUndefined();
    expect((await x.registry.snapshot()).commits.commit_button.outputs).toEqual(
      [reference(output)],
    );
    const bad = asset(
      x.template,
      "art_bad_button",
      scopes[1],
      content("component", "Button", {
        density: "expanded",
        propertySelections: [
          {
            path: pathDensity,
            rationale: "A forged rule label",
            approvalDecisionId: "decision_bad",
          },
        ],
      }),
      "proposed",
      1,
      dependency,
    );
    await x.artifacts.create(bad);
    await x.registry.produce({
      runId: "run_policy",
      ref: reference(bad),
      inputs: [governanceRef],
      actor: agent,
      at: now,
      reason: "Try invalid density",
    });
    await x.registry.submit({
      runId: "run_policy",
      packetId: "packet_bad",
      proposals: [
        {
          id: "proposal_bad",
          ref: reference(bad),
          alternatives: ["expanded", "retain"],
          rationale: "Human review",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at: now,
      reason: "Review invalid choice",
    });
    const badOutput = approved(bad, "decision_bad");
    await x.registry.decide({
      id: "decision_bad",
      packetId: "packet_bad",
      proposalId: "proposal_bad",
      outcome: "approved",
      actor: human,
      at: now,
      rationale: "Try override",
      output: { ref: reference(badOutput), artifact: badOutput },
    });
    await expect(
      x.registry.commit({
        id: "commit_bad",
        packetId: "packet_bad",
        approvals: [{ proposalId: "proposal_bad", decisionId: "decision_bad" }],
        actor: human,
        at: now,
        reason: "Cannot exceed approved boundary",
      }),
    ).rejects.toThrow(/policy|authority/i);
    expect(
      (await x.registry.snapshot()).canonical[bad.meta.id],
    ).toBeUndefined();
    expect(await x.workspace.snapshots.read(bad.meta.id, 2)).toBeUndefined();
    const rejectedCandidate = asset(
      x.template,
      "art_rejected_button",
      scopes[1],
      content("component", "Other", { density: "comfortable" }),
      "proposed",
      1,
      dependency,
    );
    await x.artifacts.create(rejectedCandidate);
    await x.registry.produce({
      runId: "run_policy",
      ref: reference(rejectedCandidate),
      inputs: [governanceRef],
      actor: agent,
      at: now,
      reason: "Separate reversible candidate",
    });
    await x.registry.submit({
      runId: "run_policy",
      packetId: "packet_reject",
      proposals: [
        {
          id: "proposal_reject",
          ref: reference(rejectedCandidate),
          alternatives: ["use", "reject"],
          rationale: "Separate human choice",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at: now,
      reason: "Separate review",
    });
    const rejectedOutput = approved(
      rejectedCandidate,
      "decision_reject",
      "rejected",
    );
    await x.registry.decide({
      id: "decision_reject",
      packetId: "packet_reject",
      proposalId: "proposal_reject",
      outcome: "rejected",
      actor: human,
      at: now,
      rationale: "Reject this choice",
      output: { ref: reference(rejectedOutput), artifact: rejectedOutput },
    });
    expect(
      (await x.registry.snapshot()).canonical[rejectedCandidate.meta.id],
    ).toBeUndefined();
    expect(
      (await x.artifacts.read(rejectedOutput.meta.id, 2)).artifact.lifecycle
        .status,
    ).toBe("rejected");
    expect(
      (await x.registry.run("run_policy")).run.proposals.proposal_reject.status,
    ).toBe("rejected");
    const weakerRule = asset(
      x.template,
      "art_weak_rule",
      scopes[1],
      content("governance", "Weaker product rule", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "configurable",
            value: "comfortable",
            allowedValues: ["comfortable", "expanded"],
          },
        ],
      }),
      "proposed",
      1,
      dependency,
    );
    await x.artifacts.create(weakerRule);
    await x.registry.produce({
      runId: "run_policy",
      ref: reference(weakerRule),
      inputs: [governanceRef],
      actor: agent,
      at: now,
      reason: "Try broader rule",
    });
    await x.registry.submit({
      runId: "run_policy",
      packetId: "packet_weak",
      proposals: [
        {
          id: "proposal_weak",
          ref: reference(weakerRule),
          alternatives: ["broaden", "retain"],
          rationale: "Review rule",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at: now,
      reason: "Review rule",
    });
    const weakOutput = approved(weakerRule, "decision_weak");
    await x.registry.decide({
      id: "decision_weak",
      packetId: "packet_weak",
      proposalId: "proposal_weak",
      outcome: "approved",
      actor: human,
      at: now,
      rationale: "Attempt broader rule",
      output: { ref: reference(weakOutput), artifact: weakOutput },
    });
    await expect(
      x.registry.commit({
        id: "commit_weak",
        packetId: "packet_weak",
        approvals: [
          { proposalId: "proposal_weak", decisionId: "decision_weak" },
        ],
        actor: human,
        at: now,
        reason: "Try broader rule",
      }),
    ).rejects.toThrow(/policy|authority/i);
    expect(
      await x.workspace.snapshots.read(weakerRule.meta.id, 2),
    ).toBeUndefined();
  });

  test("a child governance revision keeps its ancestor while excluding its own prior revision", async () => {
    const x = await setup();
    const parent = asset(
      x.template,
      "art_parent_rule",
      scopes[0],
      content("governance", "Parent", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "configurable",
            value: "comfortable",
            allowedValues: ["comfortable", "compact"],
          },
        ],
      }),
    );
    const child = asset(
      x.template,
      "art_child_rule",
      scopes[1],
      content("governance", "Child", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "configurable",
            value: "comfortable",
            allowedValues: ["comfortable", "compact"],
          },
        ],
      }),
    );
    await x.seed(parent);
    await x.seed(child);
    await x.registry.seedCanonical([reference(parent), reference(child)]);
    const revised = asset(
      x.template,
      child.meta.id,
      scopes[1],
      content("governance", "Child", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
      "proposed",
      2,
      [{ ...reference(parent), onChange: "invalidate" }],
    );
    await x.orchestrator.start({
      id: "run_child",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks: [route("review", "design-system-asset")],
    });
    await x.artifacts.create(revised);
    await x.registry.produce({
      runId: "run_child",
      ref: reference(revised),
      inputs: [reference(parent)],
      actor: agent,
      at: now,
      reason: "Narrow child rule",
    });
    await x.registry.submit({
      runId: "run_child",
      packetId: "packet_child",
      proposals: [
        {
          id: "proposal_child",
          ref: reference(revised),
          expectedCanonical: reference(child),
          alternatives: ["narrow", "retain"],
          rationale: "Narrow rule",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at: now,
      reason: "Review child rule",
    });
    const output = approved(revised, "decision_child");
    await x.registry.decide({
      id: "decision_child",
      packetId: "packet_child",
      proposalId: "proposal_child",
      outcome: "approved",
      actor: human,
      at: now,
      rationale: "Approve narrower rule",
      output: { ref: reference(output), artifact: output },
    });
    await x.registry.commit({
      id: "commit_child",
      packetId: "packet_child",
      approvals: [
        { proposalId: "proposal_child", decisionId: "decision_child" },
      ],
      actor: human,
      at: now,
      reason: "Commit narrower child rule",
    });
    expect((await x.registry.snapshot()).canonical[child.meta.id].ref).toEqual(
      reference(output),
    );
  });

  test("a partial commit ignores an unrelated approved governance proposal", async () => {
    const x = await setup();
    const rule = asset(
      x.template,
      "art_unrelated_rule",
      scopes[0],
      content("governance", "Unrelated rule", {
        rules: [
          {
            targetAssetKind: "component",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
      "proposed",
    );
    const foundation = asset(
      x.template,
      "art_independent_foundation",
      scopes[1],
      content("foundation", "Foundation", { intent: "Useful" }),
      "proposed",
    );
    const approvals = await stagePacket(x, "run_partial", "packet_partial", [
      rule,
      foundation,
    ]);
    await x.registry.commit({
      id: "commit_partial",
      packetId: "packet_partial",
      approvals: [approvals[1]],
      actor: human,
      at: now,
      reason: "Commit only independent foundation",
    });
    const state = await x.registry.snapshot();
    expect(state.canonical[foundation.meta.id]).toBeDefined();
    expect(state.canonical[rule.meta.id]).toBeUndefined();
    expect(
      state.runs.run_partial.proposals[approvals[0].proposalId].status,
    ).toBe("pending");
  });

  test("one named commit cannot publish conflicting new governance rules", async () => {
    const x = await setup();
    const makeRule = (id: string, value: string) =>
      asset(
        x.template,
        id,
        scopes[0],
        content("governance", id, {
          rules: [
            {
              targetAssetKind: "component",
              targetName: "Button",
              path: pathDensity,
              policy: "locked",
              value,
            },
          ],
        }),
        "proposed",
      );
    const candidates = [
      makeRule("art_conflict_a", "comfortable"),
      makeRule("art_conflict_b", "compact"),
    ];
    const approvals = await stagePacket(
      x,
      "run_conflict",
      "packet_conflict",
      candidates,
    );
    await expect(
      x.registry.commit({
        id: "commit_conflict",
        packetId: "packet_conflict",
        approvals,
        actor: human,
        at: now,
        reason: "Try contradictory org rules",
      }),
    ).rejects.toThrow(/policy|authority/i);
    const state = await x.registry.snapshot();
    for (const candidate of candidates) {
      expect(state.canonical[candidate.meta.id]).toBeUndefined();
      expect(
        await x.workspace.snapshots.read(candidate.meta.id, 2),
      ).toBeUndefined();
    }
  });

  test("one named commit cannot bypass a new rule by omitting the governed property", async () => {
    const x = await setup();
    const rule = asset(
      x.template,
      "art_new_density_rule",
      scopes[0],
      content("governance", "Density rule", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
      "proposed",
    );
    const button = asset(
      x.template,
      "art_button_without_density",
      scopes[1],
      content("component", "Button", { intent: "Visible button" }),
      "proposed",
    );
    const approvals = await stagePacket(
      x,
      "run_missing_density",
      "packet_missing_density",
      [rule, button],
    );
    await expect(
      x.registry.commit({
        id: "commit_missing_density",
        packetId: "packet_missing_density",
        approvals,
        actor: human,
        at: now,
        reason: "Try incomplete same-set policy",
      }),
    ).rejects.toThrow(/policy|authority/i);
    const state = await x.registry.snapshot();
    expect(state.canonical[rule.meta.id]).toBeUndefined();
    expect(state.canonical[button.meta.id]).toBeUndefined();
  });

  test("one named commit cannot publish matching parent and child rules without exact source lock", async () => {
    const x = await setup();
    const rule = (id: string, scope: ScopeNode) =>
      asset(
        x.template,
        id,
        scope,
        content("governance", id, {
          rules: [
            {
              targetAssetKind: "component",
              targetName: "Button",
              path: pathDensity,
              policy: "locked",
              value: "comfortable",
            },
          ],
        }),
        "proposed",
      );
    const parent = rule("art_new_parent_density", scopes[0]);
    const child = rule("art_new_child_density", scopes[1]);
    const approvals = await stagePacket(
      x,
      "run_new_rule_pair",
      "packet_new_rule_pair",
      [parent, child],
    );
    await expect(
      x.registry.commit({
        id: "commit_new_rule_pair",
        packetId: "packet_new_rule_pair",
        approvals,
        actor: human,
        at: now,
        reason: "Try child rule without approved parent lock",
      }),
    ).rejects.toThrow(/policy|authority/i);
    const state = await x.registry.snapshot();
    expect(state.canonical[parent.meta.id]).toBeUndefined();
    expect(state.canonical[child.meta.id]).toBeUndefined();
  });

  test("scope ancestry is copied before caller mutation", async () => {
    const mutable = structuredClone(scopes) as {
      level: ScopeNode["level"];
      ownerId: string;
      parentId?: string;
    }[];
    const x = await setup(mutable);
    const rule = asset(
      x.template,
      "art_scope_rule",
      scopes[0],
      content("governance", "Org rule", {
        rules: [
          {
            targetAssetKind: "component",
            targetName: "Button",
            path: pathDensity,
            policy: "locked",
            value: "comfortable",
          },
        ],
      }),
    );
    await x.seed(rule);
    await x.registry.seedCanonical([reference(rule)]);
    mutable[1].parentId = "missing";
    mutable[2].parentId = "missing";
    await x.orchestrator.start({
      id: "run_scope_copy",
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: agent,
      at: now,
      tasks: [],
    });
    expect(
      (
        await x.orchestrator.policy("run_scope_copy", {
          scopeOwnerId: "product_mimic",
          targetAssetKind: "component",
          targetName: "Button",
          path: pathDensity,
          value: "comfortable",
          intent: "commit",
        })
      ).allowed,
    ).toBe(true);
  });
});
