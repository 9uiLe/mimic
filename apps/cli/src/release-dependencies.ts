import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  FilePackageSource,
  packageDigest,
  parseDesignLock,
  parseManifest,
  sha256,
  type CompileInput,
  type LockedDependency,
  type PackageManifest,
  type PackageRef,
  type PackageSnapshot,
  type PackageSource,
  type RedistributionGrant,
} from "@mimic/core";
import type { ReleaseConfirmation } from "./release.js";

export class CliDependencyError extends Error {
  constructor(
    readonly code: "INVALID" | "UNSUPPORTED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "CliDependencyError";
  }
}
function check(
  condition: unknown,
  message: string,
  code: CliDependencyError["code"] = "INVALID",
): asserts condition {
  if (!condition) throw new CliDependencyError(code, message);
}
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const same = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
const identity = (ref: PackageRef): string => `${ref.packageId}@${ref.version}`;
const refLike = (value: unknown): value is PackageRef =>
  !!value &&
  typeof value === "object" &&
  typeof (value as PackageRef).packageId === "string" &&
  typeof (value as PackageRef).version === "string";
const onlyKeys = (value: unknown, names: readonly string[]): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => names.includes(key));
function inside(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${path.sep}`);
}
async function sourceRoot(root: string, name: string): Promise<string> {
  check(
    typeof name === "string" && name.length > 0,
    "Missing local dependency source",
  );
  const candidate = path.resolve(root, name);
  check(inside(root, candidate), "Dependency source escapes workspace");
  const resolved = await realpath(candidate);
  check(inside(root, resolved), "Dependency source escapes workspace");
  check(
    !(await lstat(candidate)).isSymbolicLink() &&
      (await lstat(candidate)).isDirectory(),
    "Dependency source is not a regular directory",
  );
  return resolved;
}
export interface DependencyNodeReview {
  readonly ref: PackageRef;
  readonly digest: string;
  readonly locations: readonly DependencyLocation[];
  readonly manifest: Pick<PackageManifest, "mode" | "scope" | "approval">;
  readonly lockDigest: string;
}
export type DependencyLocation =
  | { readonly kind: "source"; readonly path: string }
  | { readonly kind: "bundled"; readonly parent: PackageRef };
export interface DependencyEdgeReview extends LockedDependency {
  readonly parent: PackageRef;
}
export interface DependencyContext {
  readonly version: 1;
  readonly planDigest: string;
  readonly consumer: {
    readonly ref: PackageRef;
    readonly mode: CompileInput["mode"];
  };
  readonly nodes: readonly DependencyNodeReview[];
  readonly edges: readonly DependencyEdgeReview[];
}
export interface DependencyConfirmation {
  readonly version: 1;
  readonly action: "release-dependencies";
  readonly hostId: string;
  readonly humanActorId: string;
  readonly confirmedAt: string;
  readonly contextDigest: string;
  readonly consumer: DependencyContext["consumer"];
  readonly destination: string;
  readonly packages: readonly {
    readonly ref: PackageRef;
    readonly digest: string;
    readonly kind: "local-publication" | "imported-acceptance";
    readonly allowed: boolean;
    readonly evidence: string;
    /** Needed only for a completed legacy digest-only publication record. */
    readonly publicationConfirmation?: ReleaseConfirmation;
  }[];
  readonly licenses: readonly {
    readonly edge: DependencyEdgeReview;
    readonly allowed: boolean;
    readonly evidence: string;
  }[];
  readonly redistribution: readonly RedistributionGrant[];
}
interface Loaded {
  readonly snapshot: PackageSnapshot;
  readonly manifest: PackageManifest;
  readonly digest: string;
  readonly locations: Map<string, DependencyLocation>;
}
export interface DependencyReview {
  readonly context: DependencyContext;
  readonly contextDigest: string;
  readonly source: PackageSource;
  readonly manifests: ReadonlyMap<string, PackageManifest>;
}
/** Read exact local bytes and enumerate the entire reachable package graph. */
export async function reviewDependencies(
  root: string,
  planDigest: string,
  consumer: DependencyContext["consumer"],
  direct: CompileInput["dependencies"],
): Promise<DependencyReview> {
  const loaded = new Map<string, Loaded>();
  const edges: DependencyEdgeReview[] = [];
  const visiting = new Set<string>();
  async function walk(
    parent: PackageRef,
    edge: LockedDependency,
    bundled?: PackageSnapshot,
  ): Promise<void> {
    check(refLike(edge.ref), "Invalid dependency identity");
    const id = identity(edge.ref);
    check(!visiting.has(id), "Dependency cycle");
    const location: DependencyLocation = bundled
      ? { kind: "bundled", parent }
      : {
          kind: "source",
          path: path.relative(root, await sourceRoot(root, edge.source)),
        };
    let snapshot = bundled;
    if (!snapshot) {
      check(
        location.kind === "source",
        "Dependency source classification changed",
      );
      snapshot = await new FilePackageSource(
        path.join(root, location.path),
      ).read(edge.ref);
    }
    check(snapshot, `Dependency bytes unavailable: ${id}`, "UNSUPPORTED");
    check(
      packageDigest(snapshot) === edge.digest,
      `Dependency bytes changed: ${id}`,
    );
    const manifest = parseManifest(snapshot.manifestBytes);
    const lock = parseDesignLock(snapshot.lockBytes);
    check(
      same(manifest.ref, edge.ref) && same(lock.root, edge.ref),
      `Dependency identity differs from selected edge: ${id}`,
    );
    const prior = loaded.get(id);
    if (prior) {
      check(
        prior.digest === edge.digest,
        `Conflicting dependency bytes: ${id}`,
      );
      prior.locations.set(canonicalJson(location), location);
      return;
    }
    loaded.set(id, {
      snapshot,
      manifest,
      digest: edge.digest,
      locations: new Map([[canonicalJson(location), location]]),
    });
    visiting.add(id);
    for (const child of manifest.dependencies) {
      edges.push({ parent: manifest.ref, ...child });
      const nested =
        child.distribution === "bundled"
          ? snapshot.bundled?.[
              `${encodeURIComponent(child.ref.packageId)}@${child.ref.version}`
            ]
          : undefined;
      if (child.distribution === "bundled")
        check(
          nested,
          `Bundled dependency bytes unavailable: ${identity(child.ref)}`,
        );
      await walk(manifest.ref, child, nested);
    }
    visiting.delete(id);
  }
  for (const selected of direct) {
    check(
      !!selected &&
        typeof selected === "object" &&
        refLike(selected.ref) &&
        typeof selected.digest === "string" &&
        typeof selected.source === "string" &&
        typeof selected.license === "string",
      "Invalid dependency selection",
    );
    const edge: LockedDependency = {
      ...selected,
      distribution: consumer.mode === "portable" ? "bundled" : "external",
    };
    edges.push({ parent: consumer.ref, ...edge });
    await walk(consumer.ref, edge);
  }
  const nodes = [...loaded.values()]
    .map(({ snapshot, manifest, digest: bytesDigest, locations }) => ({
      ref: manifest.ref,
      digest: bytesDigest,
      locations: [...locations.values()].sort((a, b) =>
        canonicalJson(a).localeCompare(canonicalJson(b)),
      ),
      manifest: {
        mode: manifest.mode,
        scope: manifest.scope,
        approval: manifest.approval,
      },
      lockDigest: sha256(snapshot.lockBytes),
    }))
    .sort((a, b) => identity(a.ref).localeCompare(identity(b.ref)));
  edges.sort((a, b) =>
    `${identity(a.parent)}>${identity(a.ref)}`.localeCompare(
      `${identity(b.parent)}>${identity(b.ref)}`,
    ),
  );
  const context: DependencyContext = {
    version: 1,
    planDigest,
    consumer,
    nodes,
    edges,
  };
  const source: PackageSource = {
    read: async (ref) => loaded.get(identity(ref))?.snapshot,
    versions: async (packageId) =>
      [...loaded.values()]
        .filter(({ manifest }) => manifest.ref.packageId === packageId)
        .map(({ manifest, digest: bytesDigest }) => ({
          ...manifest.ref,
          digest: bytesDigest,
        })),
  };
  return {
    context,
    contextDigest: digest(context),
    source,
    manifests: new Map([...loaded].map(([id, value]) => [id, value.manifest])),
  };
}
export interface AuthorizedDependencies {
  readonly source: PackageSource;
  readonly manifests: ReadonlyMap<string, PackageManifest>;
  readonly licensePairs: ReadonlySet<string>;
  readonly redistribution: readonly RedistributionGrant[];
}
/** Every node, edge, and Portable grant needs an exact per-consumer decision. */
export async function authorizeDependencies(
  review: DependencyReview,
  confirmation: DependencyConfirmation | undefined,
  destination: string,
  hostId: string,
  verifyLocalPublication: (
    node: DependencyNodeReview,
    supplied?: ReleaseConfirmation,
  ) => Promise<boolean>,
): Promise<AuthorizedDependencies> {
  check(confirmation, "Dependency confirmation is unavailable", "UNSUPPORTED");
  check(
    onlyKeys(confirmation, [
      "version",
      "action",
      "hostId",
      "humanActorId",
      "confirmedAt",
      "contextDigest",
      "consumer",
      "destination",
      "packages",
      "licenses",
      "redistribution",
    ]) &&
      confirmation.version === 1 &&
      confirmation.action === "release-dependencies" &&
      confirmation.hostId === hostId &&
      typeof confirmation.humanActorId === "string" &&
      confirmation.humanActorId.trim() !== "" &&
      Number.isFinite(Date.parse(confirmation.confirmedAt)) &&
      Date.parse(confirmation.confirmedAt) <= Date.now() &&
      confirmation.contextDigest === review.contextDigest &&
      same(confirmation.consumer, review.context.consumer) &&
      confirmation.destination === destination &&
      Array.isArray(confirmation.packages) &&
      Array.isArray(confirmation.licenses) &&
      Array.isArray(confirmation.redistribution),
    "Dependency confirmation changed context, destination, or host",
  );
  const { nodes, edges } = review.context;
  check(
    confirmation.packages.length === nodes.length &&
      confirmation.licenses.length === edges.length,
    "Dependency decisions are incomplete",
  );
  for (const node of nodes) {
    const matching = confirmation.packages.filter(
      (item) => item && same(item.ref, node.ref) && item.digest === node.digest,
    );
    check(
      matching.length === 1,
      `Missing exact package authority: ${identity(node.ref)}`,
    );
    const decision = matching[0]!;
    check(
      onlyKeys(decision, [
        "ref",
        "digest",
        "kind",
        "allowed",
        "evidence",
        "publicationConfirmation",
      ]) &&
        decision.allowed === true &&
        typeof decision.evidence === "string" &&
        decision.evidence.trim() !== "" &&
        ["local-publication", "imported-acceptance"].includes(decision.kind),
      `Package authority denied: ${identity(node.ref)}`,
      "UNSUPPORTED",
    );
    if (decision.kind === "local-publication")
      check(
        await verifyLocalPublication(node, decision.publicationConfirmation),
        `Completed local publication is unverified: ${identity(node.ref)}`,
        "UNSUPPORTED",
      );
    else
      check(
        !decision.publicationConfirmation,
        "Imported acceptance cannot claim a local publication",
      );
  }
  const licensePairs = new Set<string>();
  for (const edge of edges) {
    const matching = confirmation.licenses.filter(
      (item) => item && same(item.edge, edge),
    );
    check(
      matching.length === 1,
      `Missing exact edge license decision: ${identity(edge.parent)} > ${identity(edge.ref)}`,
    );
    const decision = matching[0]!;
    check(
      onlyKeys(decision, ["edge", "allowed", "evidence"]) &&
        decision.allowed === true &&
        typeof decision.evidence === "string" &&
        decision.evidence.trim() !== "",
      `Dependency license denied: ${identity(edge.ref)}`,
      "UNSUPPORTED",
    );
    licensePairs.add(`${edge.license}\0${edge.distribution}`);
  }
  for (const node of nodes) {
    if (review.context.consumer.mode !== "portable") break;
    const matching = confirmation.redistribution.filter(
      (item) => item && same(item.ref, node.ref) && item.digest === node.digest,
    );
    check(
      matching.length === 1,
      `Missing exact redistribution grant: ${identity(node.ref)}`,
    );
    check(
      onlyKeys(matching[0], ["ref", "digest", "allowed", "evidence"]) &&
        matching[0]!.allowed === true &&
        typeof matching[0]!.evidence === "string" &&
        matching[0]!.evidence.trim() !== "",
      `Redistribution denied: ${identity(node.ref)}`,
      "UNSUPPORTED",
    );
  }
  check(
    confirmation.redistribution.length ===
      (review.context.consumer.mode === "portable" ? nodes.length : 0),
    "Unexpected redistribution decision",
  );
  return {
    source: review.source,
    manifests: review.manifests,
    licensePairs,
    redistribution: confirmation.redistribution,
  };
}
