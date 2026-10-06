import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPrototypeModes,
  PrototypeModeError,
  type PrototypeModePlan,
} from "./index.js";
import { setupPrototypeModesFixture } from "../../../../fixtures/prototype-modes/approved.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: Parameters<typeof setupPrototypeModesFixture>[0] = {},
) {
  const value = await setupPrototypeModesFixture(options);
  roots.push(value.root);
  return value;
}
test("same scenario builds deterministically with exact System Request provenance", async () => {
  const first = await fixture();
  const result = await buildPrototypeModes(
    first.store,
    first.modePlan,
    first.root,
  );
  expect(result.fallback).toBeUndefined();
  const current = await readFile(
    path.join(result.current.directory, "index.html"),
    "utf8",
  );
  const proposed = await readFile(
    path.join(result.proposed!.directory, "index.html"),
    "utf8",
  );
  const comparison = JSON.parse(
    await readFile(
      path.join(result.comparisonDirectory, "comparison.json"),
      "utf8",
    ),
  );
  expect(current).not.toContain("Proposed, not implemented");
  expect(proposed).toContain("Proposed, not implemented");
  expect(proposed).toContain(first.modeRefs.request.artifactId);
  expect(comparison.modePlanDigest).toBe(result.modePlanDigest);
  expect(comparison.scenario).toEqual(first.modePlan.current.scenario);
  expect(comparison.review).toContain("not approved");
  const second = await fixture();
  const repeated = await buildPrototypeModes(
    second.store,
    second.modePlan,
    second.root,
  );
  expect(repeated.modePlanDigest).toBe(result.modePlanDigest);
  expect(
    await readFile(
      path.join(repeated.proposed!.directory, "index.html"),
      "utf8",
    ),
  ).toBe(proposed);
});
test("required choice needs approved request and proposed capability", async () => {
  const missing = await fixture({ choiceStatus: "required" });
  await expect(
    buildPrototypeModes(missing.store, missing.modePlan, missing.root),
  ).rejects.toMatchObject({
    code: "UNAPPROVED",
  });
  const accepted = await fixture({
    choiceStatus: "required",
    requestStatus: "approved",
    capabilityStatus: "approved",
  });
  const result = await buildPrototypeModes(
    accepted.store,
    accepted.modePlan,
    accepted.root,
  );
  expect(
    await readFile(path.join(result.proposed!.directory, "index.html"), "utf8"),
  ).toContain("Approved requirement, not implemented");
});
test.each([
  [{ requestStatus: "rejected" as const }, "rejected-system-request"],
  [{ capabilityStatus: "rejected" as const }, "rejected-capability"],
  [{ choiceStatus: "unresolved" as const }, "unresolved-choice"],
])(
  "rejected or unresolved choice falls back without changing authored intent",
  async (options, reason) => {
    const value = await fixture(options);
    const result = await buildPrototypeModes(
      value.store,
      value.modePlan,
      value.root,
    );
    expect(result.proposed).toBeUndefined();
    expect(result.fallback).toBe(reason);
    const saved = JSON.parse(
      await readFile(
        path.join(result.comparisonDirectory, "mode-plan.json"),
        "utf8",
      ),
    );
    expect(saved.proposedUses).toContain("candidateCompare");
  },
);
test("rejects wrong, stale, or mismatched exact references before output", async () => {
  const stale = await fixture({ staleContract: true });
  await expect(
    buildPrototypeModes(stale.store, stale.modePlan, stale.root),
  ).rejects.toMatchObject({ code: "UNAPPROVED" });
  const value = await fixture();
  const changed = (overrides: Partial<PrototypeModePlan>) => ({
    ...value.modePlan,
    ...overrides,
  });
  const wrong = {
    ...value.modeRefs.request,
    lockDigest: `sha256:${"0".repeat(64)}`,
  };
  await expect(
    buildPrototypeModes(
      value.store,
      changed({
        choices: [
          { ...value.modePlan.choices[0]! },
          { ...value.modePlan.choices[1]!, systemRequest: wrong },
        ],
      }),
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INTEGRITY" });
  await expect(
    buildPrototypeModes(
      value.store,
      changed({
        choices: [
          {
            ...value.modePlan.choices[0]!,
            capability: value.modeRefs.proposed,
          },
          value.modePlan.choices[1]!,
        ],
      }),
      value.root,
    ),
  ).rejects.toMatchObject({ code: "UNAPPROVED" });
  await expect(
    buildPrototypeModes(
      value.store,
      changed({
        proposed: {
          ...value.modePlan.proposed,
          scenario: value.modeRefs.contract,
        },
      }),
      value.root,
    ),
  ).rejects.toBeInstanceOf(PrototypeModeError);
  await expect(
    buildPrototypeModes(
      value.store,
      changed({
        currentUses: ["candidateList", "candidateCompare"],
      }),
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("snapshots the authored mode plan before asynchronous reads", async () => {
  const value = await fixture();
  const gate = Promise.withResolvers<void>();
  const store = new Proxy(value.store, {
    get(target, property) {
      if (property === "read")
        return async (id: string, revision: number) => {
          await gate.promise;
          return target.read(id, revision);
        };
      return Reflect.get(target, property);
    },
  });
  const input = structuredClone(value.modePlan);
  const pending = buildPrototypeModes(store, input, value.root);
  (input.choices as unknown as { id: string }[])[1]!.id = "changedAfterStart";
  gate.resolve();
  const result = await pending;
  const saved = JSON.parse(
    await readFile(
      path.join(result.comparisonDirectory, "mode-plan.json"),
      "utf8",
    ),
  );
  expect(saved.choices[1].id).toBe("candidateCompare");
});
test("rejects undeclared Current fixture data and actions", async () => {
  const value = await fixture();
  const current = structuredClone(value.modePlan.current);
  const state = current.states.find((entry) => entry.name === "success")!;
  (state.root.children as unknown as object[]).push({
    tag: "section",
    children: [
      { tag: "p", fixtureKey: "comparisonScore" },
      {
        tag: "button",
        componentId: value.refs.component.artifactId,
        text: "Compare candidates",
        targetState: "disabled",
      },
    ],
  });
  (current.fixtures.success as Record<string, string>).comparisonScore = "98";
  await expect(
    buildPrototypeModes(
      value.store,
      { ...value.modePlan, current },
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("rejects Proposed plans that remove bound Current functionality", async () => {
  const value = await fixture();
  const proposed = {
    ...value.modePlan.proposed,
    states: value.modePlan.proposed.states.map((state) => ({
      ...state,
      root: {
        tag: "main" as const,
        children: [
          {
            tag: "section" as const,
            children: [{ tag: "h2" as const, text: "Proposed only" }],
          },
        ],
      },
    })),
  };
  await expect(
    buildPrototypeModes(
      value.store,
      { ...value.modePlan, proposed },
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("invalid comparison path leaves no published mode bundles", async () => {
  const value = await fixture();
  await expect(
    buildPrototypeModes(
      value.store,
      { ...value.modePlan, comparisonPath: "../escape" },
      value.root,
    ),
  ).rejects.toMatchObject({ code: "PATH" });
  await expect(
    readFile(path.join(value.root, "current", "index.html")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(value.root, "proposed", "index.html")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test("occupied comparison is never reused or deleted on rejected fallback", async () => {
  const value = await fixture({ requestStatus: "rejected" });
  const stale = path.join(value.root, "comparison", "proposed", "index.html");
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, "STALE PROPOSED");
  await expect(
    buildPrototypeModes(value.store, value.modePlan, value.root),
  ).rejects.toMatchObject({ code: "PATH" });
  expect(await readFile(stale, "utf8")).toBe("STALE PROPOSED");
  await expect(
    readFile(path.join(value.root, "comparison", "current", "index.html")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test("fallback publishes a fresh comparison without exposing unrelated stale Proposed output", async () => {
  const value = await fixture({ requestStatus: "rejected" });
  const stale = path.join(value.root, "proposed", "index.html");
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, "STALE PROPOSED");
  const result = await buildPrototypeModes(
    value.store,
    value.modePlan,
    value.root,
  );
  expect(result.fallback).toBe("rejected-system-request");
  expect(result.proposed).toBeUndefined();
  expect(await readFile(stale, "utf8")).toBe("STALE PROPOSED");
  await expect(
    readFile(path.join(result.comparisonDirectory, "proposed", "index.html")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(path.join(result.current.directory, "index.html"), "utf8"),
  ).toContain("Specification prototype");
});
test("rejects sibling-product capability and unrelated token request", async () => {
  const other = await fixture();
  await expect(
    buildPrototypeModes(
      other.store,
      {
        ...other.modePlan,
        choices: [
          {
            ...other.modePlan.choices[0]!,
            capability: other.modeRefs.otherProduct,
          },
          other.modePlan.choices[1]!,
        ],
      },
      other.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
  const wrongLink = await fixture();
  await expect(
    buildPrototypeModes(
      wrongLink.store,
      {
        ...wrongLink.modePlan,
        choices: [
          wrongLink.modePlan.choices[0]!,
          {
            ...wrongLink.modePlan.choices[1]!,
            systemRequest: wrongLink.modeRefs.unlinkedRequest,
          },
        ],
        decisionContext: {
          kind: "live",
          requests: [wrongLink.modeRefs.unlinkedRequest],
        },
      },
      wrongLink.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
  const unrelated = await fixture({
    choiceStatus: "required",
    requestStatus: "approved",
    capabilityStatus: "approved",
    requestChangeType: "token",
  });
  await expect(
    buildPrototypeModes(unrelated.store, unrelated.modePlan, unrelated.root),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("live exact rejected decision context falls back; historical replay is labeled", async () => {
  const live = await fixture({
    choiceStatus: "required",
    requestStatus: "approved",
    capabilityStatus: "approved",
    laterRejectedDecision: true,
  });
  const result = await buildPrototypeModes(
    live.store,
    live.modePlan,
    live.root,
  );
  expect(result.fallback).toBe("rejected-system-request");
  expect(result.proposed).toBeUndefined();
  const historical = await fixture({
    choiceStatus: "required",
    requestStatus: "approved",
    capabilityStatus: "approved",
    laterRejectedDecision: true,
  });
  const replay = await buildPrototypeModes(
    historical.store,
    {
      ...historical.modePlan,
      decisionContext: { kind: "historical", requests: [] },
    },
    historical.root,
  );
  expect(replay.proposed).toBeDefined();
  expect(
    await readFile(path.join(replay.proposed!.directory, "index.html"), "utf8"),
  ).toContain("Proposed historical replay");
  const manifest = JSON.parse(
    await readFile(
      path.join(replay.comparisonDirectory, "comparison.json"),
      "utf8",
    ),
  );
  expect(manifest.decisionContext.kind).toBe("historical");
});
