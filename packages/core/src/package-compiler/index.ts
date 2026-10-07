import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import { serializeArtifactYaml } from "../artifact-codec.js";
import { ArtifactStoreError, type ArtifactStore } from "../artifact-store.js";
import {
  packageDigest,
  parseManifest,
  parseDesignLock,
  serializePackageDocument,
  sha256,
  type ArtifactEntry,
  type DesignLock,
  type LockedDependency,
  type LockNode,
  type PackageManifest,
  type PackageRef,
  type PackageRegistry,
  type PackageSnapshot,
  type PackageSource,
} from "../package-registry/index.js";
import type { GateFinding, QualityReport } from "../quality-gates/index.js";

export const INVENTORY_CATEGORIES = [
  "product-foundation",
  "experience-structure",
  "design-system",
  "interface-system-boundary",
  "prototype",
  "scenarios",
  "quality",
  "decisions",
  "handoff",
] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];
export interface ArtifactSelection {
  readonly artifactId: string;
  readonly revision: number;
  readonly lockDigest: string;
}
export type InventorySelection =
  | {
      readonly status: "included";
      readonly artifacts: readonly ArtifactSelection[];
      readonly files: readonly string[];
      readonly dependencies: readonly PackageRef[];
    }
  | { readonly status: "absent"; readonly reason: string };
export interface DependencySelection {
  readonly ref: PackageRef;
  readonly digest: string;
  readonly source: string;
  readonly license: string;
}
export interface RedistributionGrant {
  readonly ref: PackageRef;
  readonly digest: string;
  /** A trusted caller's explicit decision for this exact release; not a license inference. */
  readonly allowed: boolean;
  readonly evidence: string;
}
export interface QualityEvidence {
  readonly report: QualityReport;
  readonly artifacts: readonly ArtifactSelection[];
}
export interface ReleasePolicyDecision {
  readonly criterion: string;
  readonly state: GateFinding["state"];
  readonly severity: GateFinding["severity"];
  readonly blockRelease: boolean;
  readonly reason: string;
}
export interface ReleasePolicy {
  assess(
    finding: GateFinding,
    report: QualityReport,
  ): Promise<{ blockRelease: boolean; reason: string }>;
}
export interface CompileInput {
  readonly ref: PackageRef;
  readonly mode: "reference" | "portable";
  readonly scope: PackageManifest["scope"];
  readonly schemaVersion: string;
  readonly approval: PackageManifest["approval"];
  readonly inventory: Readonly<Record<InventoryCategory, InventorySelection>>;
  /** Package-owned deliverable bytes. Artifact, inventory and quality paths are reserved. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly dependencies: readonly DependencySelection[];
  readonly redistribution?: readonly RedistributionGrant[];
  readonly quality: readonly QualityEvidence[];
}
export interface ReleaseApprovalRequest {
  readonly ref: PackageRef;
  readonly mode: CompileInput["mode"];
  readonly digest: string;
  readonly manifest: PackageManifest;
  readonly lock: DesignLock;
  readonly inventory: CompileInput["inventory"];
  readonly qualityDecisions: readonly ReleasePolicyDecision[];
}
export interface ReleaseAuthority {
  /** Verify a trusted local human decision bound to this exact candidate. */
  verifyRelease(request: ReleaseApprovalRequest): Promise<boolean>;
}
export interface CompiledPackage {
  readonly ref: PackageRef;
  readonly digest: string;
  readonly snapshot: PackageSnapshot;
  readonly manifest: PackageManifest;
  readonly lock: DesignLock;
  readonly inventory: CompileInput["inventory"];
  readonly qualityDecisions: readonly ReleasePolicyDecision[];
  /** Re-read selected approved revisions immediately before local commit. */
  verifyCurrent(): Promise<void>;
  /** Resolve this exact candidate using the caller's registry policy before commit. */
  verifyResolution(): Promise<void>;
}
export class PackageCompilerError extends Error {
  constructor(
    readonly code:
      "INVALID" | "UNVERIFIED" | "BLOCKED" | "CONFLICT" | "CANCELLED",
    message: string,
    readonly decisions: readonly ReleasePolicyDecision[] = [],
  ) {
    super(message);
    this.name = "PackageCompilerError";
  }
}
const encoder = new TextEncoder();
const prototypeNames = [
  "index.html",
  "prototype.css",
  "prototype.js",
  "plan.json",
  "manifest.json",
] as const;
const required = new Set<InventoryCategory>([
  "product-foundation",
  "prototype",
  "quality",
  "decisions",
  "handoff",
]);
const identity = (ref: PackageRef): string => `${ref.packageId}@${ref.version}`;
const bundledKey = (ref: PackageRef): string =>
  `${encodeURIComponent(ref.packageId)}@${ref.version}`;
