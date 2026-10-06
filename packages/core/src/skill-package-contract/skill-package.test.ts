import { readdir, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { parseArtifactYaml } from "../artifact-codec.js";

const repository = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../",
);
const schemaFile = path.join(
  repository,
  "schemas/skills/skill-package.schema.json",
);
const fixtures = path.join(repository, "fixtures/skills");
const artifactSchemas = path.join(repository, "schemas/artifacts");

interface Input {
  name: string;
  kind: "artifact" | "human-brief" | "evidence-file";
  artifactType?: string;
  schemaVersion?: string;
}
interface Manifest {
  skillId: string;
  manifestVersion: string;
  packageVersion: string;
  skillFile: string;
  inputs: {
    required: Input[];
    optional: Input[];
    alternatives: { name: string; oneOf: Input[] }[];
  };
  outputs: string[];
  forbiddenResponsibilities: string[];
  humanGates: { decision: string; authority: string }[];
  supportedArtifactSchemas: { artifactType: string; schemaVersion: string }[];
  examples: string[];
  tests: string[];
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
const schema = JSON.parse(await readFile(schemaFile, "utf8")) as object;
const validate = ajv.compile<Manifest>(schema);

function parseManifest(source: string): Manifest {
  return JSON.parse(JSON.stringify(parseArtifactYaml(source))) as Manifest;
}

async function manifestFiles(kind: "valid" | "invalid"): Promise<string[]> {
  const root = path.join(fixtures, kind);
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(location);
      else if (
        entry.isFile() &&
        (kind === "valid"
          ? /^manifest\.(json|yaml)$/.test(entry.name)
          : /\.invalid\.(json|yaml)$/.test(entry.name))
      )
        files.push(location);
    }
  }
  await walk(root);
  expect(files.length, `${kind} fixtures must not be empty`).toBeGreaterThan(0);
  return files.sort();
}

async function packageFile(root: string, reference: string): Promise<void> {
  const target = path.resolve(root, reference);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error(`Path escapes package: ${reference}`);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error(`Symlink in package path: ${reference}`);
  }
  if (!(await lstat(target)).isFile())
    throw new Error(`Package reference is not a file: ${reference}`);
  if (
    !(await realpath(target)).startsWith(`${await realpath(root)}${path.sep}`)
  )
    throw new Error(`Real path escapes package: ${reference}`);
}

async function canonicalTypes(): Promise<Map<string, string>> {
  const common = JSON.parse(
    await readFile(path.join(artifactSchemas, "common.schema.json"), "utf8"),
  ) as {
    properties: { meta: { properties: { schemaVersion: { const: string } } } };
  };
  const version = common.properties.meta.properties.schemaVersion.const;
  const types = new Map<string, string>();
  for (const file of await readdir(path.join(artifactSchemas, "types"))) {
    if (!file.endsWith(".schema.json")) continue;
    const source = JSON.parse(
      await readFile(path.join(artifactSchemas, "types", file), "utf8"),
    ) as {
      $id: string;
      allOf: {
        properties?: { meta?: { properties?: { type?: { const?: string } } } };
      }[];
    };
    const type = source.allOf[1]?.properties?.meta?.properties?.type?.const;
    if (!type || source.$id !== `urn:mimic:artifact:v1:type:${type}`)
      throw new Error(`Invalid canonical artifact schema: ${file}`);
    if (types.has(type))
      throw new Error(`Duplicate canonical artifact type: ${type}`);
    types.set(type, version);
  }
  expect(types.size).toBeGreaterThan(0);
  return types;
}

async function checkStatic(manifest: Manifest, root: string): Promise<void> {
  if (!validate(manifest))
    throw new Error(`Manifest shape: ${ajv.errorsText(validate.errors)}`);

  const types = await canonicalTypes();
  const declared = new Map<string, string>();
  for (const item of manifest.supportedArtifactSchemas) {
    if (declared.has(item.artifactType))
      throw new Error(`Duplicate artifact compatibility: ${item.artifactType}`);
    if (types.get(item.artifactType) !== item.schemaVersion)
      throw new Error(
        `Unsupported artifact type/version: ${item.artifactType}`,
      );
    declared.set(item.artifactType, item.schemaVersion);
  }

  const names = new Set<string>();
  const artifactInputs = new Set<string>();
  const groups = manifest.inputs.alternatives;
  const inputs = [
    ...manifest.inputs.required,
    ...manifest.inputs.optional,
    ...groups.flatMap((group) => group.oneOf),
  ];
  for (const group of groups) {
    if (names.has(group.name))
      throw new Error(`Duplicate input name: ${group.name}`);
    names.add(group.name);
  }
  for (const input of inputs) {
    if (names.has(input.name))
      throw new Error(`Duplicate input name: ${input.name}`);
    names.add(input.name);
    if (input.kind === "artifact") {
      const type = input.artifactType!;
      if (artifactInputs.has(type))
        throw new Error(`Conflicting artifact input declarations: ${type}`);
      artifactInputs.add(type);
      if (declared.get(type) !== input.schemaVersion)
        throw new Error(`Undeclared artifact input type/version: ${type}`);
    }
  }
  for (const output of manifest.outputs) {
    if (!declared.has(output))
      throw new Error(`Undeclared output artifact type: ${output}`);
  }
  const references = [
    manifest.skillFile,
    ...manifest.examples,
    ...manifest.tests,
  ];
  if (path.basename(manifest.skillFile) !== "SKILL.md")
    throw new Error("skillFile must reference SKILL.md");
  for (const reference of references) {
    if (path.posix.normalize(reference) !== reference)
      throw new Error(`Non-canonical package path: ${reference}`);
  }
  if (new Set(references).size !== references.length)
    throw new Error("Duplicate package file reference");
  for (const reference of references) await packageFile(root, reference);
}

