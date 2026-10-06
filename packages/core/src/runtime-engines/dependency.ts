import { jsonCopy } from "../artifact-canonical.js";
import {
  ArtifactStoreError,
  type ArtifactSnapshot,
} from "../artifact-store.js";

export type ChangeImpact = "none" | "validate" | "revise" | "invalidate";
export type Freshness = "valid" | "stale" | "blocked";
export interface ExactArtifactRef {
  readonly artifactId: string;
  readonly revision: number;
  readonly lockDigest: string;
}
export interface VerifiedSnapshot {
  readonly artifact: ArtifactSnapshot;
  readonly digest: string;
}
export interface SnapshotReader {
  read(id: string, revision: number): Promise<VerifiedSnapshot>;
}
export interface DependencyEdge {
  readonly dependency: ExactArtifactRef;
  readonly dependent: ExactArtifactRef;
  readonly onChange: ChangeImpact;
}
export interface ChangedRevision {
  readonly artifactId: string;
  readonly fromRevision: number;
  readonly candidateRevision: number;
  readonly candidateDigest: string;
}
export interface FreshnessFinding {
  readonly artifact: ExactArtifactRef;
  readonly impact: Exclude<ChangeImpact, "none">;
  readonly freshness: Exclude<Freshness, "valid">;
  readonly paths: readonly (readonly DependencyEdge[])[];
  readonly reason: string;
}

export class RuntimeEngineError extends Error {
  constructor(
    readonly code: "INVALID" | "UNAVAILABLE" | "INTEGRITY" | "CYCLE",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeEngineError";
  }
}

const impacts: readonly ChangeImpact[] = [
  "none",
  "validate",
  "revise",
  "invalidate",
];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const idPattern = /^art_[A-Za-z0-9_-]+$/;

function assertRef(ref: ExactArtifactRef): void {
  if (
    !ref ||
    !idPattern.test(ref.artifactId) ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision < 1 ||
    !digestPattern.test(ref.lockDigest)
  )
    throw new RuntimeEngineError("INVALID", "Invalid exact artifact reference");
}

function key(ref: Pick<ExactArtifactRef, "artifactId" | "revision">): string {
  return `${ref.artifactId}@${ref.revision}`;
}

function compareRef(a: ExactArtifactRef, b: ExactArtifactRef): number {
  return (
    (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0) ||
    a.revision - b.revision
  );
}

function compareEdge(a: DependencyEdge, b: DependencyEdge): number {
  return (
    compareRef(a.dependent, b.dependent) ||
    compareRef(a.dependency, b.dependency)
  );
}

/** An exact-lock graph. Traversal returns dependencies before their consumers. */
export class DependencyGraph {
  private constructor(
    private readonly reader: SnapshotReader,
    private readonly snapshots: Map<string, VerifiedSnapshot>,
    private readonly ordered: ExactArtifactRef[],
    private readonly reverse: Map<string, DependencyEdge[]>,
  ) {}

  static async load(
    reader: SnapshotReader,
    roots: readonly ExactArtifactRef[],
  ): Promise<DependencyGraph> {
    if (!Array.isArray(roots) || roots.length === 0)
      throw new RuntimeEngineError("INVALID", "At least one root is required");
    const snapshots = new Map<string, VerifiedSnapshot>();
    const visiting = new Set<string>();
    const ordered: ExactArtifactRef[] = [];
    const reverse = new Map<string, DependencyEdge[]>();
    const expected = new Map<string, string>();

    async function visit(ref: ExactArtifactRef): Promise<void> {
      assertRef(ref);
      const identity = key(ref);
      const priorDigest = expected.get(identity);
      if (priorDigest && priorDigest !== ref.lockDigest)
        throw new RuntimeEngineError(
          "INTEGRITY",
          `Conflicting locks for ${identity}`,
        );
      expected.set(identity, ref.lockDigest);
      if (visiting.has(identity))
        throw new RuntimeEngineError(
          "CYCLE",
          `Dependency cycle at ${identity}`,
        );
      if (snapshots.has(identity)) return;
      visiting.add(identity);
      let resolved: VerifiedSnapshot;
      try {
        resolved = await reader.read(ref.artifactId, ref.revision);
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          throw new RuntimeEngineError(
            error.code === "UNAVAILABLE" ? "UNAVAILABLE" : "INTEGRITY",
            `Cannot verify ${identity}: ${error.message}`,
          );
        }
        throw error;
      }
      if (
        !resolved ||
        resolved.artifact?.meta.id !== ref.artifactId ||
        resolved.artifact.meta.revision !== ref.revision ||
        resolved.digest !== ref.lockDigest
      )
        throw new RuntimeEngineError(
          "INTEGRITY",
          `Digest or identity mismatch at ${identity}`,
        );
      const dependencies = resolved.artifact.dependencies;
      if (!Array.isArray(dependencies))
        throw new RuntimeEngineError(
          "INVALID",
          `Invalid dependencies at ${identity}`,
        );
      const sorted = [...dependencies].sort((a, b) => compareRef(a, b));
      for (const dependency of sorted) {
        const dep = {
          artifactId: dependency.artifactId,
          revision: dependency.revision,
          lockDigest: dependency.lockDigest,
        };
        assertRef(dep);
        if (!impacts.includes(dependency.onChange as ChangeImpact))
          throw new RuntimeEngineError(
            "INVALID",
            `Invalid change impact at ${identity}`,
          );
        await visit(dep);
        const edges = reverse.get(key(dep)) ?? [];
        edges.push({
          dependency: dep,
          dependent: jsonCopy(ref),
          onChange: dependency.onChange as ChangeImpact,
        });
        reverse.set(key(dep), edges);
      }
      visiting.delete(identity);
      snapshots.set(identity, jsonCopy(resolved));
      ordered.push(jsonCopy(ref));
    }

