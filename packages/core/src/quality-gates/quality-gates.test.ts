import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPrototype } from "../prototype-builder/index.js";
import { buildPrototypeModes } from "../prototype-modes/index.js";
import { canonicalJson } from "../artifact-canonical.js";
import type { ArtifactStore } from "../artifact-store.js";
import { setupApprovedPrototypeFixture } from "../../../../fixtures/prototypes/approved.js";
import { setupPrototypeModesFixture } from "../../../../fixtures/prototype-modes/approved.js";
import { inspectBundle, runStaticQualityGates } from "./index.js";
import { runBrowserQualityGates } from "./browser.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function built() {
  const fixture = await setupApprovedPrototypeFixture();
  roots.push(fixture.root);
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const input = {
    trustedRoot: fixture.root,
    directory: output.directory,
    store: fixture.store,
  };
  return { fixture, output, input };
}
async function rewritePlan(
  directory: string,
  change: (
    plan: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ) => void,
) {
  const planFile = path.join(directory, "plan.json");
  const manifestFile = path.join(directory, "manifest.json");
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  change(plan, manifest);
  manifest.planDigest = `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
  await writeFile(planFile, `${canonicalJson(plan)}\n`);
  await writeFile(manifestFile, `${canonicalJson(manifest)}\n`);
}
function state(
  findings: readonly { criterion: string; state: string }[],
  criterion: string,
): string {
  const result = findings.find((item) => item.criterion === criterion);
  if (!result) throw new Error(`Missing ${criterion}`);
  return result.state;
}

test("real generated bundle records exact target and scoped static results", async () => {
  const { input, fixture } = await built();
  const { report } = await runStaticQualityGates(input);
  expect(report.target.scenario).toEqual(fixture.refs.scenario);
  expect(report.target.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(report.action).toBe("inspect-only");
  for (const criterion of [
    "bundle-manifest",
    "source-locks",
    "artifact-validity",
    "token-resolution",
    "css-lint",
    "javascript-lint",
  ])
    expect(
      state(report.findings, criterion),
      JSON.stringify(
        report.findings.find((item) => item.criterion === criterion),
      ),
    ).toBe("PASS");
  expect(state(report.findings, "html-lint")).toBe("PASS");
  expect(state(report.findings, "ui-contract-consistency")).toBe("UNVERIFIED");
  expect(
    report.findings.find((item) => item.criterion === "ui-contract-consistency")
      ?.reason,
  ).toContain("No exact Product UI Contract");
  const wrongContract = await runStaticQualityGates({
    ...input,
    uiContract: fixture.refs.scenario,
  });
  expect(state(wrongContract.report.findings, "ui-contract-consistency")).toBe(
    "FAIL",
  );
});

test("generated mode Current and Proposed bundles pass their manifest gate", async () => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  for (const output of [modes.current, modes.proposed!]) {
    const result = await runStaticQualityGates({
      trustedRoot: fixture.root,
      directory: output.directory,
      store: fixture.store,
      uiContract: fixture.modeRefs.contract,
    });
    expect(state(result.report.findings, "bundle-manifest")).toBe("PASS");
    expect(state(result.report.findings, "source-locks")).toBe("PASS");
    expect(result.report.target.planDigest).toBe(output.planDigest);
  }
  const savedModePlan = JSON.parse(
    await readFile(
      path.join(modes.comparisonDirectory, "mode-plan.json"),
      "utf8",
    ),
  );
  const comparison = JSON.parse(
    await readFile(
      path.join(modes.comparisonDirectory, "comparison.json"),
      "utf8",
    ),
  );
  expect(savedModePlan).toEqual(fixture.modePlan);
  expect(comparison.modePlanDigest).toBe(modes.modePlanDigest);
  for (const [slot, output] of [
    ["current", modes.current],
    ["proposed", modes.proposed!],
  ] as const) {
    const savedPlan = JSON.parse(
      await readFile(path.join(output.directory, "plan.json"), "utf8"),
    );
    expect(savedPlan.outputPath).toBe(fixture.modePlan[slot].outputPath);
    expect(comparison[slot].planDigest).toBe(output.planDigest);
  }
});

test("rejected mode comparison verifies its published Current fallback", async () => {
  const fixture = await setupPrototypeModesFixture({
    requestStatus: "rejected",
  });
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  expect(modes.fallback).toBe("rejected-system-request");
  expect(modes.proposed).toBeUndefined();
  const { report } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: modes.current.directory,
    store: fixture.store,
    uiContract: fixture.modeRefs.contract,
  });
  expect(state(report.findings, "bundle-manifest")).toBe("PASS");
  const comparison = JSON.parse(
    await readFile(
      path.join(modes.comparisonDirectory, "comparison.json"),
      "utf8",
    ),
  );
  expect(comparison.proposed).toBeNull();
});

test("mode location uses authored slot names and rejects a moved comparison", async () => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const plan = {
    ...fixture.modePlan,
    current: { ...fixture.modePlan.current, outputPath: "before" },
    proposed: { ...fixture.modePlan.proposed, outputPath: "after" },
    comparisonPath: "alternatives",
  };
  const modes = await buildPrototypeModes(fixture.store, plan, fixture.root);
  const input = {
    trustedRoot: fixture.root,
    directory: modes.current.directory,
    store: fixture.store,
  };
  const initial = await runStaticQualityGates(input);
  expect(state(initial.report.findings, "bundle-manifest")).toBe("PASS");
  const moved = path.join(path.dirname(modes.comparisonDirectory), "relocated");
  await rename(modes.comparisonDirectory, moved);
  const relocated = await runStaticQualityGates({
    ...input,
    directory: path.join(moved, "before"),
  });
  expect(state(relocated.report.findings, "bundle-manifest")).toBe("FAIL");
});

test.each([
  {
    name: "comparison slot path",
    file: "comparison.json",
    change: (value: Record<string, unknown>) => {
      (value.current as Record<string, unknown>).path = "another-directory";
    },
  },
  {
    name: "Proposed slot path",
    file: "comparison.json",
    change: (value: Record<string, unknown>) => {
      (value.proposed as Record<string, unknown>).path = "another-directory";
    },
  },
  {
    name: "comparison mode digest",
    file: "comparison.json",
    change: (value: Record<string, unknown>) => {
      value.modePlanDigest = `sha256:${"0".repeat(64)}`;
    },
  },
  {
    name: "comparison bundle digest",
    file: "comparison.json",
    change: (value: Record<string, unknown>) => {
      (value.current as Record<string, unknown>).planDigest =
        `sha256:${"0".repeat(64)}`;
    },
  },
  {
    name: "authored mode path",
    file: "mode-plan.json",
    change: (value: Record<string, unknown>) => {
      (value.current as Record<string, unknown>).outputPath =
        "another-directory";
    },
  },
])("mode bundle rejects changed $name", async ({ file, change }) => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  const metadataFile = path.join(modes.comparisonDirectory, file);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  change(metadata);
  await writeFile(metadataFile, `${canonicalJson(metadata)}\n`);
  const input = {
    trustedRoot: fixture.root,
    directory: modes.current.directory,
    store: fixture.store,
  };
  const { report } = await runStaticQualityGates(input);
  expect(state(report.findings, "bundle-manifest")).toBe("FAIL");
  const browser = await runBrowserQualityGates(input);
  expect(state(browser.findings, "navigation-state")).toBe("FAIL");
});

test("mode bundle rejects a changed saved render path even with a matching manifest digest", async () => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  await rewritePlan(modes.current.directory, (plan) => {
    plan.outputPath = "another-directory";
  });
  const { report } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: modes.current.directory,
    store: fixture.store,
  });
  expect(state(report.findings, "bundle-manifest")).toBe("FAIL");
});

test("mode bundle rejects a changed authored path even with a matching mode-plan digest", async () => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  const modePlanFile = path.join(modes.comparisonDirectory, "mode-plan.json");
  const comparisonFile = path.join(
    modes.comparisonDirectory,
    "comparison.json",
  );
  const modePlan = JSON.parse(await readFile(modePlanFile, "utf8"));
  const comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
  modePlan.current.outputPath = "another-directory";
  comparison.modePlanDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(modePlan))
    .digest("hex")}`;
  await writeFile(modePlanFile, `${canonicalJson(modePlan)}\n`);
  await writeFile(comparisonFile, `${canonicalJson(comparison)}\n`);
  const { report } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: modes.current.directory,
    store: fixture.store,
  });
  expect(state(report.findings, "bundle-manifest")).toBe("FAIL");
});