function fail(code: PackageCompilerError["code"], message: string): never {
  throw new PackageCompilerError(code, message);
}
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) fail("INVALID", message);
}
function copySnapshot(item: PackageSnapshot): PackageSnapshot {
  return {
    manifestBytes: Uint8Array.from(item.manifestBytes),
    lockBytes: Uint8Array.from(item.lockBytes),
    files: Object.fromEntries(
      Object.entries(item.files).map(([name, bytes]) => [
        name,
        Uint8Array.from(bytes),
      ]),
    ),
    bundled: Object.fromEntries(
      Object.entries(item.bundled ?? {}).map(([name, child]) => [
        name,
        copySnapshot(child),
      ]),
    ),
  };
}
function copyInput(input: CompileInput): CompileInput {
  return {
    ...structuredClone({ ...input, files: {} }),
    files: Object.fromEntries(
      Object.entries(input.files).map(([name, bytes]) => [
        name,
        Uint8Array.from(bytes),
      ]),
    ),
  };
}
function validPath(name: string): boolean {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((part) => !!part && part !== "." && part !== "..") &&
    !["manifest.json", "design.lock.yaml"].includes(name) &&
    !name.startsWith("bundled/")
  );
}
function stableBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2) + "\n");
}
function exactSelection(a: ArtifactSelection, b: ArtifactSelection): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.revision === b.revision &&
    a.lockDigest === b.lockDigest
  );
}
function assertInventory(input: CompileInput): void {
  ensure(
    Object.keys(input.inventory).sort().join("|") ===
      [...INVENTORY_CATEGORIES].sort().join("|"),
    "Every inventory category must be classified exactly once",
  );
  const claimedFiles = new Set<string>();
  const claimedArtifacts = new Set<string>();
  const claimedDependencies = new Set<string>();
  for (const category of INVENTORY_CATEGORIES) {
    const item = input.inventory[category];
    ensure(
      item && (item.status === "included" || item.status === "absent"),
      `Invalid inventory: ${category}`,
    );
    if (item.status === "absent") {
      ensure(
        !required.has(category),
        `Required release inventory cannot be absent: ${category}`,
      );
      ensure(!!item.reason.trim(), `Absence requires a reason: ${category}`);
      continue;
    }
    ensure(
      item.artifacts.length + item.files.length + item.dependencies.length > 0,
      `Empty included category: ${category}`,
    );
    for (const name of item.files) {
      ensure(
        validPath(name) && Object.hasOwn(input.files, name),
        `Undelivered inventory file: ${name}`,
      );
      ensure(!claimedFiles.has(name), `File classified twice: ${name}`);
      claimedFiles.add(name);
    }
    for (const artifact of item.artifacts) {
      const key = `${artifact.artifactId}@${artifact.revision}`;
      ensure(!claimedArtifacts.has(key), `Artifact classified twice: ${key}`);
      claimedArtifacts.add(key);
    }
    for (const dep of item.dependencies) {
      const key = identity(dep);
      ensure(
        input.dependencies.some((value) => identity(value.ref) === key),
        `Unresolved inventory dependency: ${key}`,
      );
      ensure(
        !claimedDependencies.has(key),
        `Dependency classified twice: ${key}`,
      );
      claimedDependencies.add(key);
    }
  }
  ensure(
    Object.keys(input.files).every((name) => claimedFiles.has(name)),
    "Unclassified package-owned file",
  );
  ensure(
    input.dependencies.every((dep) =>
      claimedDependencies.has(identity(dep.ref)),
    ),
    "Unclassified external dependency",
  );
  for (const name of prototypeNames)
    ensure(
      claimedFiles.has(`prototype/${name}`),
      `Missing executable prototype file: ${name}`,
    );
}
function qualityTarget(
  input: CompileInput,
  evidence: QualityEvidence,
  selected: readonly ArtifactSelection[],
): void {
  const report = evidence.report;
  ensure(
    report.action === "inspect-only" && report.findings.length > 0,
    "Quality report must contain inspected findings",
  );
  const digests: Record<string, string> = {};
  for (const name of prototypeNames)
    digests[name] = sha256(input.files[`prototype/${name}`]!);
  ensure(
    Object.keys(digests).every(
      (name) => report.target.files[name] === digests[name],
    ) && Object.keys(report.target.files).length === prototypeNames.length,
    "Quality report targets different prototype file bytes",
  );
  const bundleDigest = sha256(
    encoder.encode(
      prototypeNames.map((name) => `${name}\0${digests[name]}`).join("\n"),
    ),
  );
  ensure(
    report.target.bundleDigest === bundleDigest,
    "Quality report bundle digest is stale",
  );
  ensure(
    evidence.artifacts.length > 0 &&
      evidence.artifacts.every((ref) =>
        selected.some((item) => exactSelection(ref, item)),
      ),
    "Quality evidence must bind selected exact artifact revisions",
  );
  for (const ref of [report.target.scenario])
    if (ref)
      ensure(
        evidence.artifacts.some((item) => exactSelection(item, ref)),
        "Quality scenario target is not bound to selected revision",
      );
  for (const finding of report.findings) {
    ensure(
      ["PASS", "CONCERN", "FAIL", "UNVERIFIED", "N/A"].includes(finding.state),
      "Unknown quality state",
    );
    ensure(
      ["BLOCKER", "MAJOR", "MINOR", "NOTE"].includes(finding.severity),
      "Unknown quality severity",
    );
    ensure(
      !!finding.criterion && !!finding.reason,
      "Quality finding lacks criterion or reason",
    );
  }
}

