import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  compilePackage,
  FilePackagePublisher,
  FilePackageSource,
  INVENTORY_CATEGORIES,
  packageDigest,
  PackageRegistry,
  parseDesignLock,
  parseManifest,
  sha256,
  type ArtifactStore,
  type CompileInput,
  type InventoryCategory,
  type InventorySelection,
  type PackageAuthority,
  type PackageRef,
  type PackageSource,
  type QualityEvidence,
  type RedistributionGrant,
  type ReleaseApprovalRequest,
  type ReleasePolicy,
  type SchemaRegistry,
  type ScopeNode,
} from "@mimic/core";
import { atomicCreateJson } from "./atomic-file.js";
import {
  authorizeDependencies,
  reviewDependencies,
  type AuthorizedDependencies,
  type DependencyConfirmation,
  type DependencyContext,
  type DependencyNodeReview,
} from "./release-dependencies.js";

/** All policy callbacks and redistribution grants come from a trusted embedding host. */
export interface ReleaseHost {
  readonly packageAuthority: PackageAuthority;
  readonly licenseAllowed: (
    license: string,
    distribution: "external" | "bundled",
  ) => boolean | Promise<boolean>;
  readonly policy: ReleasePolicy;
  readonly redistribution?: readonly RedistributionGrant[];
  /** Trusted host fault hook; an identical retry recovers after publication. */
  readonly afterPublished?: () => void;
}
export interface ReleasePlan {
  readonly ref: PackageRef;
  readonly mode: CompileInput["mode"];
  readonly scope: CompileInput["scope"];
  readonly schemaVersion: string;
  readonly approval: CompileInput["approval"];
  readonly inventory: Readonly<Record<InventoryCategory, InventorySelection>>;
  /** Workspace-relative paths to exact package-owned bytes. */
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies: CompileInput["dependencies"];
  readonly quality: readonly {
    readonly report: string;
    readonly artifacts: QualityEvidence["artifacts"];
  }[];
}
export interface ReleaseConfirmation {
  readonly version: 1;
  readonly action: "release";
  readonly hostId: string;
  readonly humanActorId: string;
  readonly confirmedAt: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly mode: CompileInput["mode"];
  readonly digest: string;
  readonly destination: string;
}
/** Cooperative controlling-host policy for a dependency-free local candidate. */
export interface LocalReleasePolicyConfirmation {
  readonly version: 1;
  readonly action: "release-policy";
  readonly hostId: string;
  readonly confirmedAt: string;
  readonly planDigest: string;
  readonly decisions: readonly {
    readonly reportDigest: string;
    readonly findingIndex: number;
    readonly findingDigest: string;
    readonly criterion: string;
    readonly state: "PASS" | "CONCERN" | "FAIL" | "UNVERIFIED" | "N/A";
    readonly severity: "BLOCKER" | "MAJOR" | "MINOR" | "NOTE";
    readonly blockRelease: boolean;
    readonly reason: string;
  }[];
}
interface FrozenInput extends Omit<CompileInput, "files"> {
  readonly files: Readonly<Record<string, string>>;
}
interface Prepared {
  readonly format: 1;
  readonly id: string;
  readonly destination: string;
  readonly planDigest: string;
  readonly preparedAt: string;
  readonly frozen: FrozenInput;
  readonly request: ReleaseApprovalRequest;
  readonly localPolicy?: LocalReleasePolicyConfirmation;
  readonly dependencyContext?: DependencyContext;
  readonly dependencyConfirmation?: DependencyConfirmation;
}
export class CliReleaseError extends Error {
  constructor(
    readonly code: "INVALID" | "UNSUPPORTED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "CliReleaseError";
  }
}
function check(
  ok: unknown,
  message: string,
  code: CliReleaseError["code"] = "INVALID",
): asserts ok {
  if (!ok) throw new CliReleaseError(code, message);
}
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const same = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const artifactRef = (value: unknown): boolean =>
  record(value) &&
  typeof value.artifactId === "string" &&
  Number.isSafeInteger(value.revision) &&
  typeof value.lockDigest === "string";
