import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPrototype } from "./index.js";
import { setupApprovedPrototypeFixture } from "../../../../fixtures/prototypes/approved.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const fixture = await setupApprovedPrototypeFixture();
  roots.push(fixture.root);
  return fixture;
}
function change<T>(value: T): T {
  return structuredClone(value);
}

test("generates deterministic semantic prototype with exact provenance and synthetic fixtures", async () => {
  const { root, store, input, refs } = await setup();
  const first = await buildPrototype(store, input, root);
  const html = await readFile(path.join(first.directory, "index.html"), "utf8");
  const css = await readFile(
    path.join(first.directory, "prototype.css"),
    "utf8",
  );
  const manifest = JSON.parse(
    await readFile(path.join(first.directory, "manifest.json"), "utf8"),
  );
  expect(html).toContain(
    "Specification prototype · synthetic fixture data · not a production app",
  );
  expect(html).toContain("Synthetic candidate ready");
  expect(css).toContain(
    "--mimic-semantic-color-text: var(--mimic-primitive-color-ink)",
  );
  expect(manifest.scenario).toEqual(refs.scenario);
  expect(manifest.tokenSources).toEqual([refs.token]);
  expect(manifest.planDigest).toBe(first.planDigest);
  const secondRoot = await mkdtemp(
    path.join(os.tmpdir(), "mimic-prototype-again-"),
  );
  roots.push(secondRoot);
  const second = await buildPrototype(store, input, secondRoot);
  for (const file of first.files)
    expect(await readFile(path.join(first.directory, file))).toEqual(
      await readFile(path.join(second.directory, file)),
    );
});

test("rejects unsafe markup, URLs, scripts and output escapes", async () => {
  const { root, store, input } = await setup();
  const markup = change(input);
  (
    markup.states[0]!.root.children![0]!.children![1] as {
      text?: string;
      fixtureKey?: string;
    }
  ).text = "<img src=x onerror=alert(1)>";
  delete (
    markup.states[0]!.root.children![0]!.children![1] as { fixtureKey?: string }
  ).fixtureKey;
  const result = await buildPrototype(store, markup, root);
  expect(
    await readFile(path.join(result.directory, "index.html"), "utf8"),
  ).toContain("&lt;img src=x onerror=alert(1)&gt;");
  const bad = change(input);
  (bad.states[0]!.root.children![0]!.children![1] as { href?: string }).href =
    "javascript:alert(1)";
  await expect(buildPrototype(store, bad, root)).rejects.toMatchObject({
    code: "INVALID",
  });
  const script = change(input);
  (script.states[0]!.root.children![0]!.children![1] as { tag: string }).tag =
    "script";
  await expect(buildPrototype(store, script, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
  const escape = change(input);
  (escape as { outputPath: string }).outputPath = "../escape";
  await expect(buildPrototype(store, escape, root)).rejects.toMatchObject({
    code: "PATH",
  });
});

test("rejects absent structure, exact lock changes and unsupported actions", async () => {
  const { root, store, input } = await setup();
  const missing = change(input);
  (missing as unknown as { states: unknown[] }).states = [];
  await expect(buildPrototype(store, missing, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
  const lock = change(input);
  (lock.selection.pattern as { lockDigest: string }).lockDigest =
    `sha256:${"0".repeat(64)}`;
  await expect(buildPrototype(store, lock, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
  const action = change(input);
  (
    action.states[0]!.root.children![0]!.children![2] as { targetState: string }
  ).targetState = "deleted";
  await expect(buildPrototype(store, action, root)).rejects.toMatchObject({
    code: "INVALID",
  });
  const noTokens = change(input);
  (noTokens as unknown as { tokenSources: unknown[] }).tokenSources = [];
  await expect(buildPrototype(store, noTokens, root)).rejects.toThrow();
});

test("copies mutable input before asynchronous reads", async () => {
  const { root, store, input } = await setup();
  const mutable = change(input);
  const pending = buildPrototype(store, mutable, root);
  (mutable as { title: string }).title = "changed after call";
  const result = await pending;
  expect(
    await readFile(path.join(result.directory, "index.html"), "utf8"),
  ).toContain("Synthetic candidate comparison");
  expect(
    await readFile(path.join(result.directory, "index.html"), "utf8"),
  ).not.toContain("changed after call");
});

test("rejects unapproved scenario despite matching exact digest", async () => {
  const fixture = await setupApprovedPrototypeFixture({
    scenarioApproved: false,
  });
  roots.push(fixture.root);
  await expect(
    buildPrototype(fixture.store, fixture.input, fixture.root),
  ).rejects.toMatchObject({ code: "UNAPPROVED" });
});

test("rejects an output directory symlink", async () => {
  const { root, store, input } = await setup();
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "mimic-prototype-outside-"),
  );
  roots.push(outside);
  await symlink(outside, path.join(root, "generated"));
  await expect(buildPrototype(store, input, root)).rejects.toMatchObject({
    code: "PATH",
  });
});
