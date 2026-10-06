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
import {
  evaluatePropertyPolicy,
  guardArtifactRevision,
} from "../runtime-engines/policy.js";
import { resolveApprovedPolicy } from "../orchestrator/policy.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { loadSkillPackage, runSkillPackage } from "../skill-runtime/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemaRoot = path.join(repository, "schemas");
const at = "2026-10-06T12:00:00Z";
const names = [
  "s12-design-system-resolver",
  "s13-visual-system-builder",
  "s14-ui-composition-planner",
  "s15-responsive-architect",
] as const;
type Name = (typeof names)[number];
type Case = { id: string; expected: string; [key: string]: unknown };
const expectedFields: Record<Name, Record<string, string[]>> = {
  "s12-design-system-resolver": {
    "reuse-fit": ["choice", "need", "expected"],
    "configure-boundary": [
      "choice",
      "property",
      "allowed",
      "value",
      "expected",
    ],
    "extend-gap": ["choice", "need", "expected"],
    "create-only-gap": ["choice", "need", "expected"],
    "locked-conflict": ["policy", "original", "attempt", "expected"],
    "configure-outside-boundary": ["allowed", "attempt", "expected"],
    "override-review": ["policy", "attempt", "expected"],
    "unverified-license": ["assetKind", "license", "expected"],
    "bad-lock": ["expected", "message"],
    "rejection-repeat": ["rejectedRevision", "newRevision", "expected"],
  },
  "s13-visual-system-builder": {
    "brand-structure": ["brand", "direction", "expected"],
    "token-source": ["token", "expected"],
    "semantic-separation": ["meaning", "glyph", "expected"],
    "license-unverified": ["state", "expected"],
    "license-fixture-review": ["fixture", "expected"],
    "wrong-icon-reference": ["wrongArtifactId", "expected"],
    "locked-conflict": ["property", "expected"],
    "wrong-lock": ["expected", "message"],
    "rejection-repeat": ["rejectedRevision", "newRevision", "expected"],
  },
  "s14-ui-composition-planner": {
    "task-pattern-layout-component": ["order", "expected"],
    "existing-variant": ["variant", "expected"],
    "pattern-antiusage": ["constraint", "expected"],
    "missing-asset-lock": ["expected", "outputCount"],
    "proposed-capability": ["availability", "expected"],
    "wrong-lock": ["expected", "message"],
    "rejection-repeat": ["rejectedRevision", "newRevision", "expected"],
  },
  "s15-responsive-architect": {
    "action-set": ["actions", "expected"],
    "primary-goal-parity": ["goal", "expected"],
    "hide-primary": ["target", "expected"],
    "missing-viewport-evidence": ["status", "expected"],
    "wrong-lock": ["expected", "message"],
    "rejection-repeat": ["rejectedRevision", "newRevision", "expected"],
  },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const ref = (a: ArtifactSnapshot) => ({
  artifactId: a.meta.id,
  revision: a.meta.revision,
  lockDigest: artifactDigest(a),
});
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
async function setup(name: Name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-composition-"));
  roots.push(root);
  const schemas = await loadSchemaDirectory(path.join(schemaRoot, "artifacts"));
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
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
  const skill = await loadSkillPackage(
    path.join(repository, "skills", name),
    schemaRoot,
  );
  const data = JSON.parse(skill.examples["examples/output.json"]!) as Record<
    string,
    unknown
  >;
  const scenarios = (
    JSON.parse(skill.tests["tests/scenarios.json"]!) as { scenarios: Case[] }
  ).scenarios;
  expect(scenarios.map((c) => c.id).sort()).toEqual(
    Object.keys(expectedFields[name]).sort(),
  );
  expect(new Set(scenarios.map((c) => c.id)).size).toBe(scenarios.length);
  for (const c of scenarios)
    expect(Object.keys(c).sort()).toEqual(
      ["id", ...expectedFields[name][c.id]!].sort(),
    );
  return { ...runtime, schemas, skill, data, scenarios };
}
function outputArtifacts(
  name: Name,
  data: Record<string, unknown>,
): ArtifactSnapshot[] {
  if (name === "s13-visual-system-builder")
    return data.assets as ArtifactSnapshot[];
  if (name === "s15-responsive-architect")
    return [data.rule, data.scenario] as ArtifactSnapshot[];
  return [data.candidate ?? data.scenario] as ArtifactSnapshot[];
}
const get = (cases: Case[], id: string) => cases.find((c) => c.id === id)!;

test.each(names)(
  "%s loads and validates every example artifact",
  async (name) => {
    const x = await setup(name);
    expect(x.skill.instructions.length).toBeGreaterThan(100);
    for (const a of outputArtifacts(name, x.data)) {
      expect(x.schemas.validate(a).valid).toBe(true);
      expect(x.skill.manifest.outputs).toContain(a.meta.type);
      expect(a.approval.status).toBe("pending");
      expect(a.lifecycle.status).toBe("proposed");
    }
  },
);

test("S12 consumes all resolution and refusal cases", async () => {
  const x = await setup(names[0]);
  const decisions = x.data.resolutions as {
    need: string;
    choice: string;
    asset: string;
    reason: string;
    property?: string;
    value?: string;
  }[];
  expect(decisions.map((d) => d.choice)).toEqual([
    "REUSE",
    "CONFIGURE",
    "EXTEND",
    "CREATE",
  ]);
  for (const id of [
    "reuse-fit",
    "configure-boundary",
    "extend-gap",
    "create-only-gap",
  ]) {
    const c = get(x.scenarios, id);
    const d = decisions.find(
      (v) =>
        v.choice === c.choice &&
        (c.choice === "CONFIGURE"
          ? v.property === c.property
          : v.need === c.need),
    )!;
    expect(d.asset).toBeTruthy();
    expect(d.reason).toBeTruthy();
    if (c.choice === "REUSE") expect(c.expected).toBe("unchanged");
    else if (c.choice === "CONFIGURE") {
      expect(d.property).toBe(c.property);
      expect(d.value).toBe(c.value);
      expect(c.allowed).toContain(d.value);
      const parent = ref(outputArtifacts(names[0], x.data)[0]!);
      const decision = await evaluatePropertyPolicy(
        {
          parent,
          path: "/content/definition/density",
          policy: "configurable",
          value: "comfortable",
          allowedValues: c.allowed as string[],
        },
        {
          parent,
          path: "/content/definition/density",
          value: c.value as string,
          rationale: d.reason,
          intent: "propose",
        },
      );
      expect(decision).toMatchObject({ allowed: true, effect: "configure" });
      expect(c.expected).toBe("allowed");
    } else expect(c.expected).toBe("proposed");
  }
  const locked = get(x.scenarios, "locked-conflict");
  const parent = ref(outputArtifacts(names[0], x.data)[0]!);
  expect(
    await evaluatePropertyPolicy(
      {
        parent,
        path: "/content/definition/focus",
        policy: locked.policy as "locked",
        value: locked.original as string,
      },
      {
        parent,
        path: "/content/definition/focus",
        value: locked.attempt as string,
        rationale: "Wanted change",
        intent: "propose",
      },
    ),
  ).toMatchObject({ allowed: false, effect: locked.expected });
  const outside = get(x.scenarios, "configure-outside-boundary");
  const outsideDecision = await evaluatePropertyPolicy(
    {
      parent,
      path: "/content/definition/density",
      policy: "configurable",
      value: "comfortable",
      allowedValues: outside.allowed as string[],
    },
    {
      parent,
      path: "/content/definition/density",
      value: outside.attempt as string,
      rationale: "Task needs density",
      intent: "propose",
    },
  );
  expect(outsideDecision).toMatchObject({
    allowed: false,
    effect: outside.expected,
  });
  const override = get(x.scenarios, "override-review");
  expect(override.policy).toBe("overridable");
  expect(
    await evaluatePropertyPolicy(
      {
        parent,
        path: "/content/definition/columnOrder",
        policy: "overridable",
        value: "candidate-first",
      },
      {
        parent,
        path: "/content/definition/columnOrder",
        value: override.attempt as string,
        rationale: "Preserve comparison task",
        intent: "propose",
      },
    ),
  ).toMatchObject({ allowed: true, effect: "override" });
  expect(
    await evaluatePropertyPolicy(
      {
        parent,
        path: "/content/definition/columnOrder",
        policy: "overridable",
        value: "candidate-first",
      },
      {
        parent,
        path: "/content/definition/columnOrder",
        value: override.attempt as string,
        rationale: "Preserve comparison task",
        intent: "commit",
      },
    ),
  ).toMatchObject({ allowed: false });
  expect(override.expected).toBe("proposal-only");
  const license = get(x.scenarios, "unverified-license");
  expect(license.assetKind).toBe("provider-binding");
  expect(license.license).toBe("unverified");
  expect(license.expected).toBe("blocked");
  expect((x.data.candidate as ArtifactSnapshot).content).toHaveProperty(
    "assetKind",
    "pattern",
  );
});

test("S12 reuses an unchanged approved ancestor only through its exact Run lock and governance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-s12-approved-"));
  roots.push(root);
  const schemas = await loadSchemaDirectory(path.join(schemaRoot, "artifacts"));
  const x = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
    scopes,
    {
      async verify() {
        return false;
      },
      async allowCommit() {
        return false;
      },
      async verifyResolution(blockerId, evidenceRefs) {
        return (
          blockerId === "target" &&
          evidenceRefs.includes("art_approved_comparison") &&
          evidenceRefs.includes("art_approved_governance")
        );
      },
    },
    {
      async verifyApproval(approval) {
        return (
          approval.decisionId === "seed_human" && approval.actorId === "human_1"
        );
      },
      async verifyDecision(id) {
        return id === "seed_human";
      },
    },
  );
  const loaded = await loadSkillPackage(
    path.join(repository, "skills", names[0]),
    schemaRoot,
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
  function approved(
    id: string,
    content: ArtifactSnapshot["content"],
  ): ArtifactSnapshot {
    const bare: ArtifactSnapshot = {
      ...template,
      meta: {
        id,
        type: "design-system-asset",
        schemaVersion: "1.0.0",
        revision: 1,
        title: id,
        createdAt: at,
      },
      scope: { level: "organization", ownerId: "org_9uile" },
      lifecycle: { status: "approved", freshness: "valid" },
      approval: {
        status: "approved",
        decisionId: "seed_human",
        actorId: "human_1",
        at,
      },
      origin: {
        actorKind: "human",
        actorId: "human_1",
        runId: "run_seed",
        createdAt: at,
      },
      dependencies: [],
      provenance: [
        { path: "/content", kind: "human-decision", decisionId: "seed_human" },
      ],
      content,
    };
    return {
      ...bare,
      meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
    };
  }
  const pattern = approved("art_approved_comparison", {
    summary: "Approved comparison pattern",
    assetKind: "pattern",
    name: "Candidate comparison",
    definition: {
      density: "comfortable",
      slots: ["criteria", "uncertainty", "decision"],
    },
    usageRules: ["Use for comparing plans"],
    antiUsageRules: ["Do not rank unverified evidence"],
  });
  const governance = approved("art_approved_governance", {
    summary: "Approved density lock",
    assetKind: "governance",
    name: "Comparison governance",
    definition: {
      rules: [
        {
          targetAssetKind: "pattern",
          targetName: "Candidate comparison",
          path: "/content/definition/density",
          policy: "locked",
          value: "comfortable",
        },
      ],
    },
    usageRules: ["Apply along scope ancestry"],
    antiUsageRules: ["Do not loosen at child scope"],
  });
  await x.artifacts.create(pattern);
  await x.artifacts.create(governance);
  await x.registry.seedCanonical([ref(pattern), ref(governance)]);
  const state = await x.registry.snapshot();
  const check = {
    scopeOwnerId: "product_mimic",
    targetAssetKind: "pattern",
    targetName: "Candidate comparison",
    path: "/content/definition/density",
    value: "comfortable",
    intent: "propose" as const,
  };
  expect(
    (await resolveApprovedPolicy(x.artifacts, state, scopes, check)).allowed,
  ).toBe(true);
  expect(
    (
      await resolveApprovedPolicy(x.artifacts, state, scopes, {
        ...check,
        value: "compact",
      })
    ).allowed,
  ).toBe(false);
  const tampered = structuredClone(state);
  tampered.canonical[governance.meta.id]!.ref = {
    ...tampered.canonical[governance.meta.id]!.ref,
    lockDigest: `sha256:${"0".repeat(64)}`,
  };
  expect(
    (await resolveApprovedPolicy(x.artifacts, tampered, scopes, check)).allowed,
  ).toBe(false);
  const runId = "run_s12_approved_reuse";
  const inputTypes = [
    "design-direction",
    "product-ui-contract",
    "user-task-model",
  ] as const;
  const seedTasks: RoutedTask[] = inputTypes.map((type, i) => ({
    id: `seed_${i}`,
    skillId: "mimic.fixture",
    outputType: type,
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "AUTONOMOUS",
    inputs: { required: [], optional: [], alternatives: [] },
  }));
  const baseTask: RoutedTask = {
    id: "target",
    skillId: loaded.manifest.skillId,
    outputType: loaded.manifest.outputs[0]!,
    additionalOutputTypes: loaded.manifest.outputs.slice(1),
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: {
      required: loaded.manifest.inputs.required.map((input) => ({ ...input })),
      optional: loaded.manifest.inputs.optional.map((input) => ({ ...input })),
      alternatives: [],
    },
  };
  await x.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks: [...seedTasks, baseTask],
  });
  const sources: ArtifactSnapshot[] = [];
  for (const [i, type] of inputTypes.entries()) {
    const filename =
      type === "design-direction"
        ? "approved-design-direction"
        : type === "product-ui-contract"
          ? "proposed-product-ui-contract"
          : type;
    const fixture = JSON.parse(
      await readFile(
        path.join(repository, "fixtures/artifacts/valid", `${filename}.json`),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const source: ArtifactSnapshot = {
      ...fixture,
      meta: {
        id: `art_s12_reuse_input_${i}`,
        type,
        schemaVersion: "1.0.0",
        revision: 1,
        title: type,
        createdAt: at,
      },
      lifecycle: { status: "provisional", freshness: "valid" },
      approval: { status: "pending" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.fixture",
        runId,
        createdAt: at,
      },
      dependencies: [],
      provenance: [
        {
          path: "/content",
          kind: "assumption",
          rationale: "Synthetic task context",
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
    await x.artifacts.create(source);
    await x.registry.produce({
      runId,
      ref: ref(source),
      inputs: [],
      actor: { kind: "skill", id: "mimic.fixture" },
      at,
      reason: "Synthetic task context",
    });
    sources.push(source);
  }
  const task: RoutedTask = {
    ...baseTask,
    inputs: {
      ...baseTask.inputs,
      required: baseTask.inputs.required.map((input) => ({
        ...input,
        refs:
          input.name === "approved-assets"
            ? [ref(pattern), ref(governance)]
            : input.name === "direction"
              ? [ref(sources[0]!)]
              : input.name === "contract"
                ? [ref(sources[1]!)]
                : [ref(sources[2]!)],
      })),
    },
  };
  await x.registry.setWork({
    runId,
    safeActions: ["target"],
    blockers: {},
    actor: { kind: "agent", id: "agent_1" },
    at,
    reason: "Exact approved ancestor and task context ready",
    resolutions: {
      target: { evidenceRefs: [pattern.meta.id, governance.meta.id] },
    },
  });
  const work = await runSkillPackage({
    orchestrator: x.orchestrator,
    package: loaded,
    runId,
    tasks: [...seedTasks, task],
    taskId: "target",
    at,
    executor: async ({ invocation, inputs }) => {
      expect(
        inputs
          .filter((input) => input.name === "approved-assets")
          .map((input) => input.ref),
      ).toEqual([ref(pattern), ref(governance)]);
      return {
        result: {
          runId,
          taskId: "target",
          skillId: loaded.manifest.skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [ref(pattern)],
        },
      };
    },
  });
  expect(work.result.outputRefs).toEqual([ref(pattern)]);
  expect((await x.artifacts.read(pattern.meta.id, 1)).artifact).toEqual(
    pattern,
  );
  expect((await x.registry.run(runId)).run.artifacts).not.toContainEqual(
    ref(governance),
  );
});

test("S13 keeps brand and direction ahead of tokens and separates icon meaning from provider", async () => {
  const x = await setup(names[1]);
  const assets = outputArtifacts(names[1], x.data);
  const derivation = x.data.derivation as Record<string, string>;
  const basis = get(x.scenarios, "brand-structure");
  expect([derivation.brand, derivation.direction]).toEqual([
    basis.brand,
    basis.direction,
  ]);
  expect(basis.expected).toBe("derived");
  const foundation = assets.find(
    (a) => (a.content as { assetKind: string }).assetKind === "foundation",
  )!;
  expect(
    (foundation.content as { definition: Record<string, string> }).definition,
  ).toMatchObject({
    brandBasis: basis.brand,
    structuralBasis: basis.direction,
  });
  const token = get(x.scenarios, "token-source");
  const tokens = assets.find(
    (a) => (a.content as { assetKind: string }).assetKind === "dtcg-tokens",
  )!;
  expect(
    (tokens.content as { definition: { references: string[] } }).definition
      .references,
  ).toContain(token.token);
  expect(token.expected).toBe("source-only");
  const separate = get(x.scenarios, "semantic-separation");
  const semantic = assets.find(
    (a) => (a.content as { assetKind: string }).assetKind === "semantic-icon",
  )!;
  const binding = assets.find(
    (a) =>
      (a.content as { assetKind: string }).assetKind === "provider-binding",
  )!;
  expect(
    (semantic.content as { definition: { meaning: string } }).definition
      .meaning,
  ).toBe(separate.meaning);
  expect(
    (
      binding.content as {
        definition: { glyph: string; semanticIconArtifactId: string };
      }
    ).definition,
  ).toMatchObject({
    glyph: separate.glyph,
    semanticIconArtifactId: semantic.meta.id,
  });
  expect(binding.dependencies).toEqual([
    { ...ref(semantic), onChange: "invalidate" },
  ]);
  expect(separate.expected).toBe("separate");
  expect(
    (binding.content as { providerLicense: string }).providerLicense,
  ).toBeTruthy();
  const license = get(x.scenarios, "license-unverified");
  expect(derivation.licenseState).toBe(license.state);
  expect(license.expected).toBe("blocked-binding");
  const reviewed = get(x.scenarios, "license-fixture-review");
  const reviewFixture = JSON.parse(
    x.skill.examples[reviewed.fixture as string]!,
  ) as {
    reviewedForFixture: boolean;
    provider: string;
    glyph: string;
    licenseTerms: string;
    noticePlan: string;
  };
  expect(reviewFixture).toMatchObject({
    reviewedForFixture: true,
    provider: derivation.provider,
    glyph: separate.glyph,
  });
  expect(reviewFixture.licenseTerms).toBeTruthy();
  expect(reviewFixture.noticePlan).toBeTruthy();
  expect(reviewed.expected).toBe("provisional-binding");
  const locked = get(x.scenarios, "locked-conflict");
  expect(locked.property).toBe(token.token);
  expect(locked.expected).toBe("blocked");
});

test("S14 composes the task first, uses existing variants, and rejects false fit", async () => {
  const x = await setup(names[2]);
  const evidence = x.data.compositionEvidence as Record<string, unknown>;
  const order = get(x.scenarios, "task-pattern-layout-component");
  expect(order.order).toEqual(["task", "pattern", "layout", "components"]);
  for (const key of order.order as string[]) expect(evidence[key]).toBeTruthy();
  expect(evidence.selectedExactAssets).toEqual([
    "pattern",
    "layout",
    "component",
  ]);
  expect(order.expected).toBe("composed");
  const variant = get(x.scenarios, "existing-variant");
  expect(evidence.existingVariant).toBe(variant.variant);
  expect(evidence.components).toContain(variant.variant);
  expect(evidence.newLocalComponent).toBeNull();
  expect(variant.expected).toBe("no-new-component");
  const anti = get(x.scenarios, "pattern-antiusage");
  expect(anti.constraint).toContain("unverified evidence");
  expect(
    (evidence.patternAntiUsage as string[]).join(" ").toLowerCase(),
  ).toContain("unverified evidence");
  expect(anti.expected).toBe("blocked");
  const cap = get(x.scenarios, "proposed-capability");
  expect(cap.availability).toBe("proposed");
  expect(evidence.capability).toBe("provisional-mock-only");
  expect(cap.expected).toBe("mock-only");
  const selected = x.data.selectedAssets as ArtifactSnapshot[];
  expect(
    selected.map((a) => (a.content as { assetKind: string }).assetKind),
  ).toEqual(["pattern", "layout", "component"]);
  expect((x.data.scenario as ArtifactSnapshot).dependencies).toEqual(
    selected.map((a) => ({ ...ref(a), onChange: "validate" })),
  );
  expect(
    (x.data.scenario as ArtifactSnapshot).provenance[0]?.rationale,
  ).toMatch(/Task → .*pattern → .*layout → .*variant/);
  const scenario = x.data.scenario as ArtifactSnapshot;
  expect(
    (scenario.content as { steps: string[] }).steps.length,
  ).toBeGreaterThan(2);
  expect(
    Object.keys(scenario.content as Record<string, unknown>).sort(),
  ).toEqual(["actor", "context", "expectedOutcome", "steps", "summary"].sort());
});

test("S15 covers every transformation with reasons and primary goal parity", async () => {
  const x = await setup(names[3]);
  const rule = x.data.rule as ArtifactSnapshot;
  const mobile = x.data.scenario as ArtifactSnapshot;
  const definition = (
    rule.content as {
      definition: {
        primaryGoal: string;
        actions: { action: string; target: string; reason: string }[];
        parityCheck: Record<string, string>;
      };
    }
  ).definition;
  const actions = get(x.scenarios, "action-set");
  expect(definition.actions.map((a) => a.action)).toEqual(actions.actions);
  for (const a of definition.actions) {
    expect(a.target).toBeTruthy();
    expect(a.reason).toBeTruthy();
  }
  expect(actions.expected).toBe("reasoned");
  const parity = get(x.scenarios, "primary-goal-parity");
  expect(definition.primaryGoal).toBe(parity.goal);
  expect(definition.parityCheck.desktop).toBe(parity.goal);
  expect(definition.parityCheck.mobile).toBe(parity.goal);
  expect(parity.expected).toBe("preserved");
  const hide = get(x.scenarios, "hide-primary");
  expect(definition.actions.find((a) => a.action === "hide")?.target).not.toBe(
    hide.target,
  );
  expect(hide.expected).toBe("blocked");
  const unknown = get(x.scenarios, "missing-viewport-evidence");
  expect(definition.parityCheck.status).toBe(unknown.status);
  expect(unknown.expected).toBe("unverified");
  expect(
    (mobile.content as { expectedOutcome: string }).expectedOutcome,
  ).toContain("candidate identity");
});

type Bound = {
  name: string;
  ref: ReturnType<typeof ref>;
  artifact: ArtifactSnapshot;
};
function compositionBlock(
  bound: readonly Bound[],
  scenario: ArtifactSnapshot,
): string | undefined {
  const assets = bound.filter((b) => b.name === "resolved-assets");
  const kinds = new Set(
    assets.map((b) => (b.artifact.content as { assetKind: string }).assetKind),
  );
  for (const kind of ["pattern", "layout", "component"])
    if (!kinds.has(kind)) return `Missing exact ${kind} lock`;
  const pattern = assets.find(
    (b) =>
      (b.artifact.content as { assetKind: string }).assetKind === "pattern",
  )!.artifact;
  const terms = JSON.stringify(scenario.content).toLowerCase();
  if (
    pattern.content &&
    (pattern.content as { antiUsageRules: string[] }).antiUsageRules.some(
      (rule) => rule.toLowerCase().includes("rank unverified"),
    ) &&
    terms.includes("rank") &&
    terms.includes("unverified")
  )
    return "Pattern anti-usage forbids ranking unverified evidence";
  return undefined;
}
function mobileBlock(
  source: ArtifactSnapshot,
  mobile: ArtifactSnapshot,
  action: string,
): string | undefined {
  const sourceSteps = (source.content as { steps: string[] }).steps;
  const mobileSteps = (mobile.content as { steps: string[] }).steps;
  if (
    !sourceSteps.some((step) =>
      step.toLowerCase().includes(action.toLowerCase()),
    )
  )
    return "Source primary action is not established";
  if (
    !mobileSteps.some((step) =>
      step.toLowerCase().includes(action.toLowerCase()),
    )
  )
    return "Mobile primary action is absent from scenario steps";
  return undefined;
}

async function integrated(
  name: Name,
  mode: "produce" | "blocked" | "wrong-lock",
  change?:
    | "missing-layout"
    | "anti-usage"
    | "missing-mobile-action"
    | "sibling-binding",
) {
  const x = await setup(name);
  const runId = `run_${name.replaceAll("-", "_")}_${mode}_${change ?? "base"}`;
  const required = x.skill.manifest.inputs.required;
  const s14 = JSON.parse(
    await readFile(
      path.join(
        repository,
        "skills/s14-ui-composition-planner/examples/output.json",
      ),
      "utf8",
    ),
  ) as { selectedAssets: ArtifactSnapshot[] };
  const sourceByName = new Map<string, ArtifactSnapshot[]>();
  for (const input of required) {
    if (input.kind !== "artifact")
      throw new Error("Unexpected nonartifact required input");
    if (input.name === "resolved-assets" || input.name === "selected-assets") {
      sourceByName.set(input.name, s14.selectedAssets);
      continue;
    }
    if (name === "s15-responsive-architect" && input.name === "scenario") {
      sourceByName.set(input.name, [x.data.sourceScenario as ArtifactSnapshot]);
      continue;
    }
    const filename =
      input.artifactType === "design-direction"
        ? "approved-design-direction"
        : input.artifactType === "product-ui-contract"
          ? "proposed-product-ui-contract"
          : input.artifactType;
    sourceByName.set(input.name, [
      JSON.parse(
        await readFile(
          path.join(repository, "fixtures/artifacts/valid", `${filename}.json`),
          "utf8",
        ),
      ) as ArtifactSnapshot,
    ]);
  }
  const seedSources = required.flatMap((input) =>
    sourceByName.get(input.name)!,
  );
  const seedTasks: RoutedTask[] = seedSources.map((source, index) => ({
    id: `seed_${index}`,
    skillId: "mimic.fixture",
    outputType: source.meta.type,
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "AUTONOMOUS",
    inputs: { required: [], optional: [], alternatives: [] },
  }));
  const baseTask: RoutedTask = {
    id: "target",
    skillId: x.skill.manifest.skillId,
    outputType: x.skill.manifest.outputs[0]!,
    additionalOutputTypes: x.skill.manifest.outputs.slice(1),
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    inputs: {
      required: required.map((input) => ({ ...input })),
      optional: x.skill.manifest.inputs.optional.map((input) => ({ ...input })),
      alternatives: [],
    },
  };
  const followups: RoutedTask[] =
    name === "s13-visual-system-builder" && mode === "produce" && !change
      ? [
          { ...baseTask, id: "license-blocked" },
          { ...baseTask, id: "wrong-icon" },
          { ...baseTask, id: "binding" },
        ]
      : [];
  await x.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks: [...seedTasks, baseTask, ...followups],
  });
  const boundSources = new Map<string, ArtifactSnapshot[]>();
  let index = 0;
  for (const input of required) {
    const sources: ArtifactSnapshot[] = [];
    for (const fixture of sourceByName.get(input.name)!) {
      const a: ArtifactSnapshot = {
        ...fixture,
        meta: {
          id: `art_${runId}_${index}`,
          type: fixture.meta.type,
          schemaVersion: "1.0.0",
          revision: 1,
          title: `Input ${index}`,
          createdAt: at,
        },
        lifecycle: { status: "provisional", freshness: "valid" },
        approval: { status: "pending" },
        origin: {
          actorKind: "skill",
          actorId: "mimic.fixture",
          runId,
          createdAt: at,
        },
        dependencies: [],
        provenance: [
          {
            path: "/content",
            kind: "assumption",
            rationale: "Synthetic exact input fixture",
          },
        ],
        content:
          fixture.meta.type === "design-direction"
            ? {
                ...(fixture.content as Record<string, unknown>),
                selectionStatus: "candidate",
              }
            : fixture.content,
      };
      await x.artifacts.create(a);
      await x.registry.produce({
        runId,
        ref: ref(a),
        inputs: [],
        actor: { kind: "skill", id: "mimic.fixture" },
        at,
        reason: "Synthetic exact input",
      });
      sources.push(a);
      index++;
    }
    boundSources.set(input.name, sources);
  }
  const task: RoutedTask = {
    ...baseTask,
    inputs: {
      ...baseTask.inputs,
      required: required.map((input, i) => ({
        ...input,
        refs: boundSources
          .get(input.name)!
          .filter(
            (a) =>
              !(
                change === "missing-layout" &&
                input.name === "resolved-assets" &&
                (a.content as { assetKind: string }).assetKind === "layout"
              ),
          )
          .map((a, ri) =>
            mode === "wrong-lock" && i === 0 && ri === 0
              ? { ...ref(a), lockDigest: `sha256:${"0".repeat(64)}` }
              : ref(a),
          ),
      })),
    },
  };
  const tasks = [...seedTasks, task, ...followups];
  await x.registry.setWork({
    runId,
    safeActions: ["target", ...followups.map((item) => item.id)],
    blockers: {},
    actor: { kind: "agent", id: "agent_1" },
    at,
    reason: "Inputs ready",
  });
  let called = false;
  const execute = () =>
    runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks,
      taskId: "target",
      at,
      executor: async ({ invocation, inputs: bound, gaps }) => {
        called = true;
        expect(bound.map((b) => b.ref)).toEqual(invocation.inputRefs);
        expect(gaps.length).toBe(x.skill.manifest.inputs.optional.length);
        let reason: string | undefined;
        if (name === "s14-ui-composition-planner") {
          const original = x.data.scenario as ArtifactSnapshot;
          const scenario: ArtifactSnapshot =
            change === "anti-usage"
              ? {
                  ...original,
                  content: {
                    ...(original.content as Record<string, unknown>),
                    expectedOutcome: "Rank candidates with unverified evidence",
                  },
                }
              : original;
          reason = compositionBlock(bound, scenario);
        } else if (name === "s15-responsive-architect") {
          const original = x.data.scenario as ArtifactSnapshot;
          const mobile: ArtifactSnapshot =
            change === "missing-mobile-action"
              ? {
                  ...original,
                  content: {
                    ...(original.content as Record<string, unknown>),
                    steps: ["Read plans without a decision path"],
                  },
                }
              : original;
          const source = bound.find((b) => b.name === "scenario")!.artifact;
          const action = (
            (x.data.rule as ArtifactSnapshot).content as {
              definition: { primaryAction: string };
            }
          ).definition.primaryAction;
          reason = mobileBlock(source, mobile, action);
        }
        if (mode === "blocked" && !reason)
          reason = "No allowed asset composition";
        if (reason)
          return {
            result: {
              runId,
              taskId: "target",
              skillId: x.skill.manifest.skillId,
              inputRefs: invocation.inputRefs,
              outputRefs: [],
              blocked: { reason, affectedTaskIds: ["target"] },
            },
          };
        const examples =
          name === "s13-visual-system-builder" && change !== "sibling-binding"
            ? outputArtifacts(name, x.data).slice(0, 3)
            : outputArtifacts(name, x.data);
        const outputs: ArtifactSnapshot[] = [];
        for (const [outIndex, example] of examples.entries()) {
          const content =
            change === "missing-mobile-action" &&
            example.meta.type === "scenario"
              ? {
                  ...(example.content as Record<string, unknown>),
                  steps: ["Read plans without a decision path"],
                }
              : example.content;
          const rationale =
            name === "s14-ui-composition-planner"
              ? (example.provenance[0] as { rationale: string }).rationale
              : "Synthetic contract bridge only; substantive claims remain unverified";
          const a: ArtifactSnapshot = {
            ...example,
            meta: {
              ...example.meta,
              id: `art_${runId}_output_${outIndex}`,
              createdAt: at,
            },
            origin: {
              actorKind: "skill",
              actorId: x.skill.manifest.skillId,
              runId,
              createdAt: at,
            },
            dependencies: [
              ...bound.map((b) => ({
                ...b.ref,
                onChange: "validate" as const,
              })),
              ...(change === "sibling-binding" && outIndex === 3
                ? [{ ...ref(outputs[2]!), onChange: "validate" as const }]
                : []),
            ],
            provenance: [
              {
                path:
                  name === "s14-ui-composition-planner"
                    ? "/content/steps"
                    : "/content",
                kind: "derived",
                inputRefs: bound.map(
                  (b) =>
                    `${b.ref.artifactId}@${b.ref.revision}#${b.ref.lockDigest}`,
                ),
                rationale,
              },
            ],
            content,
          };
          await x.artifacts.create(a);
          outputs.push(a);
        }
        return {
          result: {
            runId,
            taskId: "target",
            skillId: x.skill.manifest.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: outputs.map(ref),
          },
        };
      },
    });
  if (mode === "wrong-lock" || change === "sibling-binding") {
    await expect(execute()).rejects.toThrow(
      change === "sibling-binding"
        ? "Output dependency outside minimal context"
        : undefined,
    );
    expect(called).toBe(change === "sibling-binding");
    return;
  }
  const result = await execute();
  expect(called).toBe(true);
  const expectedCount =
    mode === "blocked" || change
      ? 0
      : name === "s13-visual-system-builder"
        ? 3
        : name === "s15-responsive-architect"
          ? 2
          : 1;
  expect(result.result.outputRefs).toHaveLength(expectedCount);
  if (expectedCount === 0) {
    expect(result.result.blocked?.reason).toBe(
      change === "missing-layout"
        ? "Missing exact layout lock"
        : change === "anti-usage"
          ? "Pattern anti-usage forbids ranking unverified evidence"
          : change === "missing-mobile-action"
            ? "Mobile primary action is absent from scenario steps"
            : "No allowed asset composition",
    );
    expect((await x.registry.run(runId)).state).toBe("blocked");
    return;
  }
  for (const output of result.result.outputRefs) {
    const stored = await x.artifacts.read(output.artifactId, output.revision);
    expect(stored.artifact.dependencies.map((d) => d.artifactId)).toEqual(
      invocationInputIds(task),
    );
    expect(stored.artifact.approval.status).toBe("pending");
    if (name === "s14-ui-composition-planner") {
      expect(
        stored.artifact.dependencies.filter((d) =>
          boundSources
            .get("resolved-assets")!
            .some((a) => a.meta.id === d.artifactId),
        ),
      ).toHaveLength(3);
      expect(stored.artifact.provenance[0]?.rationale).toMatch(
        /Task → .*pattern → .*layout → .*variant/,
      );
    }
  }
  const outputTypes = await Promise.all(
    result.result.outputRefs.map(
      async (output) =>
        (await x.artifacts.read(output.artifactId, output.revision)).artifact
          .meta.type,
    ),
  );
  expect(outputTypes).toEqual(
    (name === "s13-visual-system-builder"
      ? outputArtifacts(name, x.data).slice(0, 3)
      : outputArtifacts(name, x.data)
    ).map((a) => a.meta.type),
  );
  return { x, runId, task, seedTasks, boundSources, result };
}
function invocationInputIds(task: RoutedTask): string[] {
  return task.inputs.required.flatMap((input) =>
    input.kind === "artifact"
      ? (input.refs ?? []).map((r) => r.artifactId)
      : [],
  );
}

