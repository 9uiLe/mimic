import { afterEach, expect, test } from "vitest";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPrototype } from "../prototype-builder/index.js";
import { setupApprovedPrototypeFixture } from "../../../../fixtures/prototypes/approved.js";
import { inspectBundle, runStaticQualityGates } from "./index.js";

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
  expect(state(report.findings, "html-lint")).toBe("FAIL");
  expect(
    report.findings.find((item) => item.criterion === "html-lint")?.reason,
  ).toContain("no-multiple-main");
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