/** Build a byte-exact candidate. No publication or release approval occurs here. */
export async function compilePackage(
  inputValue: CompileInput,
  store: ArtifactStore,
  registry: PackageRegistry,
  policy: ReleasePolicy,
  registryForSource: (source: PackageSource) => PackageRegistry,
): Promise<CompiledPackage> {
  const input = copyInput(inputValue);
  assertInventory(input);
  ensure(
    !Object.hasOwn(input.files, "inventory.json") &&
      !Object.hasOwn(input.files, "quality/evidence.json") &&
      Object.keys(input.files).every((name) => !name.startsWith("artifacts/")),
    "Compiler-owned paths are reserved",
  );
  ensure(input.quality.length > 0, "Release quality evidence required");
  const selections = INVENTORY_CATEGORIES.flatMap((category) => {
    const item = input.inventory[category];
    return item.status === "included" ? item.artifacts : [];
  });
  const externalSelections: ArtifactSelection[] = [];
  const files: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(input.files).map(([name, bytes]) => [
      name,
      Uint8Array.from(bytes),
    ]),
  );
  const artifactEntries: ArtifactEntry[] = [];
  const verifyCurrent = async (): Promise<void> => {
    for (const ref of [...selections, ...externalSelections]) {
      let current: Awaited<ReturnType<ArtifactStore["read"]>>;
      try {
        current = await store.read(ref.artifactId, ref.revision);
      } catch (error) {
        if (
          error instanceof ArtifactStoreError &&
          ["CORRUPT", "INVALID"].includes(error.code)
        )
          fail(
            "INVALID",
            `Artifact verification failed: ${ref.artifactId}@${ref.revision}: ${error.message}`,
          );
        fail(
          "UNVERIFIED",
          `Trusted artifact verification unavailable: ${ref.artifactId}@${ref.revision}: ${String(error)}`,
        );
      }
      if (
        current.digest !== ref.lockDigest ||
        artifactDigest(current.artifact) !== ref.lockDigest
      )
        fail(
          "INVALID",
          `Artifact lock mismatch: ${ref.artifactId}@${ref.revision}`,
        );
      if (
        current.artifact.lifecycle.status !== "approved" ||
        current.artifact.approval.status !== "approved" ||
        current.artifact.lifecycle.freshness !== "valid"
      )
        fail(
          "UNVERIFIED",
          `Artifact is not approved and fresh: ${ref.artifactId}@${ref.revision}`,
        );
    }
  };
  await verifyCurrent();
  for (const ref of selections) {
    const { artifact, digest } = await store.read(ref.artifactId, ref.revision);
    const name = `artifacts/${ref.artifactId}@${ref.revision}.yaml`;
    ensure(!Object.hasOwn(files, name), `Reserved artifact path: ${name}`);
    const bytes = encoder.encode(serializeArtifactYaml(artifact));
    files[name] = bytes;
    artifactEntries.push({
      artifactId: ref.artifactId,
      revision: ref.revision,
      schemaVersion: artifact.meta.schemaVersion,
      snapshotDigest: digest,
      path: name,
      digest: sha256(bytes),
    });
  }
  for (const evidence of input.quality)
    qualityTarget(input, evidence, selections);
  const decisions: ReleasePolicyDecision[] = [];
  for (const evidence of input.quality)
    for (const finding of evidence.report.findings) {
      const result = await policy.assess(
        structuredClone(finding),
        structuredClone(evidence.report),
      );
      ensure(
        typeof result.blockRelease === "boolean" && !!result.reason?.trim(),
        `Release policy must explain ${finding.criterion}`,
      );
      decisions.push({
        criterion: finding.criterion,
        state: finding.state,
        severity: finding.severity,
        blockRelease: result.blockRelease,
        reason: result.reason,
      });
    }
  if (decisions.some((item) => item.blockRelease))
    throw new PackageCompilerError(
      "BLOCKED",
      `Release policy blocks: ${decisions
        .filter((item) => item.blockRelease)
        .map((item) => item.criterion)
        .join(", ")}`,
      decisions,
    );
  const qualityRecord = { evidence: input.quality, decisions };
  files["inventory.json"] = stableBytes(input.inventory);
  files["quality/evidence.json"] = stableBytes(qualityRecord);
  const fileEntries = Object.entries(files)
    .filter(([name]) => !name.startsWith("artifacts/"))
    .map(([name, bytes]) => ({ path: name, digest: sha256(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  artifactEntries.sort((a, b) => a.path.localeCompare(b.path));
  const direct: LockedDependency[] = [];
  const nodes = new Map<string, LockNode>();
  const bundled: Record<string, PackageSnapshot> = {};
  for (const dep of input.dependencies) {
    ensure(
      !direct.some((edge) => edge.ref.packageId === dep.ref.packageId),
      `Duplicate direct dependency: ${dep.ref.packageId}`,
    );
    const graph = await registry.reconstruct(dep.ref, dep.digest);
    const root = graph[0];
    ensure(
      root && identity(root.manifest.ref) === identity(dep.ref),
      "Wrong dependency root",
    );
    for (const item of graph) {
      const prior = nodes.get(identity(item.manifest.ref));
      if (prior && prior.digest !== item.digest)
        fail(
          "INVALID",
          `Conflicting dependency bytes: ${identity(item.manifest.ref)}`,
        );
      if (input.mode === "portable") {
        const grant = input.redistribution?.find(
          (value) =>
            identity(value.ref) === identity(item.manifest.ref) &&
            value.digest === item.digest,
        );
        if (!grant?.allowed || !grant.evidence?.trim())
          fail(
            "UNVERIFIED",
            `Missing verified redistribution permission: ${identity(item.manifest.ref)}`,
          );
      }
    }
    if (input.mode === "portable") {
      for (const item of graph)
        if (
          item.manifest.dependencies.some(
            (edge) => edge.distribution !== "bundled",
          )
        )
          fail(
            "INVALID",
            `Portable dependency lacks bundled transitive closure: ${identity(item.manifest.ref)}`,
          );
      bundled[bundledKey(dep.ref)] = copySnapshot(root.snapshot);
    }
    const edge: LockedDependency = {
      ...dep,
      distribution: input.mode === "portable" ? "bundled" : "external",
    };
    direct.push(edge);
    const add = (
      item: (typeof graph)[number],
      selectedEdge: LockedDependency,
    ): void => {
      const manifest = item.manifest;
      const node: LockNode = {
        ...selectedEdge,
        scope: manifest.scope,
        schemaVersion: manifest.schemaVersion,
        assets: manifest.assets,
        artifacts: manifest.artifacts,
        dependencies: manifest.dependencies.map((child) => child.ref),
      };
      const existing = nodes.get(identity(manifest.ref));
      if (existing && JSON.stringify(existing) !== JSON.stringify(node))
        fail(
          "INVALID",
          `Conflicting transitive lock: ${identity(manifest.ref)}`,
        );
      nodes.set(identity(manifest.ref), node);
      for (const childEdge of manifest.dependencies) {
        const child = graph.find(
          (value) => identity(value.manifest.ref) === identity(childEdge.ref),
        );
        ensure(
          child,
          `Missing transitive dependency: ${identity(childEdge.ref)}`,
        );
        addChild(child, childEdge);
      }
    };
    const visited = new Set<string>();
    const addChild = (
      item: (typeof graph)[number],
      selectedEdge: LockedDependency,
    ): void => {
      const id = identity(item.manifest.ref);
      if (visited.has(id)) return;
      visited.add(id);
      add(item, selectedEdge);
    };
    addChild(root, edge);
  }
  const closure = new Map<string, string>();
  for (const entry of artifactEntries)
    closure.set(`${entry.artifactId}@${entry.revision}`, entry.snapshotDigest);
  for (const node of nodes.values())
    for (const entry of node.artifacts) {
      const id = `${entry.artifactId}@${entry.revision}`;
      const old = closure.get(id);
      if (old && old !== entry.snapshotDigest)
        fail("INVALID", `Conflicting artifact revision: ${id}`);
      closure.set(id, entry.snapshotDigest);
    }
  const localKeys = new Set(
    selections.map((ref) => `${ref.artifactId}@${ref.revision}`),
  );
  const visitedArtifacts = new Set<string>();
  const walkArtifact = async (ref: ArtifactSelection): Promise<void> => {
    const key = `${ref.artifactId}@${ref.revision}`;
    if (visitedArtifacts.has(key)) return;
    visitedArtifacts.add(key);
    const { artifact, digest } = await store.read(ref.artifactId, ref.revision);
    if (digest !== ref.lockDigest)
      fail("INVALID", `Artifact lock mismatch: ${key}`);
    for (const dep of artifact.dependencies) {
      const child = `${dep.artifactId}@${dep.revision}`;
      if (closure.get(child) !== dep.lockDigest)
        fail(
          "INVALID",
          `Artifact dependency absent or wrong lock: ${key} -> ${child}`,
        );
      const selected = {
        artifactId: dep.artifactId,
        revision: dep.revision,
        lockDigest: dep.lockDigest,
      };
      if (!localKeys.has(child)) externalSelections.push(selected);
      await walkArtifact(selected);
    }
  };
  for (const ref of selections) await walkArtifact(ref);
  // Historical package contents remain readable. A new release requires trusted
  // approval and current freshness for the exact consumed artifact closure.
  await verifyCurrent();
  const manifest: PackageManifest = {
    format: 1,
    ref: input.ref,
    kind: "design",
    mode: input.mode,
    scope: input.scope,
    schemaVersion: input.schemaVersion,
    approval: input.approval,
    files: fileEntries,
    assets: [],
    artifacts: artifactEntries,
    dependencies: direct,
  };
  const lock: DesignLock = {
    format: 1,
    root: input.ref,
    assets: [],
    artifacts: artifactEntries,
    packages: [...nodes.values()].sort((a, b) =>
      identity(a.ref).localeCompare(identity(b.ref)),
    ),
  };
  const snapshot: PackageSnapshot = {
    manifestBytes: serializePackageDocument(manifest),
    lockBytes: serializePackageDocument(lock),
    files,
    bundled,
  };
  parseManifest(snapshot.manifestBytes);
  parseDesignLock(snapshot.lockBytes);
  const digest = packageDigest(snapshot);
  const source: PackageSource = {
    read: async (ref) =>
      identity(ref) === identity(input.ref)
        ? copySnapshot(snapshot)
        : registry.source.read(ref),
    versions: async (packageId) =>
      packageId === input.ref.packageId
        ? [{ ...input.ref, digest }]
        : registry.source.versions(packageId),
  };
  const verifyResolution = async (): Promise<void> => {
    await registryForSource(source).reconstruct(input.ref, digest);
  };
  return {
    ref: structuredClone(input.ref),
    digest,
    manifest,
    lock,
    inventory: input.inventory,
    qualityDecisions: decisions,
    snapshot: copySnapshot(snapshot),
    verifyCurrent,
    verifyResolution,
  };
}

export interface PublishOptions {
  readonly signal?: AbortSignal;
}
/** Local trusted-host publisher. A per-version mkdir claim serializes cooperating writers. */
export class FilePackagePublisher {
  constructor(readonly root: string) {}
  async publish(
    candidateValue: CompiledPackage,
    authority: ReleaseAuthority,
    options: PublishOptions = {},
  ): Promise<{ ref: PackageRef; digest: string; directory: string }> {
    const candidate = {
      ...candidateValue,
      ref: structuredClone(candidateValue.ref),
      manifest: structuredClone(candidateValue.manifest),
      lock: structuredClone(candidateValue.lock),
      inventory: structuredClone(candidateValue.inventory),
      qualityDecisions: structuredClone(candidateValue.qualityDecisions),
      snapshot: copySnapshot(candidateValue.snapshot),
    };
    if (
      packageDigest(candidate.snapshot) !== candidate.digest ||
      JSON.stringify(candidate.ref) !==
        JSON.stringify(candidate.manifest.ref) ||
      JSON.stringify(parseManifest(candidate.snapshot.manifestBytes)) !==
        JSON.stringify(candidate.manifest) ||
      JSON.stringify(parseDesignLock(candidate.snapshot.lockBytes)) !==
        JSON.stringify(candidate.lock)
    )
      fail("INVALID", "Compiled candidate bytes or metadata changed");
    try {
      const inventory = JSON.parse(
        new TextDecoder().decode(candidate.snapshot.files["inventory.json"]),
      ) as unknown;
      const quality = JSON.parse(
        new TextDecoder().decode(
          candidate.snapshot.files["quality/evidence.json"],
        ),
      ) as { decisions?: unknown };
      if (
        JSON.stringify(inventory) !== JSON.stringify(candidate.inventory) ||
        JSON.stringify(quality.decisions) !==
          JSON.stringify(candidate.qualityDecisions)
      )
        fail(
          "INVALID",
          "Approval review metadata differs from candidate bytes",
        );
    } catch (error) {
      if (error instanceof PackageCompilerError) throw error;
      fail(
        "INVALID",
        `Candidate review metadata cannot be read: ${String(error)}`,
      );
    }
    const checkCancel = (): void => {
      if (options.signal?.aborted) fail("CANCELLED", "Publication cancelled");
    };
    checkCancel();
    await candidate.verifyCurrent();
    const request: ReleaseApprovalRequest = {
      ref: candidate.ref,
      mode: candidate.manifest.mode,
      digest: candidate.digest,
      manifest: candidate.manifest,
      lock: candidate.lock,
      inventory: candidate.inventory,
      qualityDecisions: candidate.qualityDecisions,
    };
    if (!(await authority.verifyRelease(structuredClone(request))))
      fail("UNVERIFIED", "Exact candidate release approval was not verified");
    checkCancel();
    await candidate.verifyCurrent();
    await candidate.verifyResolution();
    await mkdir(this.root, { recursive: true });
    const base = await realpath(this.root);
    if (!(await lstat(this.root)).isDirectory())
      fail("INVALID", "Output root is not a directory");
    let parent = base;
    for (const segment of candidate.ref.packageId.split("/")) {
      parent = path.join(parent, segment);
      await mkdir(parent, { recursive: true });
      const info = await lstat(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(parent)) !== parent
      )
        fail("INVALID", "Package output path is not a trusted directory");
    }
    const target = path.join(parent, candidate.ref.version);
    const stage = path.join(parent, `.stage-${randomUUID()}`);
    const claim = path.join(parent, `.claim-${candidate.ref.version}`);
    let claimed = false;
    try {
      checkCancel();
      await mkdir(claim);
      claimed = true;
      try {
        await lstat(target);
        fail("CONFLICT", `Release already exists: ${identity(candidate.ref)}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(stage);
      await writeSnapshot(stage, candidate.snapshot);
      checkCancel();
      await candidate.verifyCurrent();
      await candidate.verifyResolution();
      if (packageDigest(candidate.snapshot) !== candidate.digest)
        fail("INVALID", "Candidate bytes changed before commit");
      checkCancel();
      await rename(stage, target);
      return {
        ref: structuredClone(candidate.ref),
        digest: candidate.digest,
        directory: target,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        fail(
          "CONFLICT",
          `Concurrent release claim: ${identity(candidate.ref)}`,
        );
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
      if (claimed) await rm(claim, { recursive: true, force: true });
    }
  }
}
async function writeSnapshot(
  dir: string,
  snapshot: PackageSnapshot,
): Promise<void> {
  await writeFile(path.join(dir, "manifest.json"), snapshot.manifestBytes, {
    flag: "wx",
  });
  await writeFile(path.join(dir, "design.lock.yaml"), snapshot.lockBytes, {
    flag: "wx",
  });
  for (const [name, bytes] of Object.entries(snapshot.files)) {
    ensure(validPath(name), `Unsafe package path: ${name}`);
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), bytes, { flag: "wx" });
  }
  for (const [name, child] of Object.entries(snapshot.bundled ?? {})) {
    const childDir = path.join(dir, "bundled", name);
    await mkdir(childDir, { recursive: true });
    await writeSnapshot(childDir, child);
  }
}