test.each(names)(
  "%s routes exact inputs and proposed output through runtime",
  async (name) => {
    await integrated(name, "produce");
  },
);
test.each(names)(
  "%s returns a zero output blocker without inventing an artifact",
  async (name) => {
    await integrated(name, "blocked");
  },
);
test.each(names)("%s rejects a mismatched input lock", async (name) => {
  await integrated(name, "wrong-lock");
});

test("S13 rejects a sibling binding in one invocation, then stages it against the produced semantic icon", async () => {
  await integrated("s13-visual-system-builder", "produce", "sibling-binding");
  const stage = await integrated("s13-visual-system-builder", "produce");
  if (!stage) throw new Error("Expected staged S13 context");
  const { x, runId, task, seedTasks, result } = stage;
  const iconRef = result.result.outputRefs[2]!;
  const icon = await x.artifacts.read(iconRef.artifactId, iconRef.revision);
  expect((icon.artifact.content as { assetKind: string }).assetKind).toBe(
    "semantic-icon",
  );
  const bindingExample = outputArtifacts(
    "s13-visual-system-builder",
    x.data,
  )[3]!;
  const bindingDefinition = (
    bindingExample.content as {
      definition: { provider: string; glyph: string };
    }
  ).definition;
  async function invokeBinding(
    taskId: "license-blocked" | "wrong-icon" | "binding",
    file: string,
    requestedIconId = iconRef.artifactId,
  ) {
    const bindingTask: RoutedTask = {
      ...task,
      id: taskId,
      evidenceFiles: [file],
      inputs: {
        ...task.inputs,
        required: task.inputs.required.map((input) =>
          input.name === "foundations-and-governance" &&
          input.kind === "artifact"
            ? { ...input, refs: [...(input.refs ?? []), iconRef] }
            : input,
        ),
      },
    };
    return runSkillPackage({
      orchestrator: x.orchestrator,
      package: x.skill,
      runId,
      tasks: [...seedTasks, task, bindingTask],
      taskId,
      at,
      executor: async ({ invocation, inputs, package: loaded, gaps }) => {
        const evidence = JSON.parse(loaded.examples[file]!) as {
          provider: string;
          glyph: string;
          licenseTerms: string;
          noticePlan: string;
          reviewedForFixture: boolean;
        };
        expect(gaps).not.toContain("provider-license-evidence");
        const reason =
          !evidence.reviewedForFixture ||
          evidence.provider !== bindingDefinition.provider ||
          evidence.glyph !== bindingDefinition.glyph ||
          !evidence.licenseTerms ||
          !evidence.noticePlan
            ? "Provider license evidence is unverified for this binding"
            : undefined;
        if (reason)
          return {
            result: {
              runId,
              taskId,
              skillId: x.skill.manifest.skillId,
              inputRefs: invocation.inputRefs,
              outputRefs: [],
              blocked: { reason, affectedTaskIds: [taskId] },
            },
          };
        expect(
          inputs.some(
            (input) =>
              input.ref.artifactId === iconRef.artifactId &&
              input.ref.lockDigest === iconRef.lockDigest,
          ),
        ).toBe(true);
        const content = {
          ...(bindingExample.content as Record<string, unknown>),
          definition: {
            ...(
              bindingExample.content as { definition: Record<string, unknown> }
            ).definition,
            semanticIconArtifactId: requestedIconId,
          },
        };
        if (requestedIconId !== iconRef.artifactId)
          return {
            result: {
              runId,
              taskId,
              skillId: x.skill.manifest.skillId,
              inputRefs: invocation.inputRefs,
              outputRefs: [],
              blocked: {
                reason:
                  "Provider binding semantic icon ID differs from exact input lock",
                affectedTaskIds: [taskId],
              },
            },
          };
        const candidate: ArtifactSnapshot = {
          ...bindingExample,
          meta: {
            ...bindingExample.meta,
            id: `art_${runId}_binding`,
            createdAt: at,
          },
          origin: {
            actorKind: "skill",
            actorId: x.skill.manifest.skillId,
            runId,
            createdAt: at,
          },
          dependencies: inputs.map((input) => ({
            ...input.ref,
            onChange: "validate",
          })),
          content,
          provenance: [
            {
              path: "/content/definition",
              kind: "derived",
              inputRefs: inputs.map(
                (input) =>
                  `${input.ref.artifactId}@${input.ref.revision}#${input.ref.lockDigest}`,
              ),
              rationale:
                "Provider binding proposed against exact semantic icon; synthetic license evidence requires real review before trusted reuse.",
            },
          ],
        };
        await x.artifacts.create(candidate);
        return {
          result: {
            runId,
            taskId,
            skillId: x.skill.manifest.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [ref(candidate)],
          },
        };
      },
    });
  }
  const rejected = await invokeBinding(
    "license-blocked",
    "examples/license-unverified.json",
  );
  expect(rejected.result.outputRefs).toHaveLength(0);
  expect(rejected.result.blocked?.reason).toBe(
    "Provider license evidence is unverified for this binding",
  );
  expect((await x.registry.run(runId)).run.blockers["license-blocked"]).toBe(
    rejected.result.blocked?.reason,
  );
  const wrongIcon = get(x.scenarios, "wrong-icon-reference");
  const wrong = await invokeBinding(
    "wrong-icon",
    get(x.scenarios, "license-fixture-review").fixture as string,
    wrongIcon.wrongArtifactId as string,
  );
  expect(wrongIcon.expected).toBe("blocked");
  expect(wrong.result.outputRefs).toHaveLength(0);
  expect(wrong.result.blocked?.reason).toBe(
    "Provider binding semantic icon ID differs from exact input lock",
  );
  expect((await x.registry.run(runId)).run.blockers["wrong-icon"]).toBe(
    wrong.result.blocked?.reason,
  );
  const produced = await invokeBinding(
    "binding",
    get(x.scenarios, "license-fixture-review").fixture as string,
  );
  expect(produced.result.outputRefs).toHaveLength(1);
  const binding = await x.artifacts.read(
    produced.result.outputRefs[0]!.artifactId,
    1,
  );
  expect((binding.artifact.content as { assetKind: string }).assetKind).toBe(
    "provider-binding",
  );
  expect(binding.artifact.dependencies).toContainEqual({
    ...iconRef,
    onChange: "validate",
  });
  expect(
    (
      binding.artifact.content as {
        definition: { semanticIconArtifactId: string };
      }
    ).definition.semanticIconArtifactId,
  ).toBe(iconRef.artifactId);
  expect(
    new Set([
      ...result.result.outputRefs.map((output) => output.artifactId),
      binding.artifact.meta.id,
    ]).size,
  ).toBe(4);
});

