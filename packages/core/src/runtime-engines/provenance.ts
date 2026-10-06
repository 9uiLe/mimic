import { jsonCopy } from "../artifact-canonical.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import { RuntimeEngineError } from "./dependency.js";

export type ProvenanceKind =
  | "fact"
  | "human-decision"
  | "assumption"
  | "hypothesis"
  | "derived"
  | "unknown";
export type ProvenanceStatus =
  "VERIFIED" | "DECLARED" | "UNVERIFIED" | "UNKNOWN";
export interface ProvenanceFinding {
  readonly path: string;
  readonly kind: ProvenanceKind;
  readonly status: ProvenanceStatus;
  readonly references: readonly string[];
  readonly reason: string;
}
export interface ProvenanceVerifier {
  /** True means the reference was resolved and checked for this claim, not merely present. */
  verifyEvidence?(
    reference: string,
    artifact: ArtifactSnapshot,
    path: string,
  ): Promise<boolean>;
  verifyInput?(
    reference: string,
    artifact: ArtifactSnapshot,
    path: string,
  ): Promise<boolean>;
  verifyDecision?(
    decisionId: string,
    artifact: ArtifactSnapshot,
  ): Promise<boolean>;
}

const kinds: readonly ProvenanceKind[] = [
  "fact",
  "human-decision",
  "assumption",
  "hypothesis",
  "derived",
  "unknown",
];

function pointerExists(artifact: ArtifactSnapshot, pointer: string): boolean {
  if (pointer !== "/content" && !pointer.startsWith("/content/")) return false;
  let current: unknown = artifact;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(encoded)) return false;
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)
        return false;
      current = current[Number(key)];
    } else if (
      current &&
      typeof current === "object" &&
      Object.hasOwn(current, key)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else return false;
  }
  return true;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function references(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonempty))
    return undefined;
  return [...value];
}

/** Tracks epistemic labels. A declared reference is never treated as proof. */
export async function assessProvenance(
  artifact: ArtifactSnapshot,
  verifier: ProvenanceVerifier = {},
): Promise<readonly ProvenanceFinding[]> {
  if (
    !artifact ||
    !Array.isArray(artifact.provenance) ||
    artifact.provenance.length === 0
  )
    throw new RuntimeEngineError("INVALID", "Provenance entries are required");
  const copy = jsonCopy(artifact);
  const findings: ProvenanceFinding[] = [];
  const paths = new Set<string>();
  for (const entry of copy.provenance) {
    if (!nonempty(entry.path) || !pointerExists(copy, entry.path))
      throw new RuntimeEngineError(
        "INVALID",
        `Invalid provenance pointer: ${entry.path}`,
      );
    if (paths.has(entry.path))
      throw new RuntimeEngineError(
        "INVALID",
        `Duplicate provenance pointer: ${entry.path}`,
      );
    paths.add(entry.path);
    if (!kinds.includes(entry.kind as ProvenanceKind))
      throw new RuntimeEngineError(
        "INVALID",
        `Invalid provenance kind: ${entry.kind}`,
      );
    const kind = entry.kind as ProvenanceKind;
    let status: ProvenanceStatus;
    let refs: string[] = [];
    let reason: string;
    if (kind === "fact" || kind === "derived") {
      refs =
        references(kind === "fact" ? entry.evidenceRefs : entry.inputRefs) ??
        [];
      if (refs.length === 0)
        throw new RuntimeEngineError("INVALID", `${kind} requires references`);
      const verify =
        kind === "fact" ? verifier.verifyEvidence : verifier.verifyInput;
      const checked = verify
        ? await Promise.all(refs.map((ref) => verify(ref, copy, entry.path)))
        : [];
      status =
        checked.length && checked.every((value) => value)
          ? "VERIFIED"
          : "UNVERIFIED";
      reason =
        status === "VERIFIED"
          ? "All references verified"
          : "References require verification";
    } else if (kind === "human-decision") {
      if (!nonempty(entry.decisionId))
        throw new RuntimeEngineError(
          "INVALID",
          "Human decision requires a decision ID",
        );
      refs = [entry.decisionId];
      status =
        verifier.verifyDecision &&
        (await verifier.verifyDecision(entry.decisionId, copy))
          ? "VERIFIED"
          : "UNVERIFIED";
      reason =
        status === "VERIFIED"
          ? "Decision authority verified"
          : "Decision authority unverified";
    } else {
      if (!nonempty(entry.rationale))
        throw new RuntimeEngineError("INVALID", `${kind} requires a rationale`);
      status = kind === "unknown" ? "UNKNOWN" : "DECLARED";
      reason = entry.rationale;
    }
    findings.push({ path: entry.path, kind, status, references: refs, reason });
  }
  return findings.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
