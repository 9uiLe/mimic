import { expect, test } from "vitest";
import { preflightPlan } from "../src/plan.js";

const scopes = [{ level: "organization" as const, ownerId: "org_local" }];
const source = {
  id: "diverge",
  skillId: "mimic.s10.design-direction-generator",
  outputType: "design-direction",
  scopeOwnerId: "org_local",
  inputs: { required: [], optional: [], alternatives: [] },
  intent: "create",
  authority: "AUTONOMOUS",
};
const consumer = {
  id: "compare",
  skillId: "mimic.s11.direction-evaluator",
  outputType: "evaluation",
  scopeOwnerId: "org_local",
  dependsOn: ["diverge"],
  inputs: {
    required: [
      {
        kind: "artifact",
        name: "design-direction",
        artifactType: "design-direction",
        refsFromTask: "diverge",
      },
    ],
    optional: [],
    alternatives: [],
  },
  intent: "create",
  authority: "PROPOSE_ONLY",
};

test("accepts a same-Run producer output selector", () => {
  expect(preflightPlan([source, consumer], scopes, "org_local")).toHaveLength(
    2,
  );
});

test("rejects a selector without its dependency or matching output type", () => {
  expect(() =>
    preflightPlan(
      [source, { ...consumer, dependsOn: [] }],
      scopes,
      "org_local",
    ),
  ).toThrow(/Invalid producer output binding/);
  expect(() =>
    preflightPlan(
      [
        source,
        {
          ...consumer,
          inputs: {
            ...consumer.inputs,
            required: [
              { ...consumer.inputs.required[0], artifactType: "journey" },
            ],
          },
        },
      ],
      scopes,
      "org_local",
    ),
  ).toThrow(/Invalid producer output binding/);
});

test("rejects mixing a producer selector with fixed exact refs", () => {
  expect(() =>
    preflightPlan(
      [
        source,
        {
          ...consumer,
          inputs: {
            ...consumer.inputs,
            required: [
              {
                ...consumer.inputs.required[0],
                refs: [
                  {
                    artifactId: "art_direction",
                    revision: 1,
                    lockDigest: `sha256:${"a".repeat(64)}`,
                  },
                ],
              },
            ],
          },
        },
      ],
      scopes,
      "org_local",
    ),
  ).toThrow(/Invalid task input groups/);
});
