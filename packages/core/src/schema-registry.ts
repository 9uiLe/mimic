import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const ARTIFACT_SCHEMA_ID = "urn:mimic:artifact:v1";
export const ARTIFACT_SCHEMA_VERSION = "1.0.0";

export interface SchemaSource {
  readonly location: string;
  readonly schema: unknown;
}

export interface SchemaDiagnostic {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Record<string, unknown>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly SchemaDiagnostic[];
}

function schemaObject(source: SchemaSource): Record<string, unknown> {
  if (
    !source.schema ||
    typeof source.schema !== "object" ||
    Array.isArray(source.schema)
  )
    throw new Error(`Invalid schema at ${source.location}`);
  return source.schema as Record<string, unknown>;
}

function references(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => references(item, result));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") result.add(child);
    else references(child, result);
  }
}

export class SchemaRegistry {
  private readonly validator: ValidateFunction;
  readonly identities: readonly string[];

  constructor(sources: readonly SchemaSource[]) {
    if (!sources.length) throw new Error("No artifact schemas supplied");
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    (addFormats as unknown as FormatsPlugin)(ajv);
    const identities = new Set<string>();
    for (const source of sources) {
      const schema = schemaObject(source);
      const id = schema.$id;
      if (typeof id !== "string" || !id.startsWith("urn:mimic:artifact:v1"))
        throw new Error(
          `Unsupported or missing schema identity at ${source.location}`,
        );
      if (schema.$schema !== DIALECT)
        throw new Error(`Unsupported schema dialect at ${source.location}`);
      if (identities.has(id))
        throw new Error(`Duplicate schema identity: ${id}`);
      identities.add(id);
      ajv.addSchema(schema);
    }
    if (!identities.has(ARTIFACT_SCHEMA_ID))
      throw new Error("Missing artifact entry schema");
    for (const source of sources) {
      const schema = schemaObject(source);
      const refs = new Set<string>();
      references(schema, refs);
      for (const ref of refs) {
        if (ref.startsWith("#")) continue;
        const target = ref.split("#", 1)[0]!;
        if (!identities.has(target))
          throw new Error(`Unresolved local schema reference: ${ref}`);
      }
      try {
        if (!ajv.getSchema(schema.$id as string))
          throw new Error("No compiled validator");
      } catch (error) {
        throw new Error(`Cannot compile ${source.location}: ${String(error)}`);
      }
    }
    this.validator = ajv.getSchema(ARTIFACT_SCHEMA_ID)!;
    this.identities = [...identities].sort();
  }

  validate(artifact: unknown): ValidationResult {
    const version = (artifact as { meta?: { schemaVersion?: unknown } } | null)
      ?.meta?.schemaVersion;
    if (version !== ARTIFACT_SCHEMA_VERSION)
      return {
        valid: false,
        diagnostics: [
          {
            instancePath: "/meta/schemaVersion",
            schemaPath: "version",
            keyword: "schemaVersion",
            message: `Unsupported artifact schema version: ${String(version)}`,
            params: { supported: ARTIFACT_SCHEMA_VERSION },
          },
        ],
      };
    const valid = this.validator(artifact) as boolean;
    const diagnostics = (this.validator.errors ?? []).map(
      (error: ErrorObject) => ({
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        keyword: error.keyword,
        message: error.message ?? "Schema validation failed",
        params: { ...error.params },
      }),
    );
    return { valid, diagnostics };
  }
}

export async function loadSchemaDirectory(
  directory: string,
): Promise<SchemaRegistry> {
  const sources: SchemaSource[] = [];
  async function walk(location: string): Promise<void> {
    for (const entry of await readdir(location, { withFileTypes: true })) {
      const file = path.join(location, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Schema symlink is not allowed: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".schema.json"))
        sources.push({
          location: file,
          schema: JSON.parse(await readFile(file, "utf8")),
        });
    }
  }
  await walk(directory);
  return new SchemaRegistry(sources);
}
