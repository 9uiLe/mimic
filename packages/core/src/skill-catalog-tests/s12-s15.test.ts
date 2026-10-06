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

async function integrated(
  name: Name,
  mode: "produce" | "blocked" | "wrong-lock",
) {
  const x = await setup(name);
  const runId = `run_${name.replaceAll("-", "_")}_${mode}`;
  const required = x.skill.manifest.inputs.required;
  const seedTasks: RoutedTask[] = required.map((input, i) => ({
    id: `seed_${i}`,
    skillId: "mimic.fixture",
    outputType: input.kind === "artifact" ? input.artifactType : "scenario",
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
      required: required.map((i) => ({ ...i })),
      optional: x.skill.manifest.inputs.optional.map((i) => ({ ...i })),
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
  const inputs: ArtifactSnapshot[] = [];
  for (const [i, input] of required.entries()) {
    if (input.kind !== "artifact")
      throw new Error("Unexpected nonartifact required input");
    const filename =
      input.artifactType === "design-direction"
        ? "approved-design-direction"
        : input.artifactType === "product-ui-contract"
          ? "proposed-product-ui-contract"
          : input.artifactType;
    const fixture = JSON.parse(
      await readFile(
        path.join(repository, "fixtures/artifacts/valid", `${filename}.json`),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const a: ArtifactSnapshot = {
      ...fixture,
      meta: {
        id: `art_${runId}_${i}`,
        type: input.artifactType,
        schemaVersion: "1.0.0",
        revision: 1,
        title: `Input ${i}`,
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
          rationale: "Synthetic input only",
        },
      ],
      content:
        input.artifactType === "design-direction"
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
    inputs.push(a);
  }
  const task: RoutedTask = {
    ...baseTask,
    inputs: {
      ...baseTask.inputs,
      required: required.map((v, i) => ({
        ...v,
        refs: [
          mode === "wrong-lock" && i === 0
            ? { ...ref(inputs[i]!), lockDigest: `sha256:${"0".repeat(64)}` }
            : ref(inputs[i]!),
        ],
      })),
    },
  };
  const tasks = [...seedTasks, task];
  await x.registry.setWork({
    runId,
    safeActions: ["target"],
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
        if (mode === "blocked")
          return {
            result: {
              runId,
              taskId: "target",
              skillId: x.skill.manifest.skillId,
              inputRefs: invocation.inputRefs,
              outputRefs: [],
              blocked: {
                reason: "No allowed asset composition",
                affectedTaskIds: ["target"],
              },
            },
          };
        const example = outputArtifacts(name, x.data)[0]!;
        const a: ArtifactSnapshot = {
          ...example,
          meta: { ...example.meta, id: `art_${runId}_output`, createdAt: at },
          origin: {
            actorKind: "skill",
            actorId: x.skill.manifest.skillId,
            runId,
            createdAt: at,
          },
          dependencies: bound.map((b) => ({ ...b.ref, onChange: "validate" })),
          provenance: [
            {
              path: "/content",
              kind: "derived",
              inputRefs: bound.map(
                (b) =>
                  `${b.ref.artifactId}@${b.ref.revision}#${b.ref.lockDigest}`,
              ),
              rationale:
                "Synthetic contract bridge only; substantive claims remain unverified",
            },
          ],
        };
        await x.artifacts.create(a);
        return {
          result: {
            runId,
            taskId: "target",
            skillId: x.skill.manifest.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [ref(a)],
          },
        };
      },
    });
  if (mode === "wrong-lock") {
    await expect(execute()).rejects.toThrow();
    expect(called).toBe(false);
    return;
  }
  const result = await execute();
  expect(called).toBe(true);
  expect(result.result.outputRefs).toHaveLength(mode === "blocked" ? 0 : 1);
  if (mode === "produce") {
    const stored = await x.artifacts.read(
      result.result.outputRefs[0]!.artifactId,
      1,
    );
    expect(stored.artifact.dependencies.map((d) => d.artifactId)).toEqual(
      inputs.map((a) => a.meta.id),
    );
    expect(stored.artifact.approval.status).toBe("pending");
  }
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
