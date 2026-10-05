import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSchemas } from "./check-schemas.mjs";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-spec-ci-"));
  temporaryRoots.push(root);
  return root;
}

async function putJson(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function sampleTree() {
  const root = await tempRoot();
  await putJson(root, "schemas/artifacts/artifact.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://mimic.test/artifact",
    type: "object",
    properties: { count: { $ref: "https://mimic.test/common" } },
    required: ["count"],
    additionalProperties: false,
  });
  await putJson(root, "schemas/artifacts/common.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://mimic.test/common",
    type: "integer",
    minimum: 1,
  });
  await putJson(root, "fixtures/artifacts/valid/one.json", { count: 1 });
  await putJson(root, "fixtures/artifacts/invalid/zero.json", { count: 0 });
  return root;
}

test("valid and invalid fixtures are checked against the same schema", async () => {
  assert.deepEqual(await checkSchemas(await sampleTree()), {
    schemas: 2,
    valid: 1,
    invalid: 1,
  });
});

test("a bad positive or falsely negative fixture fails", async () => {
  const root = await sampleTree();
  await putJson(root, "fixtures/artifacts/valid/one.json", { count: 0 });
  await assert.rejects(checkSchemas(root), /expected valid/);
  await putJson(root, "fixtures/artifacts/valid/one.json", { count: 1 });
  await putJson(root, "fixtures/artifacts/invalid/zero.json", { count: 1 });
  await assert.rejects(checkSchemas(root), /expected invalid/);
});

test("malformed schema and missing negative fixtures fail", async () => {
  const root = await sampleTree();
  await putJson(root, "schemas/artifacts/common.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "made-up-type",
  });
  await assert.rejects(checkSchemas(root), /Invalid schema/);
  const other = await tempRoot();
  await putJson(other, "schemas/artifacts/artifact.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  });
  await putJson(other, "fixtures/artifacts/valid/one.json", {});
  await assert.rejects(
    checkSchemas(other),
    /at least one valid and one invalid/,
  );
});

test("unpaired fixtures cannot be ignored", async () => {
  const root = await sampleTree();
  await putJson(root, "fixtures/artifacts/orphan/one.json", {});
  await assert.rejects(checkSchemas(root), /Unpaired artifact fixtures/);

  const noSchema = await tempRoot();
  await putJson(noSchema, "fixtures/artifacts/valid/one.json", {});
  await assert.rejects(checkSchemas(noSchema), /Unpaired artifact fixtures/);
});

test("Markdown lint rejects a malformed document", async () => {
  const root = await tempRoot();
  const good = path.join(root, "good.md");
  const bad = path.join(root, "bad.md");
  await writeFile(good, "# Heading\n\nGood text.\n");
  await writeFile(bad, "# Heading\n\nTrailing whitespace. \n");
  const cli = path.join(repositoryRoot, "node_modules/.bin/markdownlint-cli2");
  assert.equal(spawnSync(cli, [good], { cwd: repositoryRoot }).status, 0);
  assert.notEqual(spawnSync(cli, [bad], { cwd: repositoryRoot }).status, 0);
});
