import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../artifact-canonical.js";
import { buildPrototype, type PrototypeBuilderInput } from "./index.js";
import { responsiveErrors } from "./responsive.js";
import { setupResponsiveFixture } from "../../../../fixtures/prototype-responsive/approved.js";
import { runStaticQualityGates } from "../quality-gates/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const value = await setupResponsiveFixture();
  roots.push(value.root);
  return value;
}
function changed(
  input: PrototypeBuilderInput,
  change: (plan: unknown) => void,
): PrototypeBuilderInput {
  const copy = structuredClone(input);
  change(copy);
  return copy;
}
function at(
  value: unknown,
  path: readonly (string | number)[],
): Record<string, unknown> {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object")
      throw new Error("Invalid test path");
    current = (current as Record<string, unknown>)[String(part)];
  }
  if (!current || typeof current !== "object" || Array.isArray(current))
    throw new Error("Invalid test object");
  return current as Record<string, unknown>;
}
const operation = (plan: unknown, index: number) =>
  at(plan, ["responsive", "states", 0, "operations", index]);
function withNestedReplacements(
  input: PrototypeBuilderInput,
  order: "ancestor-first" | "descendant-first" | "independent",
): PrototypeBuilderInput {
  return changed(input, (plan) => {
    const root = at(plan, ["states", 3, "root"]);
    (root.children as unknown[]).push({
      tag: "section",
      id: "auxiliary",
      children: [
        {
          tag: "article",
          id: "nested-parent",
          children: [
            {
              tag: "p",
              id: "nested-child",
              children: [
                {
                  tag: "span",
                  id: "nested-grandchild",
                  text: "Auxiliary context",
                },
              ],
            },
          ],
        },
        {
          tag: "article",
          id: "sibling-parent",
          children: [{ tag: "p", text: "Independent context" }],
        },
      ],
    });
    (operation(plan, 0).childIds as unknown[]).push("auxiliary");
    const ancestor = {
      kind: "replace",
      targetId: "nested-parent",
      with: {
        tag: "article",
        id: "mobile-parent",
        children: [{ tag: "p", text: "Mobile context" }],
      },
      focusMap: [],
    };
    const descendant = {
      kind: "replace",
      targetId: "nested-child",
      with: { tag: "p", id: "mobile-child", text: "Mobile child" },
      focusMap: [],
    };
    const independent = {
      kind: "replace",
      targetId: "sibling-parent",
      with: {
        tag: "article",
        id: "mobile-sibling",
        children: [{ tag: "p", text: "Independent mobile context" }],
      },
      focusMap: [],
    };
    (at(plan, ["responsive", "states", 0]).operations as unknown[]).push(
      ...(order === "ancestor-first"
        ? [ancestor, descendant]
        : order === "descendant-first"
          ? [descendant, ancestor]
          : [ancestor, independent]),
    );
  });
}
test("versioned mobile operations are saved, digested and statically verified", async () => {
  const value = await fixture();
  const before = canonicalJson(value.input);
  const output = await buildPrototype(value.store, value.input, value.root);
  const saved = JSON.parse(
    await readFile(path.join(output.directory, "plan.json"), "utf8"),
  );
  expect(saved).toEqual(value.input);
  expect(output.planDigest).toBe(
    `sha256:${createHash("sha256").update(before).digest("hex")}`,
  );
  expect(
    await readFile(path.join(output.directory, "prototype.js"), "utf8"),
  ).toContain("responsiveProgram");
  const staticResult = await runStaticQualityGates({
    trustedRoot: value.root,
    directory: output.directory,
    store: value.store,
  });
  for (const criterion of [
    "bundle-manifest",
    "source-locks",
    "html-lint",
    "javascript-lint",
  ])
    expect(
      staticResult.report.findings.find((item) => item.criterion === criterion)
        ?.state,
      JSON.stringify(
        staticResult.report.findings.find(
          (item) => item.criterion === criterion,
        ),
      ),
    ).toBe("PASS");
  expect(canonicalJson(value.input)).toBe(before);
});
test.each([
  [
    "unknown operation",
    (p: unknown) => {
      operation(p, 0).kind = "custom-js";
    },
  ],
  [
    "wrong rule",
    (p: unknown) => {
      at(p, ["responsive", "states", 0]).rule = {
        ...at(p, ["responsive", "states", 0, "rule"]),
        lockDigest: `sha256:${"0".repeat(64)}`,
      };
    },
  ],
  [
    "missing order member",
    (p: unknown) => {
      (operation(p, 0).childIds as unknown[]).pop();
    },
  ],
  [
    "foreign target",
    (p: unknown) => {
      operation(p, 1).targetId = "foreign";
    },
  ],
  [
    "foreign replacement",
    (p: unknown) => {
      operation(p, 3).targetId = "foreign";
    },
  ],
  [
    "missing continuity",
    (p: unknown) => {
      at(p, [
        "responsive",
        "states",
        0,
        "continuity",
        "primaryAction",
      ]).mobileId = "missing";
    },
  ],
  [
    "unmapped focus",
    (p: unknown) => {
      operation(p, 3).focusMap = [];
    },
  ],
  [
    "unselected component",
    (p: unknown) => {
      at(p, ["responsive", "states", 0, "operations", 3, "with"]).componentId =
        "art_other";
    },
  ],
  [
    "unmapped idless replacement action",
    (p: unknown) => {
      delete at(p, ["responsive", "states", 0, "operations", 3, "with"]).id;
    },
  ],
  [
    "unsupported subtree field",
    (p: unknown) => {
      at(p, ["responsive", "states", 0, "operations", 3, "with"]).onClick =
        "evil()";
    },
  ],
])("rejects %s before publishing", async (_name, mutate) => {
  const value = await fixture();
  const input = changed(value.input, mutate);
  expect(responsiveErrors(input).length).toBeGreaterThan(0);
  await expect(
    buildPrototype(value.store, input, value.root),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("responsive declarations are snapshotted before the first asynchronous read", async () => {
  const value = await fixture();
  const input = changed(value.input, () => {});
  const build = buildPrototype(value.store, input, value.root);
  (input.responsive!.states[0]!.operations[1] as { summary: string }).summary =
    "Changed after invocation";
  const output = await build;
  const saved = JSON.parse(
    await readFile(path.join(output.directory, "plan.json"), "utf8"),
  );
  expect(saved.responsive.states[0].operations[1].summary).toBe(
    "Candidate identity",
  );
});
test.each(["ancestor-first", "descendant-first"] as const)(
  "rejects overlapping replacement targets in %s order",
  async (order) => {
    const value = await fixture();
    const input = withNestedReplacements(value.input, order);
    expect(responsiveErrors(input)).toContainEqual(
      expect.stringContaining("replacement removes another operation target"),
    );
    await expect(
      buildPrototype(value.store, input, value.root),
    ).rejects.toMatchObject({ code: "INVALID" });
  },
);
test("independent replacement targets remain valid", async () => {
  const value = await fixture();
  const input = withNestedReplacements(value.input, "independent");
  expect(responsiveErrors(input)).toEqual([]);
  await expect(
    buildPrototype(value.store, input, value.root),
  ).resolves.toMatchObject({ planDigest: expect.stringMatching(/^sha256:/) });
});
test("an outer replacement cannot leave a removed grandchild as mobile critical information", async () => {
  const value = await fixture();
  const input = changed(
    withNestedReplacements(value.input, "independent"),
    (plan) => {
      (at(plan, ["responsive", "states", 0]).operations as unknown[]).pop();
      at(plan, ["responsive", "states", 0, "continuity"]).criticalInfo = [
        { desktopId: "nested-grandchild", mobileId: "nested-grandchild" },
      ];
    },
  );
  expect(responsiveErrors(input)).toContainEqual(
    expect.stringContaining("missing mapped node"),
  );
  await expect(
    buildPrototype(value.store, input, value.root),
  ).rejects.toMatchObject({ code: "INVALID" });
});
test("saved-plan tampering fails static gate even if digest is recomputed", async () => {
  const value = await fixture();
  const output = await buildPrototype(value.store, value.input, value.root);
  const planFile = path.join(output.directory, "plan.json");
  const manifestFile = path.join(output.directory, "manifest.json");
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  plan.responsive.states[0].operations[0].childIds = ["candidate-actions"];
  manifest.planDigest = `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
  await writeFile(planFile, `${canonicalJson(plan)}\n`);
  await writeFile(manifestFile, `${canonicalJson(manifest)}\n`);
  const result = await runStaticQualityGates({
    trustedRoot: value.root,
    directory: output.directory,
    store: value.store,
  });
  expect(
    result.report.findings.find((item) => item.criterion === "bundle-manifest")
      ?.state,
  ).toBe("FAIL");
});
