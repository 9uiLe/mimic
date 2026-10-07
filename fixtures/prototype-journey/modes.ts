import type { PrototypeJourneyInput } from "../../packages/core/src/prototype-journey/index.js";
import {
  enumerateJourneyContributions,
  type PrototypeJourneyModePlan,
} from "../../packages/core/src/prototype-modes/journey.js";
import type { setupPrototypeJourney } from "./setup.js";

type Fixture = Awaited<ReturnType<typeof setupPrototypeJourney>>;

export function authoredJourneyModes(
  fixture: Fixture,
): PrototypeJourneyModePlan {
  const current: PrototypeJourneyInput = {
    ...fixture.journeyPlan,
    outputPath: "current",
  };
  const proposed = structuredClone(current) as PrototypeJourneyInput;
  const review = proposed.views.find((view) => view.id === "review")!;
  const success = review.render.states.find(
    (state) => state.name === "success",
  )!;
  const decision = success.root.children!.find(
    (node) => node.id === "review-decision",
  )!;
  const proposedDecision = {
    ...decision,
    children: [
      ...(decision.children ?? []),
      {
        tag: "button" as const,
        id: "proposed-preview",
        componentId: review.render.selection.components[0]!.artifactId,
        text: "Preview proposed assistance",
      },
    ],
  };
  const proposedReview = {
    ...review,
    render: {
      ...review.render,
      states: review.render.states.map((state) =>
        state.name === "success"
          ? {
              ...state,
              root: {
                ...state.root,
                children: state.root.children!.map((node) =>
                  node.id === "review-decision" ? proposedDecision : node,
                ),
              },
            }
          : state,
      ),
    },
  };
  const proposedPlan: PrototypeJourneyInput = {
    ...proposed,
    outputPath: "proposed",
    views: proposed.views.map((view) =>
      view.id === "review" ? proposedReview : view,
    ),
    controls: [
      ...proposed.controls,
      {
        viewId: "review",
        nodeId: "proposed-preview",
        action: { kind: "set-status", status: "partial" },
      },
    ],
  };
  const currentValues = enumerateJourneyContributions(current);
  const proposedValues = enumerateJourneyContributions(proposedPlan);
  const currentId = "caseContext";
  const proposedId = "reviewAssist";
  return {
    contract: fixture.contract.ref,
    choices: [
      {
        id: currentId,
        status: "current",
        capability: fixture.currentCapability!.ref,
      },
      {
        id: proposedId,
        status: "proposed",
        capability: fixture.proposedCapability!.ref,
        systemRequest: fixture.request!.ref,
      },
    ],
    currentUses: [currentId],
    proposedUses: [currentId, proposedId],
    bindings: {
      current: [...currentValues.keys()].map((contribution) => ({
        contribution,
        choiceId: currentId,
      })),
      proposed: [...proposedValues].map(([contribution, value]) => ({
        contribution,
        choiceId:
          currentValues.get(contribution) === value ? currentId : proposedId,
      })),
    },
    decisionContext: { kind: "live", requests: [fixture.request!.ref] },
    current,
    proposed: proposedPlan,
    comparisonPath: "journey-comparison",
  };
}
