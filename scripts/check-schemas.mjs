import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaSuffix = ".schema.json";
const dialect = "https://json-schema.org/draft/2020-12/schema";

async function jsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonFiles(location)));
    else if (entry.isFile() && entry.name.endsWith(".json"))
      files.push(location);
    else if (entry.isSymbolicLink())
      throw new Error(
        `Symlinks are not allowed in artifact inputs: ${location}`,
      );
  }
  return files.sort();
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${file}: ${error.message}`);
  }
}

export async function checkSchemas(root = process.cwd()) {
  const schemaRoot = path.join(root, "schemas/artifacts");
  const fixtureRoot = path.join(root, "fixtures/artifacts");
  const schemas = await jsonFiles(schemaRoot);
  const fixtureFiles = await jsonFiles(fixtureRoot);
  const unexpectedSchemas = schemas.filter(
    (file) => !file.endsWith(schemaSuffix),
  );
  if (unexpectedSchemas.length) {
    throw new Error(
      `Schema JSON must end in ${schemaSuffix}: ${unexpectedSchemas.join(", ")}`,
    );
  }
  if (!schemas.length && fixtureFiles.length) {
    throw new Error(`Unpaired artifact fixtures: ${fixtureFiles.join(", ")}`);
  }

  const entrypoint = path.join(schemaRoot, "artifact.schema.json");
  if (schemas.length && !schemas.includes(entrypoint)) {
    throw new Error(`Missing artifact entrypoint schema: ${entrypoint}`);
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const file of schemas) {
    const schema = await readJson(file);
    if (schema?.$schema !== dialect) {
      throw new Error(`${file} must declare $schema: ${dialect}`);
    }
    try {
      ajv.addSchema(schema, pathToFileURL(file).href);
    } catch (error) {
      throw new Error(`Invalid schema ${file}: ${error.message}`);
    }
  }

  for (const file of schemas) {
    try {
      if (!ajv.getSchema(pathToFileURL(file).href))
        throw new Error("No compiled validator");
    } catch (error) {
      throw new Error(`Cannot compile schema ${file}: ${error.message}`);
    }
  }

  const validFiles = await jsonFiles(path.join(fixtureRoot, "valid"));
  const invalidFiles = await jsonFiles(path.join(fixtureRoot, "invalid"));
  if (schemas.length && (!validFiles.length || !invalidFiles.length)) {
    throw new Error(
      "The artifact entrypoint needs at least one valid and one invalid JSON fixture",
    );
  }

  const validate = schemas.length
    ? ajv.getSchema(pathToFileURL(entrypoint).href)
    : null;
  for (const [files, expected] of [
    [validFiles, true],
    [invalidFiles, false],
  ]) {
    for (const fixture of files) {
      const actual = validate(await readJson(fixture));
      if (actual !== expected) {
        throw new Error(
          `${fixture} expected ${expected ? "valid" : "invalid"} against ${entrypoint}; errors: ${ajv.errorsText(validate.errors)}`,
        );
      }
    }
  }

  const expectedFixtures = new Set([...validFiles, ...invalidFiles]);
  const unpaired = fixtureFiles.filter((file) => !expectedFixtures.has(file));
  if (unpaired.length)
    throw new Error(`Unpaired artifact fixtures: ${unpaired.join(", ")}`);

  return {
    schemas: schemas.length,
    valid: validFiles.length,
    invalid: invalidFiles.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await checkSchemas();
    if (!result.schemas)
      console.log(
        "NO_SCHEMA_INPUTS: schemas/artifacts contains no JSON Schema files. Artifact coverage is pending.",
      );
    else
      console.log(
        `Validated ${result.schemas} schemas, ${result.valid} valid fixtures and ${result.invalid} invalid fixtures.`,
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
