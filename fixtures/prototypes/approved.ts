import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactDigest,
  type JsonValue,
} from "../../packages/core/src/artifact-canonical.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
} from "../../packages/core/src/artifact-store.js";
import { loadSchemaDirectory } from "../../packages/core/src/schema-registry.js";
import type { ExactArtifactRef } from "../../packages/core/src/runtime-engines/dependency.js";
import type {
  PrototypeBuilderInput,
  PrototypeNode,
  PrototypeState,
} from "../../packages/core/src/prototype-builder/index.js";

const repository = path.resolve(import.meta.dirname, "../..");
const approval = {
  status: "approved" as const,
  decisionId: "decision_fixture",
  actorId: "human_fixture",
  at: "2026-10-06T12:00:00Z",
};
const fixtureText: Record<PrototypeState, string> = {
  loading: "Loading synthetic candidates",
  empty: "No synthetic candidates",
  partial: "Partial synthetic evidence",
  success: "Synthetic candidate ready",
  error: "Synthetic load error",
  permission: "Synthetic access required",
  disabled: "Synthetic action disabled",
};
export async function setupApprovedPrototypeFixture(
  options: { scenarioApproved?: boolean } = {},
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "mimic-prototype-fixture-"),
  );
  const schema = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const store = new ArtifactStore(
    new FileSnapshotStorage(path.join(root, "artifacts")),
    schema,
    [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ],
    {
      async verifyApproval(value) {
        return (
          value.status === "approved" &&
          value.decisionId === "decision_fixture" &&
          value.actorId === "human_fixture"
        );
      },
      async verifyDecision() {
        return false;
      },
    },
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
  async function add(
    id: string,
    kind: string,
    definition: Record<string, JsonValue>,
    dependencies: ArtifactSnapshot["dependencies"] = [],
    provenance: ArtifactSnapshot["provenance"] = template.provenance,
    approved = true,
  ) {
    const bare: ArtifactSnapshot = {
      ...template,
      meta: {
        ...template.meta,
        id,
        type: kind === "scenario" ? "scenario" : "design-system-asset",
        title: id,
      },
      lifecycle: {
        status: approved ? "approved" : "proposed",
        freshness: "valid",
      },
      approval: approved ? approval : { status: "pending" },
      dependencies,
      provenance,
      content:
        kind === "scenario"
          ? {
              summary: "Synthetic comparison",
              actor: "Reviewer",
              context: "Reviewing synthetic options",
              steps: [
                "Open comparison",
                "Inspect candidate",
                "Choose candidate",
              ],
              expectedOutcome: "Choose a synthetic candidate",
            }
          : {
              summary: `Fixture ${kind}`,
              assetKind: kind,
              name: id,
              definition,
              usageRules: ["Use in synthetic fixture"],
              antiUsageRules: ["Do not use in production"],
            },
    };
    const artifact = approved
      ? { ...bare, meta: { ...bare.meta, contentDigest: artifactDigest(bare) } }
      : bare;
    const result = await store.create(artifact);
    return {
      ref: {
        artifactId: id,
        revision: 1,
        lockDigest: result.digest,
      } satisfies ExactArtifactRef,
      artifact,
    };
  }
  const pattern = await add("art_fixture_pattern", "pattern", {
    task: "Choose synthetic candidate",
    slots: ["identity", "decision"],
  });
  const layout = await add("art_fixture_layout", "layout", {
    order: ["identity", "decision"],
  });
  const component = await add("art_fixture_button", "component", {
    role: "button",
    states: ["enabled"],
  });
  const responsiveRule = await add(
    "art_fixture_responsive",
    "responsive-rule",
    { breakpointPx: 640, desktopColumns: 2, mobileColumns: 1 },
  );
  const accessibilityRule = await add(
    "art_fixture_accessibility",
    "accessibility-rule",
    { requirement: "Named controls and logical order" },
  );
  const token = await add("art_fixture_tokens", "dtcg-tokens", {
    tokens: {
      primitive: {
        color: {
          ink: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3] },
          },
        },
      },
      semantic: {
        color: { text: { $type: "color", $value: "{primitive.color.ink}" } },
      },
    },
  });
  const selected = [
    pattern.ref,
    layout.ref,
    component.ref,
    responsiveRule.ref,
    accessibilityRule.ref,
    token.ref,
  ];
  const scenario = await add(
    "art_fixture_scenario",
    "scenario",
    {},
    selected.map((ref) => ({ ...ref, onChange: "validate" })),
    [
      {
        path: "/content/steps",
        kind: "derived",
        inputRefs: selected.map((ref) => `${ref.artifactId}@${ref.revision}`),
        rationale:
          "Task → pattern → layout → components: synthetic comparison with explicit mobile parity",
      },
    ],
    options.scenarioApproved ?? true,
  );
  const requiredStates: PrototypeState[] = [
    "loading",
    "empty",
    "partial",
    "success",
    "error",
    "permission",
    "disabled",
  ];
  const states = requiredStates.map((name) => {
    const root: PrototypeNode = {
      tag: "main",
      children: [
        {
          tag: "section",
          children: [
            { tag: "h2", text: `${name} view` },
            { tag: "p", fixtureKey: "message" },
            ...(name === "success"
              ? requiredStates
                  .filter((target) => target !== "success")
                  .map((target) => ({
                    tag: "button" as const,
                    componentId: component.ref.artifactId,
                    text: `Show ${target}`,
                    targetState: target,
                  }))
              : [
                  {
                    tag: "button" as const,
                    componentId: component.ref.artifactId,
                    text: "Show success",
                    targetState: "success" as const,
                  },
                ]),
          ],
        },
      ],
    };
    return { name, root };
  });
  const input: PrototypeBuilderInput = {
    scenario: scenario.ref,
    selection: {
      pattern: pattern.ref,
      layout: layout.ref,
      components: [component.ref],
      responsiveRule: responsiveRule.ref,
      accessibilityRule: accessibilityRule.ref,
    },
    tokenSources: [token.ref],
    title: "Synthetic candidate comparison",
    initialState: "loading",
    requiredStates,
    states,
    fixtures: Object.fromEntries(
      requiredStates.map((name) => [name, { message: fixtureText[name] }]),
    ),
    layout: { breakpointPx: 640, desktopColumns: 2, mobileColumns: 1 },
    styleTokens: { foreground: "semantic.color.text" },
    outputPath: "generated",
  };
  return {
    root,
    store,
    input,
    refs: {
      scenario: scenario.ref,
      pattern: pattern.ref,
      layout: layout.ref,
      component: component.ref,
      responsiveRule: responsiveRule.ref,
      accessibilityRule: accessibilityRule.ref,
      token: token.ref,
    },
  };
}
