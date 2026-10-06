import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
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
