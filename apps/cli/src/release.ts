import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  compilePackage,
  FilePackagePublisher,
  FilePackageSource,
  packageDigest,
  PackageRegistry,
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
function localHost(
  policy: LocalReleasePolicyConfirmation,
  prepared?: Prepared,
): ReleaseHost {
  return {
    packageAuthority: {
      verifyRelease: async (manifest) =>
        !!prepared && same(manifest, prepared.request.manifest),
      verifyPromotion: async () => false,
    },
    licenseAllowed: async () => false,
    policy: {
      assess: async (finding, report) => {
        const matches = policy.decisions.filter(
          (decision) =>
            decision.reportDigest === digest(report) &&
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
  dependencies: CompileInput["dependencies"],
): void {
  check(
    dependencies.length === 0,
    "Standalone local policy cannot authorize external dependencies",
    "UNSUPPORTED",
  );
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
  const expected = quality.flatMap(({ report }) =>
    report.findings.map((finding) => ({
      reportDigest: digest(report),
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
      Object.keys(decision).every((key) =>
        [
          "reportDigest",
          "criterion",
          "state",
          "severity",
          "blockRelease",
          "reason",
        ].includes(key),
      ) &&
        typeof decision.blockRelease === "boolean" &&
        typeof decision.reason === "string" &&
        decision.reason.trim() !== "" &&
        expected.filter(
          (item) =>
            item.reportDigest === decision.reportDigest &&
            item.criterion === decision.criterion &&
            item.state === decision.state &&
            item.severity === decision.severity,
        ).length === 1,
      "Local policy has an unmatched or invalid finding decision",
    );
  }
  const keys = policy.decisions.map(
    (item) =>
      `${item.reportDigest}:${item.criterion}:${item.state}:${item.severity}`,
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
  const source = new FilePackageSource(destination);
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
): Promise<Prepared> {
  check(
    host || localPolicy,
    "Release policy and package authority are unavailable",
    "UNSUPPORTED",
  );
  check(
    !(host && localPolicy),
    "Local and injected release policies cannot be mixed",
  );
  const destination = await contained(root, destinationName, true);
  check(
    plan && typeof plan === "object" && !Object.hasOwn(plan, "redistribution"),
    "Invalid release plan",
  );
  check(
    plan.files && typeof plan.files === "object" && !Array.isArray(plan.files),
    "Invalid release files",
  );
  check(Array.isArray(plan.quality), "Invalid release evidence");
  const files: Record<string, string> = {};
  for (const [name, file] of Object.entries(plan.files))
    files[name] = (await readFile(await contained(root, file))).toString(
      "base64",
    );
  const quality: QualityEvidence[] = [];
  for (const item of plan.quality) {
    const report = JSON.parse(
      await readFile(await contained(root, item.report), "utf8"),
    ) as QualityEvidence["report"];
    quality.push({ report, artifacts: item.artifacts });
  }
  if (localPolicy)
    checkLocalPolicy(localPolicy, planDigest, quality, plan.dependencies);
  const authority = host ?? localHost(localPolicy!);
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
        same(prior.localPolicy, prepared.localPolicy),
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
      confirmation.requestDigest ===
        digest({ request, destination: prepared.destination }),
    "Confirmation does not bind exact release request and destination",
  );
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
      prepared.frozen.dependencies,
    );
    check(
      confirmation.hostId === prepared.localPolicy.hostId,
      "Release confirmation changed controlling host",
    );
  }
  const authority = host ?? localHost(prepared.localPolicy!, prepared);
  const destination = await contained(root, prepared.destination, true);
  const candidate = await compile(
    prepared.frozen,
    store,
    authority,
    schemas,
    scopes,
    destination,
  );
  check(
    same(requestOf(candidate), prepared.request),
    "Prepared candidate changed",
    "CONFLICT",
  );
  const intent = {
    preparedDigest: digest(prepared),
    confirmationDigest: digest(confirmation),
  };
  const intentFile = fileFor(root, id, "intent");
  if (!(await atomicCreateJson(intentFile, intent))) {
    const prior = JSON.parse(
      await readFile(
        await contained(root, path.relative(root, intentFile)),
        "utf8",
      ),
    ) as unknown;
    check(same(prior, intent), "Release intent changed", "CONFLICT");
  }
  const source = new FilePackageSource(destination);
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
    await completed(root, id, { ...intent, digest: candidate.digest });
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
  await completed(root, id, { ...intent, digest: candidate.digest });
  return { ...published, recovered: false };
}
export function releaseRequestDigest(
  request: ReleaseApprovalRequest,
  destination: string,
): string {
  return digest({ request, destination });
}
