export interface Status {
  readonly name: string;
  readonly state: "ready";
}

export function getStatus(): Status {
  return { name: "mimic", state: "ready" };
}

export * from "./artifact-canonical.js";
export * from "./artifact-codec.js";
export * from "./schema-registry.js";
export * from "./artifact-store.js";
export * from "./runtime-engines/index.js";
export * from "./package-registry/index.js";