    const rootCopies = roots.map((root) => {
      assertRef(root);
      return jsonCopy(root);
    });
    for (const root of rootCopies.sort(compareRef)) await visit(root);
    for (const edges of reverse.values()) edges.sort(compareEdge);
    return new DependencyGraph(reader, snapshots, ordered, reverse);
  }

  get order(): readonly ExactArtifactRef[] {
    return jsonCopy(this.ordered);
  }

  get(ref: ExactArtifactRef): VerifiedSnapshot | undefined {
    assertRef(ref);
    const snapshot = this.snapshots.get(key(ref));
    if (snapshot && snapshot.digest !== ref.lockDigest)
      throw new RuntimeEngineError(
        "INTEGRITY",
        `Lock digest mismatch at ${key(ref)}`,
      );
    return snapshot && jsonCopy(snapshot);
  }

  /** Includes none edges so callers can record an explicit no-impact decision. */
  directImpacts(ref: ExactArtifactRef): readonly DependencyEdge[] {
    assertRef(ref);
    const snapshot = this.snapshots.get(key(ref));
    if (!snapshot)
      throw new RuntimeEngineError(
        "INVALID",
        "Reference is outside this exact-lock graph",
      );
    if (snapshot.digest !== ref.lockDigest)
      throw new RuntimeEngineError(
        "INTEGRITY",
        `Lock digest mismatch at ${key(ref)}`,
      );
    return jsonCopy(this.reverse.get(key(ref)) ?? []);
  }

  /** Only descendants reached through a non-none edge are assessed. All paths are retained. */
  async assessChanges(
    changes: readonly ChangedRevision[],
  ): Promise<readonly FreshnessFinding[]> {
    if (!Array.isArray(changes))
      throw new RuntimeEngineError("INVALID", "Changes must be an array");
    for (const change of changes) {
      if (
        !change ||
        !idPattern.test(change.artifactId) ||
        !Number.isSafeInteger(change.fromRevision) ||
        change.fromRevision < 1 ||
        !Number.isSafeInteger(change.candidateRevision) ||
        change.candidateRevision <= change.fromRevision ||
        !digestPattern.test(change.candidateDigest)
      )
        throw new RuntimeEngineError("INVALID", "Invalid changed revision");
    }
    const findings = new Map<
      string,
      { impact: number; paths: DependencyEdge[][] }
    >();
    const seen = new Set<string>();
    const sortedChanges = jsonCopy(changes).sort(
      (a, b) =>
        (a.artifactId < b.artifactId
          ? -1
          : a.artifactId > b.artifactId
            ? 1
            : 0) ||
        a.fromRevision - b.fromRevision ||
        a.candidateRevision - b.candidateRevision,
    );
    for (const change of sortedChanges) {
      const origin = key({
        artifactId: change.artifactId,
        revision: change.fromRevision,
      });
      if (!this.snapshots.has(origin))
        throw new RuntimeEngineError(
          "INVALID",
          `Change is outside graph: ${origin}`,
        );
      if (seen.has(origin))
        throw new RuntimeEngineError("INVALID", `Duplicate change: ${origin}`);
      seen.add(origin);
      let candidate: VerifiedSnapshot;
      try {
        candidate = await this.reader.read(
          change.artifactId,
          change.candidateRevision,
        );
      } catch (error) {
        if (error instanceof ArtifactStoreError)
          throw new RuntimeEngineError(
            error.code === "UNAVAILABLE" ? "UNAVAILABLE" : "INTEGRITY",
            `Cannot verify candidate ${change.artifactId}@${change.candidateRevision}: ${error.message}`,
          );
        throw error;
      }
      if (
        !candidate ||
        candidate.artifact?.meta.id !== change.artifactId ||
        candidate.artifact.meta.revision !== change.candidateRevision ||
        candidate.digest !== change.candidateDigest
      )
        throw new RuntimeEngineError(
          "INTEGRITY",
          "Candidate digest or identity mismatch",
        );
      const traverse = (
        node: string,
        path: DependencyEdge[],
        strength: number,
      ): void => {
        for (const edge of this.reverse.get(node) ?? []) {
          const impact = impacts.indexOf(edge.onChange);
          if (impact === 0) continue;
          const nextPath = [...path, edge];
          const nextStrength = Math.max(strength, impact);
          const dependent = key(edge.dependent);
          const finding = findings.get(dependent) ?? { impact: 0, paths: [] };
          finding.impact = Math.max(finding.impact, nextStrength);
          finding.paths.push(nextPath);
          findings.set(dependent, finding);
          traverse(dependent, nextPath, nextStrength);
        }
      };
      traverse(origin, [], 0);
    }
    return this.ordered
      .filter((ref) => findings.has(key(ref)))
      .map((ref) => {
        const finding = findings.get(key(ref))!;
        const impact = impacts[finding.impact] as Exclude<ChangeImpact, "none">;
        return {
          artifact: jsonCopy(ref),
          impact,
          freshness: impact === "invalidate" ? "blocked" : "stale",
          paths: jsonCopy(finding.paths),
          reason: `Upstream candidate requires ${impact}; exact dependency locks remain unchanged`,
        };
      });
  }
}
