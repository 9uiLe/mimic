import type { ArtifactSnapshot, ArtifactStore } from "../artifact-store.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";

export type TokenLayer = "primitive" | "semantic" | "component";
export type SupportedTokenType = "color" | "dimension" | "number" | "duration";

export interface CompiledToken {
  readonly path: string;
  readonly name: string;
  readonly type: SupportedTokenType;
  readonly value: string;
  readonly reference?: string;
  readonly source: ExactArtifactRef;
}

export interface TokenCompilation {
  readonly css: string;
  readonly tokens: readonly CompiledToken[];
  readonly sources: readonly ExactArtifactRef[];
}

export class TokenCompilerError extends Error {
  constructor(
    readonly code: "INVALID" | "INTEGRITY" | "UNAPPROVED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "TokenCompilerError";
  }
}

interface RawToken {
  readonly path: string;
  readonly value: unknown;
  readonly declaredType?: string;
  readonly inheritedType?: string;
  readonly source: ExactArtifactRef;
}

const LAYERS: readonly TokenLayer[] = ["primitive", "semantic", "component"];
const TYPES: readonly SupportedTokenType[] = [
  "color",
  "dimension",
  "number",
  "duration",
];
const SEGMENT = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|[0-9]+)$/;
const ALIAS = /^\{((?:[^{}.]+\.)*[^{}.]+)\}$/;

function fail(code: TokenCompilerError["code"], message: string): never {
  throw new TokenCompilerError(code, message);
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID", `${at} must be an object`);
  return value as Record<string, unknown>;
}

function keysOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail("INVALID", `${at}: unsupported property ${key}`);
}

function finiteNumber(value: unknown, at: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  )
    return fail("INVALID", `${at} must be a finite safe number`);
  return value;
}

function cssNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function cssValue(
  type: SupportedTokenType,
  value: unknown,
  at: string,
): string {
  if (type === "number") return cssNumber(finiteNumber(value, at));
  if (type === "dimension" || type === "duration") {
    const data = object(value, at);
    keysOnly(data, ["value", "unit"], at);
    const number = finiteNumber(data.value, `${at}.value`);
    const units = type === "dimension" ? ["px", "rem"] : ["ms", "s"];
    if (!units.includes(data.unit as string))
      return fail("INVALID", `${at}.unit is unsupported`);
    return `${cssNumber(number)}${data.unit as string}`;
  }
  const data = object(value, at);
  keysOnly(data, ["colorSpace", "components", "alpha"], at);
  if (
    data.colorSpace !== "srgb" ||
    !Array.isArray(data.components) ||
    data.components.length !== 3
  )
    return fail("INVALID", `${at} must be an sRGB color with three components`);
  const components = data.components.map((item, index) => {
    const number = finiteNumber(item, `${at}.components[${index}]`);
    if (number < 0 || number > 1)
      return fail("INVALID", `${at}: sRGB component out of range`);
    return cssNumber(number);
  });
  let alpha = "";
  if (data.alpha !== undefined) {
    const number = finiteNumber(data.alpha, `${at}.alpha`);
    if (number < 0 || number > 1)
      return fail("INVALID", `${at}: alpha out of range`);
    alpha = ` / ${cssNumber(number)}`;
  }
  return `color(srgb ${components.join(" ")}${alpha})`;
}

