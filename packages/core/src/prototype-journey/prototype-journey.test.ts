import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { canonicalJson } from "../artifact-canonical.js";
import {
  buildPrototypeJourney,
  checkPrototypeJourneyPlan,
  materializeJourneyTransitions,
  type PrototypeJourneyInput,
} from "./index.js";
import { runStaticQualityGates } from "../quality-gates/index.js";
import { runBrowserQualityGates } from "../quality-gates/browser.js";
import { setupPrototypeJourney } from "../../../../fixtures/prototype-journey/setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const fixture = await setupPrototypeJourney();
  roots.push(fixture.root);
  return fixture;
}
test("compiles an exact, deterministic two-domain journey without sibling scenario locks", async () => {
  const fixture = await setup();
  const output = await buildPrototypeJourney(
    fixture.store,
    fixture.journeyPlan,
    fixture.root,
  );
  const plan = JSON.parse(
    await readFile(output.directory + "/plan.json", "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(output.directory + "/manifest.json", "utf8"),
  );
  const html = await readFile(output.directory + "/index.html", "utf8");
  const js = await readFile(output.directory + "/prototype.js", "utf8");
  expect(canonicalJson(plan)).toBe(canonicalJson(fixture.journeyPlan));
  expect(manifest.planDigest).toBe(output.planDigest);
  expect(manifest.views.map((view: { id: string }) => view.id)).toEqual([
    "queue",
    "review",
  ]);
  expect(html.match(/<main>/g)).toHaveLength(1);
  expect(html).toContain('id="queue__queue-filter"');
  expect(html).toContain('id="review__draft-note"');
  expect(js).not.toMatch(/\beval\s*\(|\bfetch\s*\(/);
  expect(
    fixture.queueScenario.artifact.dependencies.some(
      (entry) => entry.artifactId === fixture.domains[1]!.ref.artifactId,
    ),
  ).toBe(false);
});
test("distinct view nodes stay namespaced while ambiguous cross-view DOM IDs fail closed", async () => {
  const fixture = await setup();
  const base = fixture.journeyPlan;
  const queue = base.views[0]!;
  const sharedNode = {
    tag: "p" as const,
    id: "case-identity",
    text: "Queue identity",
  };
  const shared = {
    ...base,
    outputPath: "shared-logical-id",
    views: [
      {
        ...queue,
        render: {
          ...queue.render,
          states: queue.render.states.map((state) =>
            state.name === "success"
              ? {
                  ...state,
                  root: {
                    ...state.root,
                    children: [...(state.root.children ?? []), sharedNode],
                  },
                }
              : state,
          ),
        },
      },
      base.views[1]!,
    ],
  };
  const output = await buildPrototypeJourney(
    fixture.store,
    shared,
    fixture.root,
  );
  const html = await readFile(output.directory + "/index.html", "utf8");
  expect(html).toContain('id="queue__case-identity"');
  expect(html).toContain('id="review__case-identity"');
  const colliding = {
    ...shared,
    views: [
      {
        ...shared.views[0]!,
        render: {
          ...shared.views[0]!.render,
          states: shared.views[0]!.render.states.map((state) =>
            state.name === "success"
              ? {
                  ...state,
                  root: {
                    ...state.root,
                    children: [
                      ...(state.root.children ?? []),
                      {
                        tag: "p" as const,
                        id: "review__draft-note",
                        text: "Collision",
                      },
                    ],
                  },
                }
              : state,
          ),
        },
      },
      { ...base.views[1]!, id: "queue__review", route: "#queue-review" },
    ],
  };
  expect(checkPrototypeJourneyPlan(colliding).errors.join(" ")).toContain(
    "Rendered DOM ID collision",
  );
});
test("same-target semantic transitions receive distinct stable emitted identities", async () => {
  const fixture = await setup();
  const review = fixture.journeyPlan.views[1]!;
  const transitions = materializeJourneyTransitions(review).transitions;
  expect(new Set(transitions.map((item) => item.nodeId)).size).toBe(
    transitions.length,
  );
  expect(transitions.some((item) => item.nodeId === "show-error")).toBe(true);
  expect(
    transitions.some((item) => item.nodeId.startsWith("journey-transition-")),
  ).toBe(true);
});
test("rejects malformed journey declarations, out-of-scope locks, and caller mutation", async () => {
  const fixture = await setup();
  const base = fixture.journeyPlan;
  const invalid: PrototypeJourneyInput[] = [
    { ...base, version: 2 as 1 },
    { ...base, filterEmpty: { viewId: "review", nodeId: "missing" } },
    {
      ...base,
      views: [
        { ...base.views[0]!, route: "https://example.com" },
        base.views[1]!,
      ],
    },
    {
      ...base,
      controls: [
        ...base.controls,
        { viewId: "review", nodeId: "missing", action: { kind: "return" } },
      ],
    },
    {
      ...base,
      controls: [
        ...base.controls,
        {
          viewId: "review",
          nodeId: "return-success",
          action: { kind: "execute" as "return" },
        },
      ],
    },
    {
      ...base,
      controls: [
        ...base.controls,
        {
          viewId: "review",
          nodeId: "return-success",
          action: { kind: "edit-draft", field: "approvalStatus" },
        },
      ],
    },
    {
      ...base,
      views: [
        { ...base.views[0]!, domain: fixture.domains[1]!.ref },
        base.views[1]!,
      ],
    },
    {
      ...base,
      journey: { ...base.journey, lockDigest: "sha256:" + "0".repeat(64) },
    },
    {
      ...base,
      rows: [
        ...base.rows,
        { viewId: "review", nodeId: "missing-row", entityId: "C-204" },
      ],
    },
    {
      ...base,
      texts: [
        ...base.texts,
        {
          viewId: "review",
          nodeId: "case-identity",
          source: "selected-field",
          field: "unknown",
        },
      ],
    },
    {
      ...base,
      entities: [
        {
          ...base.entities[0]!,
          fields: {
            ...base.entities[0]!.fields,
            status: 42 as unknown as string,
          },
        },
        ...base.entities.slice(1),
      ],
    },
    {
      ...base,
      views: [
        {
          ...base.views[0]!,
          render: {
            ...base.views[0]!.render,
            states: base.views[0]!.render.states.map((state) =>
              state.name === "success"
                ? { ...state, root: { ...state.root, id: "bad id" } }
                : state,
            ),
          },
        },
        base.views[1]!,
      ],
    },
  ];
  for (const [index, candidate] of invalid.entries()) {
    await expect(
      buildPrototypeJourney(
        fixture.store,
        { ...candidate, outputPath: "bad-" + index },
        fixture.root,
      ),
    ).rejects.toBeInstanceOf(Error);
  }
  const mutable = structuredClone(base);
  const pending = buildPrototypeJourney(fixture.store, mutable, fixture.root);
  (mutable.entities[0]!.drafts as { note: string }).note = "mutated";
  const result = await pending;
  const saved = await readFile(result.directory + "/plan.json", "utf8");
  expect(saved).not.toContain("mutated");
});

test("static gates bind the final journey bytes to exact approved sources", async () => {
  const fixture = await setup();
  const output = await buildPrototypeJourney(
    fixture.store,
    fixture.journeyPlan,
    fixture.root,
  );
  const run = () =>
    runStaticQualityGates({
      trustedRoot: fixture.root,
      directory: output.directory,
      store: fixture.store,
      uiContract: fixture.contract.ref,
    });
  const { report } = await run();
  const states = Object.fromEntries(
    report.findings.map((finding) => [finding.criterion, finding.state]),
  );
  expect(states).toMatchObject({
    "bundle-manifest": "PASS",
    "source-locks": "PASS",
    "artifact-validity": "PASS",
    "finite-actions": "PASS",
    "html-lint": "PASS",
    "javascript-lint": "PASS",
    "css-lint": "PASS",
    "ui-contract-consistency": "CONCERN",
  });
  await rm(output.directory + "/prototype.js");
  await expect(run()).rejects.toThrow();
});

test("tampered or unverified journey observations never pass the gates", async () => {
  const fixture = await setup();
  const output = await buildPrototypeJourney(
    fixture.store,
    fixture.journeyPlan,
    fixture.root,
  );
  const withoutStore = await runBrowserQualityGates({
    trustedRoot: fixture.root,
    directory: output.directory,
  });
  expect(
    withoutStore.findings.every((finding) => finding.state === "UNVERIFIED"),
  ).toBe(true);
  const js = await readFile(output.directory + "/prototype.js", "utf8");
  await writeFile(
    output.directory + "/prototype.js",
    js + "\n/* tampered */\n",
  );
  const { report } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: output.directory,
    store: fixture.store,
    uiContract: fixture.contract.ref,
  });
  expect(
    report.findings.find((finding) => finding.criterion === "source-locks")
      ?.state,
  ).toBe("FAIL");
  expect(
    report.findings.find((finding) => finding.criterion === "finite-actions")
      ?.state,
  ).toBe("FAIL");
});