test("S14 blocks missing layout lock and pattern anti-usage from changed inputs", async () => {
  await integrated("s14-ui-composition-planner", "produce", "missing-layout");
  await integrated("s14-ui-composition-planner", "produce", "anti-usage");
});

test("S15 blocks a changed mobile scenario that removes the primary decision path", async () => {
  await integrated(
    "s15-responsive-architect",
    "produce",
    "missing-mobile-action",
  );
});

test.each(names)(
  "%s repeat cases require a new revision after rejection",
  async (name) => {
    const x = await setup(name);
    const c = get(x.scenarios, "rejection-repeat");
    const example = outputArtifacts(name, x.data)[0]!;
    expect(c.expected).toBe("new-revision");
    const previous: ArtifactSnapshot = {
      ...example,
      meta: { ...example.meta, revision: c.rejectedRevision as number },
      lifecycle: { status: "rejected", freshness: "valid" },
      approval: {
        status: "rejected",
        decisionId: "decision_reject",
        actorId: "human_1",
        at,
      } as ArtifactSnapshot["approval"],
    };
    const next: ArtifactSnapshot = {
      ...example,
      meta: {
        ...example.meta,
        revision: c.newRevision as number,
        supersedesRevision: c.rejectedRevision as number,
      },
      provenance: [
        ...example.provenance,
        {
          path: "/content",
          kind: "assumption",
          rationale: `Revisits rejected revision ${c.rejectedRevision}; new proposal for review`,
        },
      ],
    };
    expect(
      await guardArtifactRevision({ previous, next, action: "propose" }),
    ).toMatchObject({ allowed: true });
    expect(
      await guardArtifactRevision({
        previous,
        next: {
          ...next,
          meta: { ...next.meta, revision: c.rejectedRevision as number },
        },
        action: "propose",
      }),
    ).toMatchObject({ allowed: false });
  },
);

test("blocked scenarios and bad-lock descriptions are explicit", async () => {
  for (const name of names) {
    const x = await setup(name);
    for (const c of x.scenarios) {
      if (c.id === "bad-lock" || c.id === "wrong-lock") {
        expect(c.expected).toBe("rejected");
        expect(c.message).toMatch(/lock mismatch/i);
      }
      if (c.id === "missing-asset-lock") {
        expect(c.expected).toBe("blocked");
        expect(c.outputCount).toBe(0);
      }
    }
  }
});