test("controlled browser checks run on generated mode bundles", async () => {
  const fixture = await setupPrototypeModesFixture();
  roots.push(fixture.root);
  const modes = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  for (const output of [modes.current, modes.proposed!]) {
    const report = await runBrowserQualityGates({
      trustedRoot: fixture.root,
      directory: output.directory,
      store: fixture.store,
    });
    expect(state(report.findings, "browser-render")).toBe("PASS");
    expect(state(report.findings, "navigation-state")).toBe("PASS");
  }
}, 30_000);

test("generated single-main HTML passes and an extra main fails lint", async () => {
  const { input, output } = await built();
  const baseline = await runStaticQualityGates(input);
  expect(state(baseline.report.findings, "html-lint")).toBe("PASS");
  const htmlFile = path.join(output.directory, "index.html");
  await writeFile(
    htmlFile,
    (await readFile(htmlFile, "utf8")).replace(
      "</body>",
      "<main></main></body>",
    ),
  );
  const invalid = await runStaticQualityGates(input);
  expect(state(invalid.report.findings, "html-lint")).toBe("FAIL");
  expect(
    invalid.report.findings.find((item) => item.criterion === "html-lint")
      ?.reason,
  ).toContain("no-multiple-main");
  expect(invalid.report.target.bundleDigest).not.toBe(
    baseline.report.target.bundleDigest,
  );
});

