import { setupApprovedPrototypeFixture } from "../prototypes/approved.js";
import { artifactDigest } from "../../packages/core/src/artifact-canonical.js";
import type { ArtifactSnapshot } from "../../packages/core/src/artifact-store.js";
import type { ExactArtifactRef } from "../../packages/core/src/runtime-engines/dependency.js";
import type {
  PrototypeBuilderInput,
  PrototypeNode,
} from "../../packages/core/src/prototype-builder/index.js";

/** Synthetic approved locks plus a separately authored, reviewable responsive plan. */
export async function setupResponsiveFixture(
  options: { breakpointPx?: number } = {},
) {
  const fixture = await setupApprovedPrototypeFixture();
  const success = fixture.input.states.find(
    (state) => state.name === "success",
  )!;
  const originalActions = success.root.children![0]!.children!.filter(
    (node) => node.tag === "button",
  );
  const actions: PrototypeNode = {
    tag: "section",
    id: "candidate-actions",
    children: [
      { tag: "h2", text: "Candidate decision" },
      ...originalActions.map((node, index) => ({
        ...node,
        id:
          index === 0
            ? "choose-candidate"
            : index === 1
              ? "return-queue"
              : `state-action-${index}`,
      })),
    ],
  };
  const context: PrototypeNode = {
    tag: "section",
    id: "candidate-context",
    children: [
      { tag: "h2", text: "Candidate context" },
      { tag: "p", id: "candidate-identity", text: "Synthetic candidate C-204" },
    ],
  };
  const evidence: PrototypeNode = {
    tag: "section",
    id: "candidate-evidence",
    children: [
      { tag: "h2", text: "Evidence and uncertainty" },
      {
        tag: "p",
        id: "candidate-uncertainty",
        text: "Synthetic uncertainty remains visible on request",
      },
    ],
  };
  const root: PrototypeNode = {
    tag: "main",
    id: "candidate-root",
    children: [context, actions, evidence],
  };
  const same = (id: string) => ({ desktopId: id, mobileId: id });
  const input: PrototypeBuilderInput = {
    ...fixture.input,
    outputPath: "responsive-generated",
    states: fixture.input.states.map((state) =>
      state.name === "success" ? { ...success, root } : state,
    ),
    responsive: {
      version: 1,
      states: [
        {
          state: "success",
          rule: fixture.refs.responsiveRule,
          rationale:
            "Put the decision first on narrow viewports; keep identity and uncertainty reachable through named disclosures.",
          continuity: {
            entity: same("candidate-identity"),
            primaryAction: {
              desktopId: "choose-candidate",
              mobileId: "mobile-choose-candidate",
            },
            criticalInfo: [same("candidate-uncertainty")],
            returnPath: same("return-queue"),
          },
          operations: [
            {
              kind: "reorder",
              parentId: "candidate-root",
              childIds: [
                "candidate-actions",
                "candidate-context",
                "candidate-evidence",
              ],
            },
            {
              kind: "collapse",
              targetId: "candidate-context",
              summary: "Candidate identity",
            },
            {
              kind: "progressive-disclose",
              targetId: "candidate-evidence",
              summary: "More evidence and uncertainty",
            },
            {
              kind: "replace",
              targetId: "choose-candidate",
              with: {
                tag: "button",
                id: "mobile-choose-candidate",
                componentId: fixture.refs.component.artifactId,
                text: "Choose C-204",
                targetState: "disabled",
              },
              focusMap: [
                {
                  desktopId: "choose-candidate",
                  mobileId: "mobile-choose-candidate",
                },
              ],
            },
          ],
        },
      ],
    },
  };
  if (options.breakpointPx === undefined || options.breakpointPx === 640)
    return { ...fixture, input };
  const sourceRule = (
    await fixture.store.read(fixture.refs.responsiveRule.artifactId, 1)
  ).artifact;
  const { contentDigest: _ruleDigest, ...ruleMeta } = sourceRule.meta;
  void _ruleDigest;
  const ruleBare: ArtifactSnapshot = {
    ...sourceRule,
    meta: {
      ...ruleMeta,
      id: "art_fixture_responsive_variant",
      title: "Responsive variant",
    },
    content: {
      ...(sourceRule.content as Record<string, unknown>),
      definition: {
        ...(sourceRule.content as { definition: Record<string, unknown> })
          .definition,
        breakpointPx: options.breakpointPx,
      },
    } as ArtifactSnapshot["content"],
  };
  const savedRule = await fixture.store.create({
    ...ruleBare,
    meta: { ...ruleBare.meta, contentDigest: artifactDigest(ruleBare) },
  });
  const rule: ExactArtifactRef = {
    artifactId: ruleBare.meta.id,
    revision: 1,
    lockDigest: savedRule.digest,
  };
  const sourceScenario = (
    await fixture.store.read(fixture.refs.scenario.artifactId, 1)
  ).artifact;
  const { contentDigest: _scenarioDigest, ...scenarioMeta } =
    sourceScenario.meta;
  void _scenarioDigest;
  const scenarioBare: ArtifactSnapshot = {
    ...sourceScenario,
    meta: { ...scenarioMeta, revision: 2, supersedesRevision: 1 },
    dependencies: sourceScenario.dependencies.map((dependency) =>
      dependency.artifactId === fixture.refs.responsiveRule.artifactId
        ? { ...rule, onChange: dependency.onChange }
        : dependency,
    ),
  };
  const savedScenario = await fixture.store.create({
    ...scenarioBare,
    meta: { ...scenarioBare.meta, contentDigest: artifactDigest(scenarioBare) },
  });
  const scenario: ExactArtifactRef = {
    artifactId: scenarioBare.meta.id,
    revision: 2,
    lockDigest: savedScenario.digest,
  };
  return {
    ...fixture,
    refs: { ...fixture.refs, responsiveRule: rule, scenario },
    input: {
      ...input,
      scenario,
      selection: { ...input.selection, responsiveRule: rule },
      layout: { ...input.layout, breakpointPx: options.breakpointPx },
      responsive: {
        ...input.responsive!,
        states: input.responsive!.states.map((entry) => ({ ...entry, rule })),
      },
    },
  };
}
