import { createHash } from "node:crypto";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const CANONICALIZATION_VERSION = "mimic-json-v1";

function validUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("Unpaired Unicode surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Unpaired Unicode surrogate");
    }
  }
}

/** Canonical JSON v1: UTF-16 key sort, JSON escapes and ECMAScript number formatting. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    validUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new Error("Non-JSON or unsafe numeric value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(key) ||
            Number(key) >= value.length ||
            !Object.hasOwn(
              Object.getOwnPropertyDescriptor(value, key)!,
              "value",
            )),
      )
    )
      throw new Error("Sparse or extended arrays are not JSON values");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("Non-JSON object");
    if (
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== "string" ||
          !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
      )
    )
      throw new Error("Object contains non-JSON properties");
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        validUnicode(key);
        return `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("Non-JSON value");
}

export function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function artifactDigest(value: unknown): string {
  const copy = jsonCopy(value) as Record<string, unknown>;
  if (!copy || typeof copy !== "object" || Array.isArray(copy))
    throw new Error("Artifact must be a mapping");
  const meta = copy.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("Artifact meta must be a mapping");
  delete meta.contentDigest;
  return `sha256:${createHash("sha256").update(canonicalJson(copy), "utf8").digest("hex")}`;
}
