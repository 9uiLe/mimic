import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPrototype } from "./index.js";
import { publishPrototypeBundle } from "./output.js";
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

test("rejects a transition to an unrendered state even when an extra fixture exists", async () => {
  const { root, store, input } = await setup();
  const plan = change(input);
  (plan as { initialState: string }).initialState = "success";
  (plan as unknown as { requiredStates: string[] }).requiredStates = [
    "success",
  ];
  (plan as unknown as { states: typeof plan.states }).states =
    plan.states.filter((state) => state.name === "success");
  await expect(buildPrototype(store, plan, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
    upstreamRevisionRequest: expect.stringContaining("transition target"),
  });
});

test("reserves the generated status element ID from authored nodes", async () => {
  const { root, store, input } = await setup();
  const plan = change(input);
  (plan.states[0]!.root.children![0]!.children![0] as { id?: string }).id =
    "prototype-status";
  await expect(buildPrototype(store, plan, root)).rejects.toMatchObject({
    code: "INVALID",
  });
});

test("preserves an occupied output directory and permits retry when emptied", async () => {
  const { root, store, input } = await setup();
  const directory = path.join(root, "generated");
  await mkdir(directory);
  const manifest = path.join(directory, "manifest.json");
  await writeFile(manifest, "preexisting manifest", "utf8");
  await expect(buildPrototype(store, input, root)).rejects.toMatchObject({
    code: "PATH",
  });
  expect(await readFile(manifest, "utf8")).toBe("preexisting manifest");
  expect(await readdir(directory)).toEqual(["manifest.json"]);
  await rm(manifest);
  const result = await buildPrototype(store, input, root);
  expect(result.directory).toBe(await realpath(directory));
  expect((await readdir(directory)).sort()).toEqual([...result.files].sort());
});

test("accepts S14 digest-bearing composition evidence with an approved conforming fixture", async () => {
  const fixture = await setupApprovedPrototypeFixture({
    compositionEvidence: "s14",
  });
  roots.push(fixture.root);
  const result = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  expect(result.files).toContain("index.html");
});

test("rejects an incorrect digest in linked S14 composition evidence", async () => {
  const fixture = await setupApprovedPrototypeFixture({
    compositionEvidence: "s14-wrong-digest",
  });
  roots.push(fixture.root);
  await expect(
    buildPrototype(fixture.store, fixture.input, fixture.root),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
});

test("cleans staged files after a later write fails and allows a clean retry", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "mimic-prototype-publication-"),
  );
  roots.push(root);
  const files = {
    "index.html": "html",
    "prototype.css": "css",
    "manifest.json": "manifest",
  };
  let writes = 0;
  await expect(
    publishPrototypeBundle(root, "generated", files, async (file, contents) => {
      writes += 1;
      if (writes === 3) throw new Error("injected late write failure");
      await writeFile(file, contents, { flag: "wx" });
    }),
  ).rejects.toThrow("injected late write failure");
  expect(await readdir(root)).toEqual([]);
  const directory = await publishPrototypeBundle(root, "generated", files);
  expect((await readdir(directory)).sort()).toEqual(Object.keys(files).sort());
});

test("rejects nested interactive controls and empty descendant labels", async () => {
  const { root, store, input } = await setup();
  const nested = change(input);
  const outer = nested.states[0]!.root.children![0]!.children![2]! as {
    children?: unknown[];
  };
  outer.children = [
    {
      tag: "button",
      componentId: input.selection.components[0]!.artifactId,
      text: "Nested",
      targetState: "success",
    },
  ];
  await expect(buildPrototype(store, nested, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
  const empty = change(input);
  const button = empty.states[0]!.root.children![0]!.children![2]! as {
    text?: string;
    children?: unknown[];
  };
  delete button.text;
  button.children = [{ tag: "span" }];
  await expect(buildPrototype(store, empty, root)).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
  });
});

test("requires actual strings for authored DOM IDs and text attributes", async () => {
  const { root, store, input } = await setup();
  for (const invalid of [
    ["prototype-status"],
    { value: "prototype-status" },
    123,
  ]) {
    const plan = change(input);
    (
      plan.states[0]!.root.children![0]!.children![0] as unknown as {
        id: unknown;
      }
    ).id = invalid;
    await expect(buildPrototype(store, plan, root)).rejects.toMatchObject({
      code: "INVALID",
    });
  }
  const fixtureKey = change(input);
  (
    fixtureKey.states[0]!.root.children![0]!.children![1] as unknown as {
      fixtureKey: unknown;
    }
  ).fixtureKey = ["message"];
  await expect(buildPrototype(store, fixtureKey, root)).rejects.toMatchObject({
    code: "INVALID",
  });
  const unsafeHref = change(input);
  (
    unsafeHref.states[0]!.root.children![0]!.children![0] as { id?: string }
  ).id = "valid-heading";
  (
    unsafeHref.states[0]!.root.children![0]!.children![1] as unknown as {
      tag: string;
      fixtureKey?: string;
      href: unknown;
      text: string;
    }
  ).tag = "a";
  const link = unsafeHref.states[0]!.root.children![0]!
    .children![1] as unknown as {
    fixtureKey?: string;
    href: unknown;
    text: string;
  };
  delete link.fixtureKey;
  link.text = "Open heading";
  link.href = ["#valid-heading"];
  await expect(buildPrototype(store, unsafeHref, root)).rejects.toMatchObject({
    code: "INVALID",
  });
  const valid = change(input);
  (valid.states[0]!.root.children![0]!.children![0] as { id?: string }).id =
    "valid-heading";
  const result = await buildPrototype(store, valid, root);
  expect(
    await readFile(path.join(result.directory, "index.html"), "utf8"),
  ).toContain('id="valid-heading"');
});
