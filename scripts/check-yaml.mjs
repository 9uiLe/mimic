import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML, { isMap, isScalar, isSeq } from "yaml";

function assertJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(assertJson);
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    Object.values(value).forEach(assertJson);
    return;
  }
  throw new Error("Artifact YAML must contain only JSON-compatible values");
}

function assertStringKeys(node) {
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string")
        throw new Error("Artifact YAML mapping keys must be strings");
      assertStringKeys(pair.value);
    }
  } else if (isSeq(node)) {
    node.items.forEach(assertStringKeys);
  }
}

export function parseArtifactYaml(source) {
  const document = YAML.parseDocument(source, {
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join("; "));
  if (!isMap(document.contents))
    throw new Error("Artifact YAML must be one mapping");
  assertStringKeys(document.contents);
  const value = document.toJS({ maxAliasCount: 0 });
  assertJson(value);
  return value;
}

async function schemaFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await schemaFiles(location)));
    else if (entry.isFile() && entry.name.endsWith(".schema.json"))
      files.push(location);
  }
  return files.sort();
}

export async function checkYaml(root = process.cwd()) {
  const schemaRoot = path.join(root, "schemas/artifacts");
  const fixtureRoot = path.join(root, "fixtures/artifacts/valid");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const file of await schemaFiles(schemaRoot)) {
    ajv.addSchema(
      JSON.parse(await readFile(file, "utf8")),
      pathToFileURL(file).href,
    );
  }
  const validate = ajv.getSchema(
    pathToFileURL(path.join(schemaRoot, "artifact.schema.json")).href,
  );
  let count = 0;
  for (const entry of await readdir(fixtureRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(fixtureRoot, entry.name);
    const artifact = parseArtifactYaml(await readFile(file, "utf8"));
    if (!validate(artifact))
      throw new Error(`${file}: ${ajv.errorsText(validate.errors)}`);
    count += 1;
  }
  if (!count) throw new Error("No native YAML artifact fixture found");
  return count;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      `Validated ${await checkYaml()} native YAML artifact fixture(s).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
