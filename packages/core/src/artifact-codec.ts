import YAML, { isAlias, isMap, isScalar, isSeq } from "yaml";
import { canonicalJson, type JsonValue } from "./artifact-canonical.js";

function fromNode(node: unknown): JsonValue {
  if (isAlias(node)) throw new Error("YAML aliases are not allowed");
  if (isScalar(node)) {
    canonicalJson(node.value);
    return node.value as JsonValue;
  }
  if (isSeq(node)) return node.items.map(fromNode);
  if (isMap(node)) {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string")
        throw new Error("YAML mapping keys must be strings and scalar");
      if (Object.hasOwn(result, pair.key.value))
        throw new Error(`Duplicate YAML mapping key: ${pair.key.value}`);
      Object.defineProperty(result, pair.key.value, {
        value: fromNode(pair.value),
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  throw new Error("Unsupported YAML node");
}

export function parseArtifactYaml(source: string): JsonValue {
  const documents = YAML.parseAllDocuments(source, {
    uniqueKeys: true,
    version: "1.2",
  });
  if (documents.length !== 1)
    throw new Error("Artifact YAML must contain one document");
  const document = documents[0]!;
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join("; "));
  if (document.warnings.length)
    throw new Error(
      document.warnings.map((warning) => warning.message).join("; "),
    );
  if (!isMap(document.contents))
    throw new Error("Artifact YAML must be one mapping");
  return fromNode(document.contents);
}

export function serializeArtifactYaml(value: unknown): string {
  const normalized = JSON.parse(canonicalJson(value)) as JsonValue;
  if (
    !normalized ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  )
    throw new Error("Artifact must be a mapping");
  return YAML.stringify(normalized, { lineWidth: 0 });
}