test("strict Draft 2020-12 schema accepts every valid JSON and YAML package", async () => {
  const files = await manifestFiles("valid");
  expect(files.some((file) => file.endsWith(".json"))).toBe(true);
  expect(files.some((file) => file.endsWith(".yaml"))).toBe(true);
  for (const file of files) {
    const value = parseManifest(await readFile(file, "utf8"));
    await expect(
      checkStatic(value, path.dirname(file)),
      file,
    ).resolves.toBeUndefined();
  }
});

test("every invalid JSON and YAML fixture fails conformance", async () => {
  const files = await manifestFiles("invalid");
  const expected = new Map([
    [
      "duplicate-keys.invalid.yaml",
      /Map keys must be unique|Duplicate YAML mapping key/,
    ],
    ["traversal.invalid.yaml", /skillFile|Path escapes package/],
    ["unknown-artifact.invalid.json", /Unsupported artifact type\/version/],
  ]);
  expect(files.map((file) => path.basename(file))).toEqual(
    [...expected.keys()].sort(),
  );
  expect(files.some((file) => file.endsWith(".json"))).toBe(true);
  expect(files.some((file) => file.endsWith(".yaml"))).toBe(true);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    await expect(async () => {
      const value = parseManifest(source);
      await checkStatic(value, path.dirname(file));
    }, file).rejects.toThrow(expected.get(path.basename(file)));

    const repaired = path.basename(file).startsWith("duplicate-keys")
      ? source.replace(
          "skillId: mimic.invalid.duplicate-keys\nskillId: mimic.invalid.duplicate-keys",
          "skillId: mimic.invalid.duplicate-keys",
        )
      : path.basename(file).startsWith("traversal")
        ? source.replace("../SKILL.md", "SKILL.md")
        : source.replaceAll("imaginary-artifact", "product-definition");
    await expect(
      checkStatic(parseManifest(repaired), path.dirname(file)),
      `repairing only the intended defect must make ${file} valid`,
    ).resolves.toBeUndefined();
  }
});

test("cross-field declarations and package references cannot contradict", async () => {
  const root = path.join(fixtures, "valid/s01");
  const baseline = parseManifest(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  const changed = () => structuredClone(baseline);

  const duplicate = changed();
  duplicate.inputs.optional.push({
    ...duplicate.inputs.alternatives[0]!.oneOf[1]!,
    name: "another-definition",
  });
  await expect(checkStatic(duplicate, root)).rejects.toThrow(
    /Conflicting artifact input/,
  );

  const unsupported = changed();
  unsupported.supportedArtifactSchemas[0]!.schemaVersion = "2.0.0";
  await expect(checkStatic(unsupported, root)).rejects.toThrow();

  const undeclared = changed();
  undeclared.outputs.push("brand");
  await expect(checkStatic(undeclared, root)).rejects.toThrow(
    /Undeclared output/,
  );

  const absent = changed();
  absent.examples = ["examples/missing.json"];
  await expect(checkStatic(absent, root)).rejects.toThrow();

  const escape = changed();
  escape.examples = ["../s04/SKILL.md"];
  await expect(checkStatic(escape, root)).rejects.toThrow();

  const alias = changed();
  alias.examples.push("examples//intent.json");
  await expect(checkStatic(alias, root)).rejects.toThrow(
    /Non-canonical package path/,
  );
});

test("strict schema rejects runtime grants and ambiguous metadata", async () => {
  const root = path.join(fixtures, "valid/s01");
  const baseline = parseManifest(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  expect(validate({ ...baseline, entrypoint: "run.js" })).toBe(false);
  expect(validate({ ...baseline, toolPermissions: ["shell"] })).toBe(false);
  expect(validate({ ...baseline, network: true })).toBe(false);
  expect(validate({ ...baseline, canonicalWrite: true })).toBe(false);
  expect(validate({ ...baseline, manifestVersion: "2.0.0" })).toBe(false);
  expect(
    validate({
      ...baseline,
      humanGates: [{ decision: "brand", authority: "AUTONOMOUS" }],
    }),
  ).toBe(false);
});
