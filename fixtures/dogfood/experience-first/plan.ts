import type { ExactArtifactRef } from "../../../packages/core/src/runtime-engines/dependency.js";
import type {
  PrototypeBuilderInput,
  PrototypeNode,
} from "../../../packages/core/src/prototype-builder/index.js";
import type { setupApprovedPrototypeFixture } from "../../prototypes/approved.js";

type BaseFixture = Awaited<ReturnType<typeof setupApprovedPrototypeFixture>>;

/** Reviewable, authored generation input. The scenario lock is injected after fixture storage. */
export function authoredExperiencePlan(
  base: BaseFixture,
  scenario: ExactArtifactRef,
  caseId: string,
): PrototypeBuilderInput {
  const commonContext: PrototypeNode[] = [
    { tag: "p", text: "Queue / Review · needs-review" },
    { tag: "p", text: "Return to filtered queue; draft remains uncommitted" },
  ];
  const desktopContext: PrototypeNode = {
    tag: "section",
    id: "case-context",
    children: [
      { tag: "h2", text: "Queue and case context" },
      { tag: "p", id: "case-identity", text: `Case ${caseId}` },
      ...commonContext,
      {
        tag: "a",
        id: "overview-anchor",
        text: "Back to review overview",
        href: "#review-root",
      },
    ],
  };
  const mobileContext: PrototypeNode = {
    tag: "section",
    id: "mobile-case-nav",
    children: [
      { tag: "h2", text: "Focused case navigation" },
      { tag: "p", id: "mobile-case-identity", text: `Case ${caseId}` },
      ...commonContext,
      {
        tag: "a",
        id: "mobile-overview-anchor",
        text: "Back to review overview",
        href: "#review-root",
      },
    ],
  };
  const states: PrototypeBuilderInput["states"] = base.input.states.map(
    (state) => {
      if (state.name !== "success")
        return {
          ...state,
          root: {
            ...state.root,
            children: [
              {
                tag: "section" as const,
                children: [
                  { tag: "h2" as const, text: `${caseId} · ${state.name}` },
                  ...commonContext,
                  {
                    tag: "button" as const,
                    componentId: base.refs.component.artifactId,
                    text: "Show success",
                    targetState: "success" as const,
                  },
                ],
              },
              ...(state.root.children ?? []),
            ],
          },
        };
      const sourceActions = state.root.children![0]!.children!.filter(
        (node) => node.tag === "button",
      );
      return {
        ...state,
        root: {
          tag: "main",
          id: "review-root",
          children: [
            desktopContext,
            {
              tag: "section",
              id: "review-decision",
              children: [
                { tag: "h2", text: `${caseId} · success` },
                { tag: "p", fixtureKey: "message" },
                ...sourceActions.map((action, index) => ({
                  ...action,
                  id:
                    index === 0 ? "choose-case" : `show-${action.targetState}`,
                })),
              ],
            },
            {
              tag: "section",
              id: "evidence-list",
              children: [
                { tag: "h2", text: "Evidence and uncertainty" },
                {
                  tag: "p",
                  id: "review-uncertainty",
                  text: `Synthetic evidence for ${caseId} remains reviewable`,
                },
              ],
            },
            {
              tag: "section",
              id: "decision-history",
              children: [
                { tag: "h2", text: "Decision history" },
                {
                  tag: "p",
                  id: "uncommitted-history",
                  text: "No decision has been committed",
                },
              ],
            },
          ],
        },
      };
    },
  );
  const same = (id: string) => ({ desktopId: id, mobileId: id });
  return {
    ...base.input,
    scenario,
    title: "Synthetic C-204 case review",
    states,
    responsive: {
      version: 1,
      states: [
        {
          state: "success",
          rule: base.refs.responsiveRule,
          rationale:
            "Keep the C-204 decision first on narrow screens, with named paths to case context, uncertainty and uncommitted history.",
          continuity: {
            entity: {
              desktopId: "case-identity",
              mobileId: "mobile-case-identity",
            },
            primaryAction: same("choose-case"),
            criticalInfo: [
              same("review-uncertainty"),
              same("uncommitted-history"),
            ],
            returnPath: {
              desktopId: "overview-anchor",
              mobileId: "mobile-overview-anchor",
            },
          },
          operations: [
            {
              kind: "reorder",
              parentId: "review-root",
              childIds: [
                "review-decision",
                "case-context",
                "evidence-list",
                "decision-history",
              ],
            },
            {
              kind: "collapse",
              targetId: "evidence-list",
              summary: "Review evidence and uncertainty",
            },
            {
              kind: "progressive-disclose",
              targetId: "decision-history",
              summary: "Show uncommitted decision history",
            },
            {
              kind: "replace",
              targetId: "case-context",
              with: mobileContext,
              focusMap: [
                {
                  desktopId: "overview-anchor",
                  mobileId: "mobile-overview-anchor",
                },
              ],
            },
          ],
        },
      ],
    },
    outputPath: "experience-generated",
  };
}
