import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import { parseArtifactYaml } from "../artifact-codec.js";
import type { ScopeNode } from "../artifact-store.js";
import type { SchemaRegistry } from "../schema-registry.js";

export type UpgradeImpact = "NONE" | "SAFE" | "REVIEW_REQUIRED" | "BREAKING";
export type Distribution = "bundled" | "external";
export type PackageKind = "design" | "design-system" | "knowledge" | "schema";
export type PackageMode = "reference" | "portable";
export interface PackageRef {
  readonly packageId: string;
  readonly version: string;
}
export interface AssetRef extends PackageRef {
  readonly assetId: string;
  readonly assetVersion: string;
}
export interface FileEntry {
  readonly path: string;
  readonly digest: string;
}
export interface AssetEntry extends FileEntry {
  readonly assetId: string;
  readonly version: string;
}
export interface ArtifactEntry extends FileEntry {
  readonly artifactId: string;
  readonly revision: number;
  readonly schemaVersion: string;
  readonly snapshotDigest: string;
}
export interface LockedDependency {
  readonly ref: PackageRef;
  readonly digest: string;
  readonly source: string;
  readonly license: string;
  readonly distribution: Distribution;
}
export interface PackageManifest {
  readonly format: 1;
  readonly ref: PackageRef;
  readonly kind: PackageKind;
  readonly mode: PackageMode;
  readonly scope: ScopeNode;
  readonly schemaVersion: string;
  readonly approval: {
    readonly decisionId: string;
    readonly actorId: string;
    readonly at: string;
  };
  readonly files: readonly FileEntry[];
  readonly assets: readonly AssetEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly dependencies: readonly LockedDependency[];
}
export interface LockNode extends LockedDependency {
  readonly scope: ScopeNode;
  readonly schemaVersion: string;
  readonly assets: readonly AssetEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly dependencies: readonly PackageRef[];
}
export interface DesignLock {
  readonly format: 1;
  readonly root: PackageRef;
  readonly assets: readonly AssetEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly packages: readonly LockNode[];
}
export interface PackageSnapshot {
  readonly manifestBytes: Uint8Array;
  readonly lockBytes: Uint8Array;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly bundled?: Readonly<Record<string, PackageSnapshot>>;
}
export interface ResolvedPackage {
  readonly manifest: PackageManifest;
  readonly snapshot: PackageSnapshot;
  readonly digest: string;
}
export interface VersionCandidate extends PackageRef {
  readonly digest: string;
}
export interface PackageSource {
  read(ref: PackageRef): Promise<PackageSnapshot | undefined>;
  versions(packageId: string): Promise<readonly VersionCandidate[]>;
}
export interface PackageAuthority {
  verifyRelease(manifest: PackageManifest): Promise<boolean>;
  verifyPromotion(record: PromotionRecord): Promise<boolean>;
}
export interface PromotionRecord {
  readonly source: AssetRef & {
    readonly digest: string;
    readonly scope: ScopeNode;
  };
  readonly destination: AssetRef & { readonly scope: ScopeNode };
  readonly compatibilityReview: string;
  readonly licenseReview: string;
  readonly approval: PackageManifest["approval"];
}
export interface RegistryOptions {
  readonly scopes: readonly ScopeNode[];
  readonly supportedSchemaVersions: readonly string[];
  readonly artifactSchemas?: SchemaRegistry;
  readonly authority: PackageAuthority;
  readonly licenseAllowed: (
    license: string,
    distribution: Distribution,
  ) => boolean | Promise<boolean>;
}
export class PackageRegistryError extends Error {
  constructor(
    readonly code: "INVALID" | "UNAVAILABLE" | "CORRUPT" | "UNVERIFIED",
    message: string,
  ) {
    super(message);
    this.name = "PackageRegistryError";
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message: string): never {
  throw new PackageRegistryError("INVALID", message);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) invalid(message);
}
function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected mapping",
  );
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  const entry = object(value);
  assert(
    Object.keys(entry).sort().join("|") === [...names].sort().join("|"),
    `Unexpected fields: ${Object.keys(entry).join(",")}`,
  );
  return entry;
}
function text(value: unknown): asserts value is string {
  assert(
    typeof value === "string" && value.length > 0,
    "Expected nonempty text",
  );
}
function digest(value: unknown): asserts value is string {
  assert(
    typeof value === "string" && DIGEST.test(value),
    "Invalid SHA-256 digest",
  );
}
function semver(value: unknown): asserts value is string {
  assert(
    typeof value === "string" && SEMVER.test(value),
    "Exact MAJOR.MINOR.PATCH version required",
  );
}
function packageRef(value: unknown): asserts value is PackageRef {
  const ref = fields(value, ["packageId", "version"]);
  assert(
    typeof ref.packageId === "string" && ID.test(ref.packageId),
    "Invalid package ID",
  );
  semver(ref.version);
}
function key(ref: PackageRef): string {
  return `${ref.packageId}@${ref.version}`;
}
function scope(value: unknown): asserts value is ScopeNode {
  const node = object(value);
  fields(
    node,
    node.level === "organization"
      ? ["level", "ownerId"]
      : ["level", "ownerId", "parentId"],
  );
  assert(
    ["organization", "product", "domain", "local"].includes(String(node.level)),
    "Invalid scope level",
  );
  assert(
    typeof node.ownerId === "string" && ID.test(node.ownerId),
    "Invalid scope owner",
  );
  if (node.level !== "organization")
    assert(
      typeof node.parentId === "string" && ID.test(node.parentId),
      "Invalid parent scope",
    );
}
function filePath(value: unknown): asserts value is string {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      !value.includes("\0"),
    "Invalid package path",
  );
  assert(
    value !== "manifest.json" && value !== "design.lock.yaml",
    "Reserved package path",
  );
}
function fileEntry(value: unknown): asserts value is FileEntry {
  const entry = fields(value, ["path", "digest"]);
  filePath(entry.path);
  digest(entry.digest);
}
function assetEntry(value: unknown): asserts value is AssetEntry {
  const entry = fields(value, ["assetId", "version", "path", "digest"]);
  filePath(entry.path);
  digest(entry.digest);
  assert(
    typeof entry.assetId === "string" && ASSET_ID.test(entry.assetId),
    "Invalid asset ID",
  );
  semver(entry.version);
}
function artifactEntry(value: unknown): asserts value is ArtifactEntry {
  const entry = fields(value, [
    "artifactId",
    "revision",
    "schemaVersion",
    "snapshotDigest",
    "path",
    "digest",
  ]);
  filePath(entry.path);
  digest(entry.digest);
  digest(entry.snapshotDigest);
  semver(entry.schemaVersion);
  assert(
    typeof entry.artifactId === "string" &&
      /^art_[A-Za-z0-9_-]+$/.test(entry.artifactId),
    "Invalid artifact ID",
  );
  assert(
    Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 1,
    "Artifact revision must be a positive integer",
  );
}
function array<T>(
  value: unknown,
  verify: (item: unknown) => asserts item is T,
): asserts value is T[] {
  assert(Array.isArray(value), "Expected array");
  for (const item of value) verify(item);
}
function unique(values: readonly string[], what: string): void {
  assert(new Set(values).size === values.length, `Duplicate ${what}`);
}
function dependency(value: unknown): asserts value is LockedDependency {
  const entry = fields(value, [
    "ref",
    "digest",
    "source",
    "license",
    "distribution",
  ]);
  packageRef(entry.ref);
  digest(entry.digest);
  text(entry.source);
  text(entry.license);
  assert(
    entry.distribution === "bundled" || entry.distribution === "external",
    "Invalid distribution",
  );
}
function entries(value: Record<string, unknown>): void {
  array(value.files, fileEntry);
  array(value.assets, assetEntry);
  array(value.artifacts, artifactEntry);
  unique(
    value.files.map((item) => item.path),
    "file path",
  );
  unique(
    value.assets.map((item) => item.assetId),
    "asset ID",
  );
  unique(
    value.artifacts.map((item) => `${item.artifactId}@${item.revision}`),
    "artifact revision",
  );
  const all = [...value.files, ...value.assets, ...value.artifacts];
  unique(
    all.map((item) => item.path),
    "package path",
  );
}
function parseJson(bytes: Uint8Array): unknown {
  try {
    const source = decoder.decode(bytes);
    const value: unknown = JSON.parse(source);
    assert(
      JSON.stringify(value, null, 2) + "\n" === source,
      "Noncanonical JSON/YAML bytes",
    );
    return value;
  } catch (error) {
    throw new PackageRegistryError(
      "CORRUPT",
      `Invalid package document: ${String(error)}`,
    );
  }
}
export function serializePackageDocument(
  value: PackageManifest | DesignLock,
): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2) + "\n");
}
export function parseManifest(bytes: Uint8Array): PackageManifest {
  const value = fields(parseJson(bytes), [
    "format",
    "ref",
    "kind",
    "mode",
    "scope",
    "schemaVersion",
    "approval",
    "files",
    "assets",
    "artifacts",
    "dependencies",
  ]);
  assert(value.format === 1, "Unsupported manifest format");
  packageRef(value.ref);
  scope(value.scope);
  semver(value.schemaVersion);
  assert(
    ["design", "design-system", "knowledge", "schema"].includes(
      String(value.kind),
    ),
    "Invalid package kind",
  );
  assert(
    value.mode === "reference" || value.mode === "portable",
    "Invalid package mode",
  );
  const approval = fields(value.approval, ["decisionId", "actorId", "at"]);
  text(approval.decisionId);
  text(approval.actorId);
  text(approval.at);
  assert(!Number.isNaN(Date.parse(approval.at)), "Invalid approval time");
  entries(value);
  array(value.dependencies, dependency);
  unique(
    value.dependencies.map((item) => key(item.ref)),
    "dependency identity",
  );
  const root = key(value.ref);
  assert(
    !value.dependencies.some((item) => key(item.ref) === root),
    "Self dependency",
  );
  return value as unknown as PackageManifest;
}
function lockNode(value: unknown): asserts value is LockNode {
  const node = fields(value, [
    "ref",
    "digest",
    "source",
    "license",
    "distribution",
    "scope",
    "schemaVersion",
    "assets",
    "artifacts",
    "dependencies",
  ]);
  dependency({
    ref: node.ref,
    digest: node.digest,
    source: node.source,
    license: node.license,
    distribution: node.distribution,
  });
  scope(node.scope);
  semver(node.schemaVersion);
  array(node.assets, assetEntry);
  array(node.artifacts, artifactEntry);
  array(node.dependencies, packageRef);
  unique(
    node.assets.map((item) => item.assetId),
    "locked asset ID",
  );
  unique(
    node.artifacts.map((item) => `${item.artifactId}@${item.revision}`),
    "locked artifact revision",
  );
  unique(node.dependencies.map(key), "locked dependency edge");
}
export function parseDesignLock(bytes: Uint8Array): DesignLock {
  const value = fields(parseJson(bytes), [
    "format",
    "root",
    "assets",
    "artifacts",
    "packages",
  ]);
  assert(value.format === 1, "Unsupported lock format");
  packageRef(value.root);
  array(value.assets, assetEntry);
  array(value.artifacts, artifactEntry);
  array(value.packages, lockNode);
  unique(
    value.packages.map((node) => key(node.ref)),
    "locked package identity",
  );
  const root = key(value.root);
  assert(
    !value.packages.some((node) => key(node.ref) === root),
    "Root listed as dependency",
  );
  return value as unknown as DesignLock;
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
// mimic-package-bytes-v1: SHA-256 over a domain prefix and sorted path/byte frames.
// Each frame is uint64 big-endian UTF-8 path length, path, uint64 byte length, bytes.
export function packageDigest(snapshot: PackageSnapshot): string {
  const paths = Object.keys(snapshot.files);
  unique(paths, "snapshot file path");
  paths.forEach(filePath);
  const frames: [string, Uint8Array][] = [];
  const collect = (item: PackageSnapshot, prefix: string): void => {
    frames.push(
      [`${prefix}design.lock.yaml`, item.lockBytes],
      [`${prefix}manifest.json`, item.manifestBytes],
    );
    for (const [name, bytes] of Object.entries(item.files)) {
      filePath(name);
      frames.push([`${prefix}${name}`, bytes]);
    }
    for (const [identity, nested] of Object.entries(item.bundled ?? {})) {
      assert(
        /^[A-Za-z0-9%._@-]+$/.test(identity) &&
          identity !== "." &&
          identity !== "..",
        "Invalid bundled identity",
      );
      collect(nested, `${prefix}bundled/${identity}/`);
    }
  };
  collect(snapshot, "");
  frames.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  unique(
    frames.map(([name]) => name),
    "package byte path",
  );
  const hash = createHash("sha256").update(
    encoder.encode("mimic-package-bytes-v1\0"),
  );
  for (const [name, bytes] of frames) {
    assert(bytes instanceof Uint8Array, `Invalid bytes: ${name}`);
    const nameBytes = encoder.encode(name);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(nameBytes.length));
    hash.update(length);
    hash.update(nameBytes);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function structure(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(structure).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${structure(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown): boolean {
  return structure(a) === structure(b);
}
function copySnapshot(snapshot: PackageSnapshot): PackageSnapshot {
  return {
    manifestBytes: Uint8Array.from(snapshot.manifestBytes),
    lockBytes: Uint8Array.from(snapshot.lockBytes),
    files: Object.fromEntries(
      Object.entries(snapshot.files).map(([name, bytes]) => [
        name,
        Uint8Array.from(bytes),
      ]),
    ),
    bundled: Object.fromEntries(
      Object.entries(snapshot.bundled ?? {}).map(([name, child]) => [
        name,
        copySnapshot(child),
      ]),
    ),
  };
}
function compareVersion(a: string, b: string): number {
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}
export function assessUpgrade(
  from: PackageRef,
  to: PackageRef,
  reviewedImpact?: UpgradeImpact,
): UpgradeImpact {
  packageRef(from);
  packageRef(to);
  assert(from.packageId === to.packageId, "Upgrade must retain package ID");
  if (from.version === to.version) return "NONE";
  assert(
    compareVersion(from.version, to.version) < 0,
    "Upgrade target must be newer",
  );
  if (from.version.split(".")[0] !== to.version.split(".")[0])
    return "BREAKING";
  return reviewedImpact && reviewedImpact !== "NONE"
    ? reviewedImpact
    : "REVIEW_REQUIRED";
}

export class FilePackageSource implements PackageSource {
  constructor(readonly root: string) {}
  private directory(ref: PackageRef): string {
    packageRef(ref);
    return path.join(this.root, ...ref.packageId.split("/"), ref.version);
  }
  async versions(packageId: string): Promise<readonly VersionCandidate[]> {
    assert(ID.test(packageId), "Invalid package ID");
    try {
      const names = (
        await readdir(path.join(this.root, ...packageId.split("/")))
      ).filter((name) => SEMVER.test(name));
      const candidates: VersionCandidate[] = [];
      for (const version of names) {
        const snapshot = await this.read({ packageId, version });
        if (snapshot)
          candidates.push({
            packageId,
            version,
            digest: packageDigest(snapshot),
          });
      }
      return candidates.sort((a, b) => compareVersion(a.version, b.version));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async read(ref: PackageRef): Promise<PackageSnapshot | undefined> {
    const dir = this.directory(ref);
    try {
      return await this.readDirectory(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async readDirectory(dir: string): Promise<PackageSnapshot> {
    const base = await realpath(dir);
    assert(
      base.startsWith(`${await realpath(this.root)}${path.sep}`),
      "Package directory escapes storage root",
    );
    const manifestBytes = await readRegular(
      path.join(dir, "manifest.json"),
      base,
    );
    const lockBytes = await readRegular(
      path.join(dir, "design.lock.yaml"),
      base,
    );
    const manifest = parseManifest(manifestBytes);
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const entry of [
      ...manifest.files,
      ...manifest.assets,
      ...manifest.artifacts,
    ])
      files[entry.path] = await readRegular(path.join(dir, entry.path), base);
    const bundled: Record<string, PackageSnapshot> = Object.create(null);
    for (const edge of manifest.dependencies.filter(
      (item) => item.distribution === "bundled",
    )) {
      const identity = bundledKey(edge.ref);
      bundled[identity] = await this.readDirectory(
        path.join(dir, "bundled", identity),
      );
    }
    return { manifestBytes, lockBytes, files, bundled };
  }
}
function bundledKey(ref: PackageRef): string {
  return `${encodeURIComponent(ref.packageId)}@${ref.version}`;
}
async function readRegular(file: string, base: string): Promise<Uint8Array> {
  const actual = await realpath(file);
  assert(
    actual.startsWith(`${base}${path.sep}`),
    "Package file escapes storage directory",
  );
  assert((await lstat(file)).isFile(), `Not a regular package file: ${file}`);
  return readFile(file);
}

export class PackageRegistry {
  private readonly scopes = new Map<string, ScopeNode>();
  constructor(
    readonly source: PackageSource,
    readonly options: RegistryOptions,
  ) {
    for (const node of options.scopes) {
      scope(node);
      assert(!this.scopes.has(node.ownerId), "Duplicate scope owner");
      this.scopes.set(node.ownerId, node);
    }
    for (const node of options.scopes) this.ancestors(node);
  }
  private ancestors(node: ScopeNode): string[] {
    const levels = ["organization", "product", "domain", "local"];
    const owners: string[] = [];
    let current: ScopeNode | undefined = node;
    for (let index = levels.indexOf(node.level); index >= 0; index--) {
      assert(
        current?.level === levels[index] && !owners.includes(current.ownerId),
        "Invalid scope ancestry",
      );
      owners.push(current.ownerId);
      current = current.parentId
        ? this.scopes.get(current.parentId)
        : undefined;
    }
    assert(current === undefined, "Invalid scope root");
    return owners;
  }
  private verifyScope(node: ScopeNode): void {
    const registered = this.scopes.get(node.ownerId);
    assert(registered && same(registered, node), "Unregistered package scope");
  }
  private async acquire(
    ref: PackageRef,
    expectedDigest: string,
    supplied?: PackageSnapshot,
  ): Promise<{
    snapshot: PackageSnapshot;
    manifest: PackageManifest;
    lock: DesignLock;
  }> {
    packageRef(ref);
    digest(expectedDigest);
    let snapshot: PackageSnapshot | undefined;
    try {
      snapshot = supplied ?? (await this.source.read(ref));
    } catch (error) {
      throw new PackageRegistryError(
        "UNAVAILABLE",
        `Cannot acquire ${key(ref)}: ${String(error)}`,
      );
    }
    if (!snapshot)
      throw new PackageRegistryError(
        "UNAVAILABLE",
        `Package unavailable: ${key(ref)}`,
      );
    try {
      snapshot = copySnapshot(snapshot);
      assert(
        packageDigest(snapshot) === expectedDigest,
        `Package byte digest mismatch: ${key(ref)}`,
      );
      const manifest = parseManifest(snapshot.manifestBytes),
        lock = parseDesignLock(snapshot.lockBytes);
      assert(
        same(manifest.ref, ref) && same(lock.root, ref),
        `Package identity mismatch: ${key(ref)}`,
      );
      this.verifyScope(manifest.scope);
      assert(
        this.options.supportedSchemaVersions.includes(manifest.schemaVersion),
        "Incompatible package schema",
      );
      const listed = [
        ...manifest.files,
        ...manifest.assets,
        ...manifest.artifacts,
      ];
      assert(
        same(
          Object.keys(snapshot.files).sort(),
          listed.map((item) => item.path).sort(),
        ),
        "Package file inventory mismatch",
      );
      assert(
        same(
          Object.keys(snapshot.bundled ?? {}).sort(),
          manifest.dependencies
            .filter((edge) => edge.distribution === "bundled")
            .map((edge) => bundledKey(edge.ref))
            .sort(),
        ),
        "Bundled dependency inventory mismatch",
      );
      for (const entry of listed)
        assert(
          sha256(snapshot.files[entry.path]!) === entry.digest,
          `File digest mismatch: ${entry.path}`,
        );
      for (const artifact of manifest.artifacts) {
        assert(
          this.options.supportedSchemaVersions.includes(artifact.schemaVersion),
          "Incompatible artifact schema",
        );
        if (!this.options.artifactSchemas)
          throw new PackageRegistryError(
            "UNVERIFIED",
            "Artifact schema registry unavailable",
          );
        const parsed = parseArtifactYaml(
          decoder.decode(snapshot.files[artifact.path]!),
        );
        const document = object(parsed);
        const meta = object(document.meta);
        assert(
          meta.id === artifact.artifactId &&
            meta.revision === artifact.revision &&
            meta.schemaVersion === artifact.schemaVersion,
          "Artifact identity or schema mismatch",
        );
        const snapshotDigest = artifactDigest(parsed);
        assert(
          snapshotDigest === artifact.snapshotDigest &&
            (meta.contentDigest === undefined ||
              meta.contentDigest === snapshotDigest),
          "Artifact snapshot digest mismatch",
        );
        scope(document.scope);
        this.verifyScope(document.scope);
        assert(
          this.ancestors(manifest.scope).includes(document.scope.ownerId),
          "Artifact is out of package scope",
        );
        assert(
          this.options.artifactSchemas.validate(parsed).valid,
          "Artifact schema validation failed",
        );
      }
      assert(
        same(lock.assets, manifest.assets) &&
          same(lock.artifacts, manifest.artifacts),
        "Root lock inventory mismatch",
      );
      let trusted = false;
      try {
        trusted = await this.options.authority.verifyRelease(manifest);
      } catch {
        /* unavailable authority fails closed */
      }
      if (!trusted)
        throw new PackageRegistryError(
          "UNVERIFIED",
          `Release approval unverified: ${key(ref)}`,
        );
      return { snapshot, manifest, lock };
    } catch (error) {
      if (error instanceof PackageRegistryError && error.code === "UNVERIFIED")
        throw error;
      throw new PackageRegistryError(
        "CORRUPT",
        `Invalid package ${key(ref)}: ${String(error)}`,
      );
    }
  }
  async reconstruct(
    ref: PackageRef,
    expectedDigest: string,
  ): Promise<readonly ResolvedPackage[]> {
    const root = await this.acquire(ref, expectedDigest);
    const nodes = new Map(
      root.lock.packages.map((node) => [key(node.ref), node]),
    );
    const found = new Map<string, PackageManifest>([[key(ref), root.manifest]]);
    const snapshots = new Map<string, PackageSnapshot>([
      [key(ref), root.snapshot],
    ]);
    const visiting = new Set<string>();
    const walk = async (current: PackageManifest): Promise<void> => {
      const currentKey = key(current.ref);
      assert(!visiting.has(currentKey), "Dependency cycle");
      visiting.add(currentKey);
      for (const edge of current.dependencies) {
        const id = key(edge.ref),
          node = nodes.get(id);
        assert(
          node &&
            same(edge, {
              ref: node.ref,
              digest: node.digest,
              source: node.source,
              license: node.license,
              distribution: node.distribution,
            }),
          `Missing or conflicting lock edge: ${id}`,
        );
        this.verifyScope(node.scope);
        assert(
          this.ancestors(current.scope).includes(node.scope.ownerId),
          `Out-of-scope dependency: ${id}`,
        );
        let allowed = false;
        try {
          allowed = await this.options.licenseAllowed(
            edge.license,
            edge.distribution,
          );
        } catch {
          /* unavailable policy fails closed */
        }
        assert(allowed, `License prohibits dependency: ${id}`);
        if (current.mode === "portable")
          assert(
            edge.distribution === "bundled",
            `Portable package has external dependency: ${id}`,
          );
        if (visiting.has(id)) invalid(`Dependency cycle: ${id}`);
        if (edge.distribution === "bundled") {
          const nested =
            snapshots.get(currentKey)?.bundled?.[bundledKey(edge.ref)];
          assert(
            nested && packageDigest(nested) === edge.digest,
            `Bundled dependency mismatch: ${id}`,
          );
        }
        if (!found.has(id)) {
          const bundled =
            edge.distribution === "bundled"
              ? snapshots.get(currentKey)?.bundled?.[bundledKey(edge.ref)]
              : undefined;
          if (edge.distribution === "bundled")
            assert(bundled, `Bundled dependency missing: ${id}`);
          const acquired = await this.acquire(edge.ref, edge.digest, bundled);
          const manifest = acquired.manifest;
          assert(
            same(manifest.scope, node.scope) &&
              manifest.schemaVersion === node.schemaVersion &&
              same(manifest.assets, node.assets) &&
              same(manifest.artifacts, node.artifacts) &&
              same(
                manifest.dependencies.map((dep) => dep.ref),
                node.dependencies,
              ),
            `Locked metadata mismatch: ${id}`,
          );
          assert(
            acquired.lock.packages.every((child) => {
              const parentNode = nodes.get(key(child.ref));
              return parentNode && same(parentNode, child);
            }),
            `Nested lock conflict: ${id}`,
          );
          found.set(id, manifest);
          snapshots.set(id, acquired.snapshot);
          await walk(manifest);
        }
      }
      visiting.delete(currentKey);
    };
    await walk(root.manifest);
    assert(found.size === nodes.size + 1, "Lock contains unreachable package");
    for (const [id, manifest] of found) {
      if (id === key(ref)) continue;
      const reachable = new Set<string>();
      const visit = (item: PackageManifest): void => {
        for (const edge of item.dependencies) {
          const child = key(edge.ref);
          if (!reachable.has(child)) {
            reachable.add(child);
            visit(found.get(child)!);
          }
        }
      };
      visit(manifest);
      const nested = parseDesignLock(snapshots.get(id)!.lockBytes);
      assert(
        same(
          nested.packages.map((node) => key(node.ref)).sort(),
          [...reachable].sort(),
        ),
        `Nested lock closure mismatch: ${id}`,
      );
    }
    return [...found].map(([id, manifest]) => ({
      manifest,
      snapshot: snapshots.get(id)!,
      digest: id === key(ref) ? expectedDigest : nodes.get(id)!.digest,
    }));
  }
  async resolve(
    ref: PackageRef,
    expectedDigest: string,
  ): Promise<readonly PackageManifest[]> {
    return (await this.reconstruct(ref, expectedDigest)).map(
      (item) => item.manifest,
    );
  }
  async resolveAsset(
    root: PackageRef,
    digest: string,
    asset: AssetRef,
  ): Promise<{ entry: AssetEntry; bytes: Uint8Array }> {
    packageRef({ packageId: asset.packageId, version: asset.version });
    assert(ASSET_ID.test(asset.assetId), "Invalid asset ID");
    semver(asset.assetVersion);
    const found = (await this.reconstruct(root, digest)).find((item) =>
      same(item.manifest.ref, {
        packageId: asset.packageId,
        version: asset.version,
      }),
    );
    const entry = found?.manifest.assets.find(
      (item) =>
        item.assetId === asset.assetId && item.version === asset.assetVersion,
    );
    if (!entry || !found)
      throw new PackageRegistryError(
        "UNAVAILABLE",
        "Exact asset unavailable in lock",
      );
    return { entry, bytes: Uint8Array.from(found.snapshot.files[entry.path]!) };
  }
  async resolveArtifact(
    root: PackageRef,
    digest: string,
    owner: PackageRef,
    artifactId: string,
    revision: number,
  ): Promise<{ entry: ArtifactEntry; bytes: Uint8Array }> {
    packageRef(owner);
    assert(
      /^art_[A-Za-z0-9_-]+$/.test(artifactId) &&
        Number.isSafeInteger(revision) &&
        revision >= 1,
      "Invalid artifact reference",
    );
    const found = (await this.reconstruct(root, digest)).find((item) =>
      same(item.manifest.ref, owner),
    );
    const entry = found?.manifest.artifacts.find(
      (item) => item.artifactId === artifactId && item.revision === revision,
    );
    if (!entry || !found)
      throw new PackageRegistryError(
        "UNAVAILABLE",
        "Exact artifact revision unavailable in lock",
      );
    return { entry, bytes: Uint8Array.from(found.snapshot.files[entry.path]!) };
  }
  async recommendForNewProject(
    packageId: string,
    consumer: ScopeNode,
  ): Promise<VersionCandidate | undefined> {
    assert(ID.test(packageId), "Invalid package ID");
    this.verifyScope(consumer);
    const versions = await this.source.versions(packageId);
    for (const candidate of [...versions].sort((a, b) =>
      compareVersion(b.version, a.version),
    )) {
      const identity = {
        packageId: candidate.packageId,
        version: candidate.version,
      };
      packageRef(identity);
      digest(candidate.digest);
      assert(
        candidate.packageId === packageId,
        "Discovery returned wrong package ID",
      );
      const manifest = (await this.acquire(identity, candidate.digest))
        .manifest;
      if (this.ancestors(consumer).includes(manifest.scope.ownerId)) {
        await this.reconstruct(identity, candidate.digest);
        return candidate;
      }
    }
    return undefined;
  }
  async verifyPromotion(record: PromotionRecord): Promise<void> {
    packageRef({
      packageId: record.source.packageId,
      version: record.source.version,
    });
    packageRef({
      packageId: record.destination.packageId,
      version: record.destination.version,
    });
    semver(record.source.assetVersion);
    semver(record.destination.assetVersion);
    digest(record.source.digest);
    assert(
      ASSET_ID.test(record.source.assetId) &&
        ASSET_ID.test(record.destination.assetId),
      "Invalid asset ID",
    );
    this.verifyScope(record.source.scope);
    this.verifyScope(record.destination.scope);
    const source = record.source.scope,
      target = record.destination.scope;
    assert(
      ((source.level === "local" || source.level === "domain") &&
        target.level === "product") ||
        (source.level === "product" && target.level === "organization"),
      "Promotion must follow approved scope steps",
    );
    assert(
      this.ancestors(source).includes(target.ownerId),
      "Promotion target is not an ancestor",
    );
    text(record.compatibilityReview);
    text(record.licenseReview);
    text(record.approval.actorId);
    text(record.approval.decisionId);
    text(record.approval.at);
    let trusted = false;
    try {
      trusted = await this.options.authority.verifyPromotion(record);
    } catch {
      /* unavailable authority fails closed */
    }
    if (!trusted)
      throw new PackageRegistryError(
        "UNVERIFIED",
        "Promotion approval unverified",
      );
  }
}
