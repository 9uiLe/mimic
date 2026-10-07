import type { ExactArtifactRef } from "../../../packages/core/src/runtime-engines/dependency.js";
import type { PrototypeBuilderInput } from "../../../packages/core/src/prototype-builder/index.js";
import type { setupApprovedPrototypeFixture } from "../../prototypes/approved.js";

type BaseFixture = Awaited<ReturnType<typeof setupApprovedPrototypeFixture>>;

/** Reviewable, authored generation input. The scenario lock is injected after fixture storage. */
export function authoredExperiencePlan(
  base: BaseFixture,
  scenario: ExactArtifactRef,
  caseId: string,
): PrototypeBuilderInput {
  return {
    ...base.input,
    scenario,
    title: "Synthetic C-204 case review",
    states: base.input.states.map((state) => ({
      ...state,
      root: {
        ...state.root,
        children: [
          {
            tag: "section" as const,
            children: [
              { tag: "h2" as const, text: `${caseId} · ${state.name}` },
              { tag: "p" as const, text: "Queue / Review · needs-review" },
              {
                tag: "p" as const,
                text: "Return to filtered queue; draft remains uncommitted",
              },
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
    })),
    outputPath: "experience-generated",
  };
}
