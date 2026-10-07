import { setupApprovedPrototypeFixture } from "../prototypes/approved.js";
import type {
  PrototypeBuilderInput,
  PrototypeNode,
} from "../../packages/core/src/prototype-builder/index.js";

/** Synthetic approved locks plus a separately authored, reviewable responsive plan. */
export async function setupResponsiveFixture() {
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
  return { ...fixture, input };
}