const packageRef = (value: unknown): boolean =>
  record(value) &&
  typeof value.packageId === "string" &&
  typeof value.version === "string";
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
function fileFor(root: string, id: string, suffix: string): string {
  check(idPattern.test(id), "Invalid release ID");
  return path.join(root, ".mimic", "releases", `${id}.${suffix}.json`);
}
async function contained(
  root: string,
  name: string,
  directory = false,
): Promise<string> {
  check(typeof name === "string" && name.length > 0, "Missing workspace path");
  const target = path.resolve(root, name);
  check(
    target !== root && target.startsWith(`${root}${path.sep}`),
    "Release path escapes workspace",
  );
  const resolved = await realpath(target);
  check(
    resolved.startsWith(`${root}${path.sep}`),
    "Release path escapes workspace",
  );
  const info = await lstat(target);
  check(
    !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    "Release path has wrong type",
  );
  return resolved;
}
function registry(
  source: PackageSource,
  host: ReleaseHost,
  schemas: SchemaRegistry,
  scopes: readonly ScopeNode[],
): PackageRegistry {
  return new PackageRegistry(source, {
    scopes,
    supportedSchemaVersions: ["1.0.0"],
    artifactSchemas: schemas,
    authority: host.packageAuthority,
    licenseAllowed: host.licenseAllowed,
  });
}
const identity = (ref: PackageRef): string => `${ref.packageId}@${ref.version}`;
function combinedSource(
  destination: string,
  root: PackageRef,
  dependency?: PackageSource,
): PackageSource {
  const published = new FilePackageSource(destination);
  return {
    read: (ref) =>
      identity(ref) === identity(root)
        ? published.read(ref)
        : (dependency?.read(ref) ?? published.read(ref)),
    versions: (packageId) =>
      packageId === root.packageId
        ? published.versions(packageId)
        : (dependency?.versions(packageId) ?? published.versions(packageId)),
  };
}
function localHost(
  policy: LocalReleasePolicyConfirmation,
  prepared?: Prepared,
  dependencies?: AuthorizedDependencies,
): ReleaseHost {
  const positions = new Map<string, number>();
  return {
    packageAuthority: {
      verifyRelease: async (manifest) =>
        (!!prepared && same(manifest, prepared.request.manifest)) ||
        (!!dependencies?.manifests.has(identity(manifest.ref)) &&
          same(dependencies.manifests.get(identity(manifest.ref)), manifest)),
      verifyPromotion: async () => false,
    },
    licenseAllowed: async (license, distribution) =>
      dependencies?.licensePairs.has(`${license}\0${distribution}`) ?? false,
    redistribution: dependencies?.redistribution,
    policy: {
      assess: async (finding, report) => {
        const reportDigest = digest(report);
        const findingIndex = positions.get(reportDigest) ?? 0;
        positions.set(reportDigest, findingIndex + 1);
        check(
          same(report.findings[findingIndex], finding),
          "Local policy finding order or bytes changed",
        );
        const matches = policy.decisions.filter(
          (decision) =>
            decision.reportDigest === reportDigest &&
            decision.findingIndex === findingIndex &&
            decision.findingDigest === digest(finding) &&
            decision.criterion === finding.criterion &&
            decision.state === finding.state &&
            decision.severity === finding.severity,
        );
        check(
          matches.length === 1,
          "Missing or duplicate exact local policy decision",
        );
        return {
          blockRelease: matches[0]!.blockRelease,
          reason: matches[0]!.reason,
        };
      },
    },
  };
}
function checkLocalPolicy(
  policy: LocalReleasePolicyConfirmation,
  planDigest: string,
  quality: readonly QualityEvidence[],
): void {
  check(
    policy &&
      Object.keys(policy).every((key) =>
        [
          "version",
          "action",
          "hostId",
          "confirmedAt",
          "planDigest",
          "decisions",
        ].includes(key),
      ) &&
      policy.version === 1 &&
      policy.action === "release-policy" &&
      typeof policy.hostId === "string" &&
      policy.hostId.trim() !== "" &&
      Number.isFinite(Date.parse(policy.confirmedAt)) &&
      Date.parse(policy.confirmedAt) <= Date.now() &&
      policy.planDigest === planDigest &&
      Array.isArray(policy.decisions),
    "Invalid local release policy assertion",
  );
  check(
    quality.every(
      ({ report }) =>
        Number.isFinite(Date.parse(report.inspectedAt)) &&
        Date.parse(report.inspectedAt) <= Date.parse(policy.confirmedAt),
    ),
    "Local policy predates inspected quality evidence",
  );
  const reportDigests = quality.map(({ report }) => digest(report));
  check(
    new Set(reportDigests).size === reportDigests.length,
    "Duplicate exact quality report",
  );
  const expected = quality.flatMap(({ report }) =>
    report.findings.map((finding, findingIndex) => ({
      reportDigest: digest(report),
      findingIndex,
      findingDigest: digest(finding),
      criterion: finding.criterion,
      state: finding.state,
      severity: finding.severity,
    })),
  );
  check(
    policy.decisions.length === expected.length,
    "Local policy must decide every finding exactly once",
  );
  for (const decision of policy.decisions) {
    check(
      !!decision &&
        typeof decision === "object" &&
        Object.keys(decision).every((key) =>
          [
            "reportDigest",
            "findingIndex",
            "findingDigest",
            "criterion",
            "state",
            "severity",
            "blockRelease",
            "reason",
          ].includes(key),
        ) &&
        typeof decision.blockRelease === "boolean" &&
        Number.isSafeInteger(decision.findingIndex) &&
        typeof decision.reason === "string" &&
        decision.reason.trim() !== "" &&
        expected.filter(
          (item) =>
            item.reportDigest === decision.reportDigest &&
            item.findingIndex === decision.findingIndex &&
            item.findingDigest === decision.findingDigest &&
            item.criterion === decision.criterion &&
            item.state === decision.state &&
            item.severity === decision.severity,
        ).length === 1,
      "Local policy has an unmatched or invalid finding decision",
    );
  }
  const keys = policy.decisions.map(
    (item) => `${item.reportDigest}:${item.findingIndex}:${item.findingDigest}`,
  );
  check(new Set(keys).size === keys.length, "Duplicate local policy decision");
}
async function compile(
  frozen: FrozenInput,
  store: ArtifactStore,
  host: ReleaseHost,
  schemas: SchemaRegistry,
  scopes: readonly ScopeNode[],
  destination: string,
  dependencySource?: PackageSource,
) {
  const input: CompileInput = {
    ...frozen,
    files: Object.fromEntries(
      Object.entries(frozen.files).map(([name, bytes]) => [
        name,
        Uint8Array.from(Buffer.from(bytes, "base64")),
      ]),
    ),
  };
  const source = dependencySource ?? new FilePackageSource(destination);
  const existing = registry(source, host, schemas, scopes);
  return compilePackage(input, store, existing, host.policy, (overlay) =>
    registry(overlay, host, schemas, scopes),
  );
}
function requestOf(
  candidate: Awaited<ReturnType<typeof compile>>,
): ReleaseApprovalRequest {
  return {
    ref: candidate.ref,
    mode: candidate.manifest.mode,
    digest: candidate.digest,
    manifest: candidate.manifest,
    lock: candidate.lock,
    inventory: candidate.inventory,
    qualityDecisions: candidate.qualityDecisions,
  };
}
function releaseFolder(root: string): string {
  return path.join(root, ".mimic", "releases");
}
async function readPrepared(root: string, id: string): Promise<Prepared> {
  const file = fileFor(root, id, "prepared");
  await contained(root, path.relative(root, file));
  const data = JSON.parse(await readFile(file, "utf8")) as Prepared;
  check(
    data?.format === 1 &&
      data.id === id &&
      typeof data.destination === "string" &&
      !!data.request &&
      !!data.frozen,
    "Invalid prepared release",
  );
  return data;
}
async function verifiedLocalPublication(
  root: string,
  node: DependencyNodeReview,
  supplied?: ReleaseConfirmation,
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(releaseFolder(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names.filter((item) => item.endsWith(".completed.json"))) {
    const id = name.slice(0, -".completed.json".length);
    if (!idPattern.test(id)) continue;
    try {
      const prepared = await readPrepared(root, id);
      const externalLocations = node.locations
        .filter((location) => location.kind === "source")
        .map((location) => location.path);
      if (
        prepared.request.digest !== node.digest ||
        !same(prepared.request.ref, node.ref) ||
        (externalLocations.length > 0 &&
          !externalLocations.includes(prepared.destination)) ||
        (externalLocations.length === 0 &&
          !node.locations.some((location) => location.kind === "bundled"))
      )
        continue;
      const intent = JSON.parse(
        await readFile(
          await contained(
            root,
            path.relative(root, fileFor(root, id, "intent")),
          ),
          "utf8",
        ),
      ) as unknown;
      const completion = JSON.parse(
        await readFile(
          await contained(
            root,
            path.relative(root, fileFor(root, id, "completed")),
          ),
          "utf8",
        ),
      ) as unknown;
      if (!record(intent) || !record(completion)) continue;
      const confirmation =
        intent.format === 2
          ? (intent.confirmation as ReleaseConfirmation)
          : supplied;
      if (!confirmation) continue;
      checkConfirmation(prepared, confirmation);
      if (
        intent.preparedDigest !== digest(prepared) ||
        intent.confirmationDigest !== digest(confirmation) ||
        !same(
          completion,
          intent.format === 2
            ? { ...intent, ref: node.ref, digest: node.digest }
            : { ...intent, digest: node.digest },
        ) ||
        (intent.format !== 2 && intent.format !== undefined) ||
        (supplied && !same(supplied, confirmation))
      )
        continue;
      const source = await contained(root, prepared.destination, true);
      const snapshot = await new FilePackageSource(source).read(node.ref);
      if (
        snapshot &&
        packageDigest(snapshot) === node.digest &&
        sha256(snapshot.lockBytes) === node.lockDigest &&
        same(node.manifest, {
          mode: prepared.request.manifest.mode,
          scope: prepared.request.manifest.scope,
          approval: prepared.request.manifest.approval,
        }) &&
        same(
          parseManifest(snapshot.manifestBytes),
          prepared.request.manifest,
        ) &&
        same(parseDesignLock(snapshot.lockBytes), prepared.request.lock)
      )
        return true;
    } catch {
      // An incomplete, changed, or legacy record without its exact confirmation
      // cannot authorize another release.
    }
  }
  return false;
}
async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function completed(
  root: string,
  id: string,
  value: object,
): Promise<void> {
  const file = fileFor(root, id, "completed");
  if (!(await atomicCreateJson(file, value))) {
    const prior = JSON.parse(
      await readFile(await contained(root, path.relative(root, file)), "utf8"),
    ) as unknown;
    check(same(prior, value), "Release completion binding changed", "CONFLICT");
  }
}
export async function prepareRelease(
  root: string,
  id: string,
  destinationName: string,
  plan: ReleasePlan,
  planDigest: string,
  store: ArtifactStore,
  host: ReleaseHost | undefined,
  schemas: SchemaRegistry,
  scopes: readonly ScopeNode[],
  localPolicy?: LocalReleasePolicyConfirmation,
  dependencyConfirmation?: DependencyConfirmation,
): Promise<Prepared> {
  check(
    plan && typeof plan === "object" && !Object.hasOwn(plan, "redistribution"),
    "Invalid release plan",
  );
  check(
    !!plan.ref &&
      typeof plan.ref.packageId === "string" &&
      typeof plan.ref.version === "string" &&
      ["reference", "portable"].includes(plan.mode) &&
      !!plan.scope &&
      typeof plan.scope === "object" &&
      typeof plan.scope.ownerId === "string" &&
      typeof plan.schemaVersion === "string" &&
      !!plan.approval &&
      typeof plan.approval === "object" &&
      typeof plan.approval.decisionId === "string" &&
      typeof plan.approval.actorId === "string" &&
      !!plan.inventory &&
      typeof plan.inventory === "object" &&
      !Array.isArray(plan.inventory) &&
      INVENTORY_CATEGORIES.every((category) => {
        const item = plan.inventory[category];
        if (!record(item)) return false;
        if (item.status === "absent") return typeof item.reason === "string";
        return (
          item.status === "included" &&
          Array.isArray(item.artifacts) &&
          item.artifacts.every(artifactRef) &&
          Array.isArray(item.files) &&
          item.files.every((file) => typeof file === "string") &&
          Array.isArray(item.dependencies) &&
          item.dependencies.every(packageRef)
        );
      }),
    "Invalid release plan structure",
  );
  check(
    plan.files && typeof plan.files === "object" && !Array.isArray(plan.files),
    "Invalid release files",
  );
  check(
    Object.values(plan.files).every((file) => typeof file === "string"),
    "Invalid release file path",
  );
  check(
    Array.isArray(plan.dependencies) &&
      plan.dependencies.every(
        (item) =>
          record(item) &&
          packageRef(item.ref) &&
          typeof item.digest === "string" &&
          typeof item.source === "string" &&
          typeof item.license === "string",
      ),
    "Invalid release dependencies",
  );
  check(Array.isArray(plan.quality), "Invalid release evidence");
  check(
    host || localPolicy,
    "Release policy and package authority are unavailable",
    "UNSUPPORTED",
  );
  check(
    !(host && localPolicy),
    "Local and injected release policies cannot be mixed",
  );
  check(
    !(host && dependencyConfirmation) &&
      (plan.dependencies.length > 0 || !dependencyConfirmation),
    "Dependency confirmation does not match the release path",
  );
  const destination = await contained(root, destinationName, true);
  const files: Record<string, string> = {};
  for (const [name, file] of Object.entries(plan.files))
    files[name] = (await readFile(await contained(root, file))).toString(
      "base64",
    );
  const quality: QualityEvidence[] = [];
  for (const item of plan.quality) {
    check(
      !!item &&
        typeof item.report === "string" &&
        Array.isArray(item.artifacts) &&
        item.artifacts.every(artifactRef),
      "Invalid release quality entry",
    );
    const reportJson = await readFile(
      await contained(root, item.report),
      "utf8",
    );
    let report: QualityEvidence["report"];
    try {
      report = JSON.parse(reportJson) as QualityEvidence["report"];
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new CliReleaseError(
          "INVALID",
          "Invalid release quality report JSON",
        );
      throw error;
    }
    check(
      record(report) &&
        record(report.target) &&
        record(report.target.files) &&
        Object.values(report.target.files).every(
          (file) => typeof file === "string",
        ) &&
        Array.isArray(report.findings) &&
        report.findings.every(
          (finding) =>
            record(finding) &&
            typeof finding.criterion === "string" &&
            typeof finding.state === "string" &&
            typeof finding.severity === "string" &&
            typeof finding.reason === "string",
        ) &&
        typeof report.inspectedAt === "string",
      "Invalid release quality report",
    );
    quality.push({ report, artifacts: item.artifacts });
  }
  if (localPolicy) checkLocalPolicy(localPolicy, planDigest, quality);
  const dependencyReview =
    !host && plan.dependencies.length
      ? await reviewDependencies(
          root,
          planDigest,
          { ref: plan.ref, mode: plan.mode },
          plan.dependencies,
        )
      : undefined;
  const dependencyAuthority = dependencyReview
    ? await authorizeDependencies(
        dependencyReview,
        dependencyConfirmation,
        path.relative(root, destination),
        localPolicy!.hostId,
        (node, supplied) => verifiedLocalPublication(root, node, supplied),
      )
    : undefined;
  const authority =
    host ?? localHost(localPolicy!, undefined, dependencyAuthority);
  const frozen: FrozenInput = {
    ref: plan.ref,
    mode: plan.mode,
    scope: plan.scope,
    schemaVersion: plan.schemaVersion,
    approval: plan.approval,
    inventory: plan.inventory,
    files,
    dependencies: plan.dependencies,
    redistribution: authority.redistribution ?? [],
    quality,
  };
  const candidate = await compile(
    frozen,
    store,
    authority,
    schemas,
    scopes,
    destination,
    dependencyAuthority?.source,
  );
  if (
    !(await fileExists(fileFor(root, id, "prepared"))) &&
    (await new FilePackageSource(destination).read(candidate.ref))
  )
    throw new CliReleaseError("CONFLICT", "Package version already exists");
  const prepared: Prepared = {
    format: 1,
    id,
    destination: path.relative(root, destination),
    planDigest,
    preparedAt: new Date().toISOString(),
    frozen,
    request: requestOf(candidate),
    ...(localPolicy ? { localPolicy } : {}),
    ...(dependencyReview
      ? {
          dependencyContext: dependencyReview.context,
          dependencyConfirmation,
        }
      : {}),
  };
  const folder = releaseFolder(root);
  await mkdir(folder, { recursive: true });
  await contained(root, path.relative(root, folder), true);
  const file = fileFor(root, id, "prepared");
  if (!(await atomicCreateJson(file, prepared))) {
    const prior = await readPrepared(root, id);
    check(
      prior.planDigest === planDigest &&
        prior.destination === prepared.destination &&
        same(prior.frozen, frozen) &&
        same(prior.request, prepared.request) &&
        same(prior.localPolicy, prepared.localPolicy) &&
        same(prior.dependencyContext, prepared.dependencyContext) &&
        same(prior.dependencyConfirmation, prepared.dependencyConfirmation),
      "Release preparation ID changed input",
      "CONFLICT",
    );
    return prior;
  }
  return prepared;
}
function checkConfirmation(
  prepared: Prepared,
  confirmation: ReleaseConfirmation,
): void {
  const request = prepared.request;
  check(
    confirmation &&
      Object.keys(confirmation).every((key) =>
        [
          "version",
          "action",
          "hostId",
          "humanActorId",
          "confirmedAt",
          "requestId",
          "requestDigest",
          "packageId",
          "packageVersion",
          "mode",
          "digest",
          "destination",
        ].includes(key),
      ),
    "Invalid release confirmation",
  );
  check(
    confirmation.version === 1 &&
      confirmation.action === "release" &&
      typeof confirmation.hostId === "string" &&
      confirmation.hostId.trim() !== "" &&
      typeof confirmation.humanActorId === "string" &&
      confirmation.humanActorId.trim() !== "" &&
      Number.isFinite(Date.parse(confirmation.confirmedAt)) &&
      Date.parse(confirmation.confirmedAt) >= Date.parse(prepared.preparedAt) &&
      Date.parse(confirmation.confirmedAt) <= Date.now(),
    "Release confirmation must follow candidate preparation",
  );
  check(
    confirmation.requestId === request.manifest.approval.decisionId &&
      confirmation.humanActorId === request.manifest.approval.actorId &&
      confirmation.packageId === request.ref.packageId &&
      confirmation.packageVersion === request.ref.version &&
      confirmation.mode === request.mode &&
      confirmation.digest === request.digest &&
      confirmation.destination === prepared.destination &&
      confirmation.requestDigest === digest(releaseReview(prepared)),
    "Confirmation does not bind exact release request and destination",
  );
}
export function releaseReview(prepared: Prepared): {
  request: ReleaseApprovalRequest;
  destination: string;
  dependencyContext?: DependencyContext;
  dependencyConfirmation?: DependencyConfirmation;
} {
  return {
    request: prepared.request,
    destination: prepared.destination,
    ...(prepared.dependencyContext
      ? {
          dependencyContext: prepared.dependencyContext,
          dependencyConfirmation: prepared.dependencyConfirmation,
        }
      : {}),
  };
}
export async function publishRelease(
  root: string,
  id: string,
  confirmation: ReleaseConfirmation,
  store: ArtifactStore,
  host: ReleaseHost | undefined,
  schemas: SchemaRegistry,
  scopes: readonly ScopeNode[],
): Promise<{
  ref: PackageRef;
  digest: string;
  directory: string;
  recovered: boolean;
}> {
  const prepared = await readPrepared(root, id);
  check(
    host || prepared.localPolicy,
    "Release policy and package authority are unavailable",
    "UNSUPPORTED",
  );
  check(
    !(host && prepared.localPolicy),
    "Local and injected release policies cannot be mixed",
  );
  checkConfirmation(prepared, confirmation);
  if (prepared.localPolicy) {
    checkLocalPolicy(
      prepared.localPolicy,
      prepared.planDigest,
      prepared.frozen.quality,
    );
    check(
      confirmation.hostId === prepared.localPolicy.hostId,
      "Release confirmation changed controlling host",
    );
  }
  const destination = await contained(root, prepared.destination, true);
  const dependencyReview = prepared.dependencyContext
    ? await reviewDependencies(
        root,
        prepared.planDigest,
        { ref: prepared.frozen.ref, mode: prepared.frozen.mode },
        prepared.frozen.dependencies,
      )
    : undefined;
  check(
    !!dependencyReview === (prepared.frozen.dependencies.length > 0 && !host) &&
      (!dependencyReview ||
        same(dependencyReview.context, prepared.dependencyContext)),
    "Prepared dependency context changed",
    "CONFLICT",
  );
  const dependencyAuthority = dependencyReview
    ? await authorizeDependencies(
        dependencyReview,
        prepared.dependencyConfirmation,
        prepared.destination,
        prepared.localPolicy!.hostId,
        (node, supplied) => verifiedLocalPublication(root, node, supplied),
      )
    : undefined;
  const authority =
    host ?? localHost(prepared.localPolicy!, prepared, dependencyAuthority);
  const candidate = await compile(
    prepared.frozen,
    store,
    authority,
    schemas,
    scopes,
    destination,
    dependencyAuthority?.source,
  );
  check(
    same(requestOf(candidate), prepared.request),
    "Prepared candidate changed",
    "CONFLICT",
  );
  const newIntent = {
    format: 2,
    preparedDigest: digest(prepared),
    confirmationDigest: digest(confirmation),
    confirmation,
  };
  const intentFile = fileFor(root, id, "intent");
  let intent: Record<string, unknown> = newIntent;
  if (!(await atomicCreateJson(intentFile, newIntent))) {
    const prior = JSON.parse(
      await readFile(
        await contained(root, path.relative(root, intentFile)),
        "utf8",
      ),
    ) as unknown;
    check(
      same(prior, newIntent) ||
        (record(prior) &&
          prior.format === undefined &&
          prior.preparedDigest === newIntent.preparedDigest &&
          prior.confirmationDigest === newIntent.confirmationDigest),
      "Release intent changed",
      "CONFLICT",
    );
    intent = prior as Record<string, unknown>;
  }
  const source = combinedSource(
    destination,
    candidate.ref,
    dependencyAuthority?.source,
  );
  const existing = await source.read(candidate.ref);
  if (existing) {
    check(
      packageDigest(existing) === candidate.digest,
      "Published version has different bytes",
      "CONFLICT",
    );
    await registry(source, authority, schemas, scopes).reconstruct(
      candidate.ref,
      candidate.digest,
    );
    await completed(root, id, {
      ...intent,
      ...(intent.format === 2 ? { ref: candidate.ref } : {}),
      digest: candidate.digest,
    });
    return {
      ref: candidate.ref,
      digest: candidate.digest,
      directory: path.join(
        destination,
        ...candidate.ref.packageId.split("/"),
        candidate.ref.version,
      ),
      recovered: true,
    };
  }
  const published = await new FilePackagePublisher(destination).publish(
    candidate,
    {
      verifyRelease: async (request) => same(request, prepared.request),
    },
  );
  authority.afterPublished?.();
  await registry(source, authority, schemas, scopes).reconstruct(
    candidate.ref,
    candidate.digest,
  );
  await completed(root, id, {
    ...intent,
    ...(intent.format === 2 ? { ref: candidate.ref } : {}),
    digest: candidate.digest,
  });
  return { ...published, recovered: false };
}
export function releaseRequestDigest(
  request: ReleaseApprovalRequest,
  destination: string,
): string {
  return digest({ request, destination });
}
