import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { buildPrototypeJourneyModes } from "./journey.js";
import { runStaticQualityGates } from "../quality-gates/index.js";
import { setupPrototypeJourney } from "../../../../fixtures/prototype-journey/setup.js";
import { authoredJourneyModes } from "../../../../fixtures/prototype-journey/modes.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
async function fixture(options: { rejectedRequest?: boolean } = {}) {
  const value = await setupPrototypeJourney({ ...options, withModes: true });
  roots.push(value.root);
  return value;
}
test("journey Modes bind every visible action and keep notices in every Proposed view and state", async () => {
  const value = await fixture();
  const modes = authoredJourneyModes(value);
  const result = await buildPrototypeJourneyModes(
    value.store,
    modes,
    value.root,
  );
  expect(result.fallback).toBeUndefined();
  expect(result.proposed).toBeDefined();
  for (const directory of [
    result.current.directory,
    result.proposed!.directory,
  ]) {
    const { report } = await runStaticQualityGates({
      trustedRoot: value.root,
      directory,
      store: value.store,
      uiContract: value.contract.ref,
    });
    expect(
      report.findings.find((item) => item.criterion === "bundle-manifest")
        ?.state,
    ).toBe("PASS");
    expect(
      report.findings.find((item) => item.criterion === "source-locks")?.state,
    ).toBe("PASS");
  }
  const current = await readFile(
    result.current.directory + "/index.html",
    "utf8",
  );
  const proposed = await readFile(
    result.proposed!.directory + "/index.html",
    "utf8",
  );
  expect(current).not.toContain("proposed-preview");
  expect(proposed).toContain("Preview proposed assistance");
  expect(proposed.match(/System mode: Proposed/g)).toHaveLength(
    modes.proposed.views.reduce(
      (count, view) => count + view.render.requiredStates.length,
      0,
    ),
  );
  const bad = {
    ...modes,
    bindings: {
      ...modes.bindings,
      proposed: modes.bindings.proposed.slice(0, -1),
    },
  };
  await expect(
    buildPrototypeJourneyModes(
      value.store,
      { ...bad, comparisonPath: "bad-mode" },
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
  const changed = structuredClone(modes);
  const target = changed.proposed.views[1]!.render.states.find(
    (state) => state.name === "success",
  )!.root.children!.find((node) => node.id === "review-decision")!;
  (target.children![0] as { text: string }).text = "Changed Current label";
  await expect(
    buildPrototypeJourneyModes(
      value.store,
      { ...changed, comparisonPath: "changed-mode" },
      value.root,
    ),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("rejected System Request cannot emit the Proposed action", async () => {
  const value = await fixture({ rejectedRequest: true });
  const result = await buildPrototypeJourneyModes(
    value.store,
    authoredJourneyModes(value),
    value.root,
  );
  expect(result.fallback).toBe("rejected-system-request");
  expect(result.proposed).toBeUndefined();
  const current = await readFile(
    result.current.directory + "/index.html",
    "utf8",
  );
  expect(current).not.toContain("proposed-preview");
});
