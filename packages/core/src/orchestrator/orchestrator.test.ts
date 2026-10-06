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

async function setup() {
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
    scopes,
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

describe("orchestrator over shared workspace", () => {
  test("routes independent work while a required contract is blocked and batches named review", async () => {
    const x = await setup();
    const tasks = [
      route("profile", "problem-profile", [
        { kind: "artifact", artifactType: "product-ui-contract" },
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

  test("one-of inputs choose only the supplied brief and optional gaps remain explicit", async () => {
    const x = await setup();
    const task: RoutedTask = {
      ...route("definition", "product-definition"),
      humanBrief: "A compact comparison tool",
      inputs: {
        required: [],
        optional: [{ kind: "evidence-file" }],
        alternatives: [
          {
            oneOf: [
              { kind: "artifact", artifactType: "product-definition" },
              { kind: "human-brief" },
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
    expect(action.gaps).toContain("Optional evidence-file unavailable");
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
    await expect(
      x.orchestrator.accept(
        invocation,
        { ...result, directSkillCalls: [] } as never,
        { kind: "skill", id: task.skillId },
        now,
      ),
    ).rejects.toThrow(/direct Skill/i);
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
});