function collect(
  node: Record<string, unknown>,
  path: readonly string[],
  inheritedType: string | undefined,
  source: ExactArtifactRef,
  tokens: Map<string, RawToken>,
): void {
  if (Object.hasOwn(node, "$value")) {
    keysOnly(
      node,
      ["$value", "$type", "$description", "$deprecated"],
      path.join("."),
    );
    if (!path.length || !LAYERS.includes(path[0] as TokenLayer))
      return fail("INVALID", `Token has no layer: ${path.join(".")}`);
    if (
      typeof node.$description !== "undefined" &&
      typeof node.$description !== "string"
    )
      return fail("INVALID", `Invalid description: ${path.join(".")}`);
    if (
      typeof node.$deprecated !== "undefined" &&
      typeof node.$deprecated !== "string" &&
      typeof node.$deprecated !== "boolean"
    )
      return fail("INVALID", `Invalid deprecated marker: ${path.join(".")}`);
    if (node.$type !== undefined && typeof node.$type !== "string")
      return fail("INVALID", `Invalid type: ${path.join(".")}`);
    if (
      node.$type !== undefined &&
      !TYPES.includes(node.$type as SupportedTokenType)
    )
      return fail("INVALID", `Unsupported type: ${path.join(".")}`);
    const name = path.join(".");
    if (tokens.has(name)) return fail("CONFLICT", `Duplicate token: ${name}`);
    tokens.set(name, {
      path: name,
      value: node.$value,
      declaredType: node.$type as string | undefined,
      inheritedType,
      source,
    });
    return;
  }
  keysOnly(
    node,
    [
      ...Object.keys(node).filter((key) => !key.startsWith("$")),
      "$type",
      "$description",
      "$deprecated",
    ],
    path.join(".") || "tokens",
  );
  if (node.$type !== undefined && typeof node.$type !== "string")
    return fail("INVALID", `Invalid group type: ${path.join(".")}`);
  if (
    node.$type !== undefined &&
    !TYPES.includes(node.$type as SupportedTokenType)
  )
    return fail("INVALID", `Unsupported group type: ${path.join(".")}`);
  if (node.$description !== undefined && typeof node.$description !== "string")
    return fail("INVALID", `Invalid group description: ${path.join(".")}`);
  if (
    node.$deprecated !== undefined &&
    typeof node.$deprecated !== "string" &&
    typeof node.$deprecated !== "boolean"
  )
    return fail(
      "INVALID",
      `Invalid group deprecated marker: ${path.join(".")}`,
    );
  const nextType = (node.$type as string | undefined) ?? inheritedType;
  for (const key of Object.keys(node).sort()) {
    if (key.startsWith("$")) continue;
    if (!SEGMENT.test(key))
      return fail("INVALID", `Unsupported token name segment: ${key}`);
    if (!path.length && !LAYERS.includes(key as TokenLayer))
      return fail("INVALID", `Unsupported token layer: ${key}`);
    collect(
      object(node[key], [...path, key].join(".")),
      [...path, key],
      nextType,
      source,
      tokens,
    );
  }
}

function tokenDefinition(artifact: ArtifactSnapshot): Record<string, unknown> {
  if (
    artifact.meta.type !== "design-system-asset" ||
    artifact.meta.schemaVersion !== "1.0.0"
  )
    return fail("INVALID", `Not a v1 Design System asset: ${artifact.meta.id}`);
  if (
    artifact.lifecycle.status !== "approved" ||
    artifact.lifecycle.freshness !== "valid" ||
    artifact.approval.status !== "approved"
  )
    return fail(
      "UNAPPROVED",
      `Token source is not fresh and approved: ${artifact.meta.id}`,
    );
  const content = object(artifact.content, `${artifact.meta.id}.content`);
  if (content.assetKind !== "dtcg-tokens")
    return fail("INVALID", `Not a token asset: ${artifact.meta.id}`);
  const definition = object(
    content.definition,
    `${artifact.meta.id}.definition`,
  );
  keysOnly(
    definition,
    ["tokens", "references", "modes"],
    `${artifact.meta.id}.definition`,
  );
  if (
    definition.modes !== undefined &&
    JSON.stringify(definition.modes) !== '["light"]'
  )
    return fail(
      "INVALID",
      `Only the light mode is supported: ${artifact.meta.id}`,
    );
  if (
    definition.references !== undefined &&
    (!Array.isArray(definition.references) ||
      !definition.references.every((item) => typeof item === "string"))
  )
    return fail("INVALID", `Invalid reference list: ${artifact.meta.id}`);
  return object(definition.tokens, `${artifact.meta.id}.definition.tokens`);
}