test("tampered manifest, token CSS, HTML, JS and CSS produce independent findings", async () => {
  const { input, output } = await built();
  const manifestFile = path.join(output.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.planDigest = `sha256:${"0".repeat(64)}`;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const htmlFile = path.join(output.directory, "index.html");
  await writeFile(
    htmlFile,
    (await readFile(htmlFile, "utf8")).replace("<!doctype html>", "<html>"),
  );
  const cssFile = path.join(output.directory, "prototype.css");
  await writeFile(cssFile, "a { color: #zzzzzz; color: red; }");
  await writeFile(
    path.join(output.directory, "prototype.js"),
    "const unused = 1; missing();",
  );
  const { report } = await runStaticQualityGates(input);
  for (const criterion of [
    "bundle-manifest",
    "token-resolution",
    "html-lint",
    "css-lint",
    "javascript-lint",
  ])
    expect(
      state(report.findings, criterion),
      JSON.stringify(
        report.findings.find((item) => item.criterion === criterion),
      ),
    ).toBe("FAIL");
  expect(
    report.findings.find((item) => item.criterion === "css-lint")?.reason,
  ).toContain("color-no-invalid-hex");
});

test("missing source store remains UNVERIFIED and symlink output is rejected", async () => {
  const { input, output } = await built();
  const { report } = await runStaticQualityGates({
    trustedRoot: input.trustedRoot,
    directory: input.directory,
  });
  expect(state(report.findings, "artifact-validity")).toBe("UNVERIFIED");
  expect(state(report.findings, "token-resolution")).toBe("UNVERIFIED");
  await rm(path.join(output.directory, "prototype.js"));
  await symlink(
    path.join(output.directory, "prototype.css"),
    path.join(output.directory, "prototype.js"),
  );
  await expect(inspectBundle(input)).rejects.toThrow("Unsafe bundle file");
});

test("manifest token provenance mismatch is not accepted as a compiled token pass", async () => {
  const { input, output } = await built();
  const file = path.join(output.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.tokenProvenance = [];
  await writeFile(file, JSON.stringify(manifest));
  const { report } = await runStaticQualityGates(input);
  expect(state(report.findings, "source-locks")).toBe("PASS");
  expect(state(report.findings, "token-resolution")).toBe("FAIL");
  expect(report.target.files["manifest.json"]).toMatch(/^sha256:/);
});

test("malformed selection and empty states with valid plan digests cannot pass", async () => {
  const { input, output } = await built();
  const originalPlan = JSON.parse(
    await readFile(path.join(output.directory, "plan.json"), "utf8"),
  );
  await rewritePlan(output.directory, (plan) => {
    (plan.selection as Record<string, unknown>).components = {};
  });
  const malformed = await runStaticQualityGates(input);
  expect(state(malformed.report.findings, "bundle-manifest")).toBe("FAIL");
  expect(
    malformed.report.findings.find(
      (item) => item.criterion === "bundle-manifest",
    )?.reason,
  ).toContain("selection must contain exact");
  const malformedBrowser = await runBrowserQualityGates(input);
  expect(state(malformedBrowser.findings, "navigation-state")).toBe("FAIL");
  expect(state(malformedBrowser.findings, "axe")).toBe("UNVERIFIED");
  await rewritePlan(output.directory, (plan, manifest) => {
    (plan.selection as Record<string, unknown>).components =
      originalPlan.selection.components;
    plan.requiredStates = [];
    plan.states = [];
    manifest.requiredStates = [];
  });
  const empty = await runStaticQualityGates(input);
  expect(state(empty.report.findings, "bundle-manifest")).toBe("FAIL");
  expect(
    empty.report.findings.find((item) => item.criterion === "bundle-manifest")
      ?.reason,
  ).toContain("requiredStates must be nonempty");
  const emptyBrowser = await runBrowserQualityGates(input);
  expect(state(emptyBrowser.findings, "navigation-state")).toBe("FAIL");
  expect(state(emptyBrowser.findings, "axe")).toBe("UNVERIFIED");
});

test.each([
  {
    name: "missing title",
    expected: "title must be nonempty safe text",
    change: (plan: Record<string, unknown>) => {
      delete plan.title;
    },
  },
  {
    name: "missing required-state fixtures",
    expected: "fixtures.loading must be a field-to-text map",
    change: (plan: Record<string, unknown>) => {
      plan.fixtures = {};
    },
  },
  {
    name: "out-of-range mobile columns",
    expected: "layout must contain bounded breakpoint and column counts",
    change: (plan: Record<string, unknown>) => {
      (plan.layout as Record<string, unknown>).mobileColumns = -7;
    },
  },
  {
    name: "unsupported semantic tag",
    expected: "unsupported semantic tag blink",
    change: (plan: Record<string, unknown>) => {
      const states = plan.states as Array<{
        root: { children: Array<Record<string, unknown>> };
      }>;
      states[0]!.root.children[0]!.tag = "blink";
    },
  },
  {
    name: "non-text fixture-backed label",
    expected: "fixtures.loading.message must be safe text",
    change: (plan: Record<string, unknown>) => {
      const fixtures = plan.fixtures as Record<string, Record<string, unknown>>;
      fixtures.loading!.message = 23;
    },
  },
  {
    name: "blank interactive label",
    expected: "needs a discernible text label",
    change: (plan: Record<string, unknown>) => {
      const states = plan.states as Array<{
        root: {
          children: Array<{
            children: Array<Record<string, unknown>>;
          }>;
        };
      }>;
      const loadingButton = states[0]!.root.children[0]!.children.find(
        (node) => node.tag === "button",
      )!;
      loadingButton.text = " ";
    },
  },
  {
    name: "escaping output path",
    expected: "outputPath must be a contained relative directory",
    change: (plan: Record<string, unknown>) => {
      plan.outputPath = "../escape";
    },
  },
  {
    name: "different output directory",
    expected: "output directory",
    change: (plan: Record<string, unknown>) => {
      plan.outputPath = "different-generated-directory";
    },
  },
])(
  "generated plan with $name and recomputed digest cannot pass",
  async ({ change, expected }) => {
    const { input, output } = await built();
    await rewritePlan(output.directory, (plan) => change(plan));
    const { report } = await runStaticQualityGates(input);
    const manifest = report.findings.find(
      (item) => item.criterion === "bundle-manifest",
    );
    expect(manifest?.state).toBe("FAIL");
    expect(manifest?.reason).toContain(expected);
    const browser = await runBrowserQualityGates(input);
    expect(state(browser.findings, "navigation-state")).toBe("FAIL");
    expect(state(browser.findings, "axe")).toBe("UNVERIFIED");
  },
);

test("an approved artifact in the wrong scenario role fails validity", async () => {
  const { input, output, fixture } = await built();
  await rewritePlan(output.directory, (plan, manifest) => {
    plan.scenario = fixture.refs.pattern;
    manifest.scenario = fixture.refs.pattern;
  });
  const { report } = await runStaticQualityGates(input);
  expect(state(report.findings, "source-locks")).toBe("PASS");
  expect(state(report.findings, "artifact-validity")).toBe("FAIL");
  expect(
    report.findings.find((item) => item.criterion === "artifact-validity")
      ?.reason,
  ).toContain("expected scenario, got pattern");
});

test("transient source read failure is UNVERIFIED rather than a verified FAIL", async () => {
  const { input, fixture } = await built();
  const unavailable = new Proxy(fixture.store, {
    get(target, property, receiver) {
      if (property === "read")
        return async () => {
          throw Object.assign(new Error("temporary read outage"), {
            code: "EIO",
          });
        };
      return Reflect.get(target, property, receiver);
    },
  }) as ArtifactStore;
  const { report } = await runStaticQualityGates({
    ...input,
    store: unavailable,
  });
  expect(state(report.findings, "artifact-validity")).toBe("UNVERIFIED");
  expect(state(report.findings, "token-resolution")).toBe("UNVERIFIED");
});