/** Reads exact snapshots through ArtifactStore, which verifies schema, digest, locks and human approval. */
export async function compileApprovedTokenAssets(
  store: ArtifactStore,
  sources: readonly ExactArtifactRef[],
  previous?: ExactArtifactRef,
): Promise<TokenCompilation> {
  if (!sources.length)
    return fail("INVALID", "At least one approved token source is required");
  const allRefs = previous ? [previous, ...sources] : [...sources];
  const seen = new Set<string>();
  const tokens = new Map<string, RawToken>();
  const newPaths = new Set<string>();
  for (const [sourceIndex, ref] of allRefs.entries()) {
    const key = `${ref.artifactId}@${ref.revision}`;
    if (seen.has(key)) return fail("CONFLICT", `Duplicate source: ${key}`);
    seen.add(key);
    const snapshot = await store.read(ref.artifactId, ref.revision);
    if (snapshot.digest !== ref.lockDigest)
      return fail("INTEGRITY", `Source lock mismatch: ${key}`);
    const local = new Map<string, RawToken>();
    collect(tokenDefinition(snapshot.artifact), [], undefined, ref, local);
    const references = (
      snapshot.artifact.content as { definition: { references?: string[] } }
    ).definition.references;
    for (const reference of references ?? [])
      if (!local.has(reference))
        return fail("INVALID", `Unresolved declared reference: ${reference}`);
    for (const [path, token] of local) {
      if (newPaths.has(path) || (tokens.has(path) && !previous))
        return fail("CONFLICT", `Duplicate token across sources: ${path}`);
      // A new, explicitly approved source replaces the same path. Unmentioned prior paths survive.
      tokens.set(path, token);
      if (!previous || sourceIndex > 0) newPaths.add(path);
    }
  }
  if (!tokens.size) return fail("INVALID", "Token sources contain no tokens");

  const names = new Map<string, string>();
  for (const path of tokens.keys()) {
    const name = `--mimic-${path.replaceAll(".", "-")}`;
    const existing = names.get(name);
    if (existing && existing !== path)
      return fail("CONFLICT", `CSS name collision: ${existing}, ${path}`);
    names.set(name, path);
  }

  const resolved = new Map<string, CompiledToken>();
  const visiting = new Set<string>();
  function resolve(path: string): CompiledToken {
    const cached = resolved.get(path);
    if (cached) return cached;
    const token = tokens.get(path);
    if (!token) return fail("INVALID", `Unresolved token reference: ${path}`);
    if (visiting.has(path))
      return fail("INVALID", `Cyclic token reference: ${path}`);
    visiting.add(path);
    const raw = token.value;
    const match = typeof raw === "string" ? ALIAS.exec(raw) : null;
    let type: SupportedTokenType;
    let value: string;
    let reference: string | undefined;
    if (match) {
      reference = match[1]!;
      const target = resolve(reference);
      if (
        LAYERS.indexOf(reference.split(".")[0] as TokenLayer) >
        LAYERS.indexOf(path.split(".")[0] as TokenLayer)
      )
        return fail(
          "INVALID",
          `Forward layer reference: ${path} -> ${reference}`,
        );
      type = target.type;
      if (
        (token.declaredType && token.declaredType !== type) ||
        (token.inheritedType &&
          token.inheritedType !== type &&
          !token.declaredType)
      )
        return fail("INVALID", `Alias type mismatch: ${path} -> ${reference}`);
      value = `var(--mimic-${reference.replaceAll(".", "-")})`;
    } else {
      if (
        typeof raw === "string" &&
        (raw.includes("{") || raw.includes("}") || raw.startsWith("#"))
      )
        return fail(
          "INVALID",
          `Unsupported reference or legacy value: ${path}`,
        );
      const declared = token.declaredType ?? token.inheritedType;
      if (!TYPES.includes(declared as SupportedTokenType))
        return fail("INVALID", `Missing or unsupported type: ${path}`);
      type = declared as SupportedTokenType;
      value = cssValue(type, raw, path);
    }
    const compiled: CompiledToken = {
      path,
      name: `--mimic-${path.replaceAll(".", "-")}`,
      type,
      value,
      ...(reference ? { reference } : {}),
      source: token.source,
    };
    visiting.delete(path);
    resolved.set(path, compiled);
    return compiled;
  }
  const compiled = [...tokens.keys()].sort().map(resolve);
  const css = `:root {\n${compiled.map((token) => `  ${token.name}: ${token.value};`).join("\n")}\n}\n`;
  return { css, tokens: compiled, sources: allRefs };
}
