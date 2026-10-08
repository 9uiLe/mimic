import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  lstat,
  readdir,
} from "node:fs/promises";
import { inspectRun, pointerExists } from "./inspect.js";
import { atomicCreateJson } from "./atomic-file.js";
import {
  LOCAL_MARKER,
  SIGNED_MARKER,
  LocalConfirmationAuthority,
  LocalConfirmationError,
  type LocalConfirmation,
} from "./local-confirmation-authority.js";
import { runSkillCli } from "./skill/index.js";
import { CliPreviewError, createPreview, type PreviewPlan } from "./preview.js";
import {
  CliReleaseError,
  prepareRelease,
  publishRelease,
  releaseReview,
  type ReleaseConfirmation,
  type ReleaseHost,
  type ReleasePlan,
  type LocalReleasePolicyConfirmation,
} from "./release.js";
import {
  CliDependencyError,
  reviewDependencies,
  type DependencyConfirmation,
} from "./release-dependencies.js";
import { PlanError, preflightPlan, scopeChain } from "./plan.js";
import {
  ReceiptAuthority,
  ReceiptError,
  type OperatorTrust,
  type SignedAcceptance,
  type SignedReceipt,
} from "./receipt-authority.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  canonicalJson,
  createOrchestratorRuntime,
  loadSkillPackage,
  runSkillPackage,
  FileWorkspaceStorage,
  getStatus,
  loadSchemaDirectory,
  RegistryError,
  type ArtifactSnapshot,
  type AuthorityVerifier,
  type CommitRequest,
  type DecisionRecord,
  type RegistryAuthority,
  type RoutedTask,
  type ScopeNode,
  type SkillInvocation,
  type SkillResult,
  type SkillWork,
  type RegistryState,
  type UpstreamRevisionRequest,
  PackageCompilerError,
  PackageRegistryError,
  PrototypeBuilderError,
  PrototypeModeError,
} from "@mimic/core";

export interface CliHost {
  /** Supplied by a trusted embedding host; never constructed from a CLI input file. */
  readonly authority?: RegistryAuthority;
  /** Trusted launch configuration; the standalone binary loads it only from an OS-protected fixed path. */
  readonly operatorTrust?: OperatorTrust;
  /** Standalone binary calls this only for explicit signed actions or signed history. */
  readonly loadOperatorTrust?: () => Promise<OperatorTrust | undefined>;
  readonly seedAuthority?: AuthorityVerifier;
  readonly executeSkill?: (invocation: SkillInvocation) => Promise<SkillResult>;
  /** Trusted host fault hook; useful for testing recovery after Core accepts a submission. */
  readonly afterSkillAccepted?: () => void;
  /** Release policies and package authority must originate from the controlling host. */
  readonly release?: ReleaseHost;
}
export interface CliIO {
  out(value: string): void;
  err(value: string): void;
}
export const EXIT = {
  OK: 0,
  USAGE: 2,
  INVALID: 3,
  UNSUPPORTED: 4,
  CONFLICT: 5,
  IO: 6,
} as const;
const commands = new Set([
  "init",
  "status",
  "inspect",
  "run",
  "next",
  "submit",
  "revision-requests",
  "decisions",
  "decide",
  "preview",
  "validate",
  "release",
]);
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
type Config = { version: 1; defaultScope: string; scopes: ScopeNode[] };
class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new CliError(EXIT.USAGE, `Missing ${name}`);
  return value;
}
function safeId(value: string, name: string): string {
  if (!idPattern.test(value))
    throw new CliError(EXIT.INVALID, `Invalid ${name}`);
  return value;
}
function parse(argv: readonly string[]) {
  const [command, ...rest] = argv;
  if (!command || !commands.has(command))
    throw new CliError(
      EXIT.USAGE,
      "Usage: mimic <init|status|inspect|run|next|submit|revision-requests|decisions|decide|preview|validate|release> [options]",
    );
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  let json = false;
  let browser = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--browser") {
      browser = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (
        !new Set([
          "root",
          "scope",
          "scopes",
          "mode",
          "tasks",
          "id",
          "task",
          "file",
          "commit",
          "package",
          "work",
          "receipt",
          "commit-receipt",
          "confirmation",
          "commit-confirmation",
          "acceptance",
          "destination",
          "policy-confirmation",
          "dependency-confirmation",
        ]).has(arg.slice(2))
      )
        throw new CliError(EXIT.USAGE, `Unknown option ${arg}`);
      if (options[arg.slice(2)] !== undefined)
        throw new CliError(EXIT.USAGE, `Duplicate option ${arg}`);
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new CliError(EXIT.USAGE, `Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else positionals.push(arg);
  }
  return { command, options, positionals, json, browser };
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
async function containedFile(root: string, name: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(root, name));
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new CliError(EXIT.INVALID, "Input file does not exist");
    throw error;
  }
  if (!inside(root, resolved) || !(await lstat(resolved)).isFile())
    throw new CliError(
      EXIT.INVALID,
      "Input must be a regular file inside the workspace",
    );
  return resolved;
}
async function containedDirectory(root: string, name: string): Promise<string> {
  const resolved = await realpath(path.resolve(root, name));
  if (!inside(root, resolved) || !(await lstat(resolved)).isDirectory())
    throw new CliError(
      EXIT.INVALID,
      "Package must be a directory inside the workspace",
    );
  return resolved;
}
async function readJson(root: string, name: string): Promise<unknown> {
  const file = await containedFile(root, name);
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new CliError(
      EXIT.INVALID,
      `Invalid JSON in ${path.relative(root, file)}`,
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError(EXIT.INVALID, "Expected a JSON object");
  return value as Record<string, unknown>;
}
function configFrom(value: unknown): Config {
  const data = object(value);
  if (
    data.version !== 1 ||
    typeof data.defaultScope !== "string" ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every(
      (scope) =>
        scope &&
        typeof scope === "object" &&
        ["organization", "product", "domain", "local"].includes(scope.level) &&
        typeof scope.ownerId === "string" &&
        scope.ownerId.length > 0 &&
        (scope.parentId === undefined || typeof scope.parentId === "string"),
    ) ||
    !data.scopes.some(
      (scope: ScopeNode) => scope.ownerId === data.defaultScope,
    ) ||
    new Set(data.scopes.map((scope: ScopeNode) => scope.ownerId)).size !==
      data.scopes.length
  )
    throw new CliError(EXIT.INVALID, "Invalid Mimic workspace configuration");
  for (const scope of data.scopes as ScopeNode[])
    scopeChain(data.scopes as ScopeNode[], scope.ownerId);
  return data as Config;
}
async function metadata(root: string): Promise<string> {
  const folder = path.join(root, ".mimic");
  const real = await realpath(folder);
  if (!inside(root, real))
    throw new CliError(EXIT.INVALID, "Workspace metadata escapes root");
  const state = path.join(folder, "workspace.json");
  try {
    if ((await lstat(state)).isSymbolicLink())
      throw new CliError(EXIT.INVALID, "Workspace state cannot be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return folder;
}
async function outputFile(root: string, value: unknown): Promise<string> {
  const folder = path.join(await metadata(root), "outputs");
  await mkdir(folder, { recursive: true });
  if (!inside(root, await realpath(folder)))
    throw new CliError(EXIT.INVALID, "Output directory escapes root");
  const file = path.join(folder, `${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return path.relative(root, file);
}
function jsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function summarizeNext(
  plan: Awaited<
    ReturnType<
      ReturnType<typeof createOrchestratorRuntime>["orchestrator"]["next"]
    >
  >,
  file: string,
) {
  return {
    runId: plan.runId,
    state: plan.state,
    actions: plan.actions.map((action) => ({
      taskId: action.taskId,
      action: action.action,
      ...(action.ref
        ? { ref: `${action.ref.artifactId}@${action.ref.revision}` }
        : {}),
    })),
    packetIds: plan.commitPoints.map((point) => point.packetId),
    blockers: Object.keys(plan.blockers),
    path: file,
  };
}
type RevisionBinding = {
  version: 2;
  runId: string;
  taskId: string;
  packageDigest: string;
  workDigest: string;
  baselineSequence: number;
  result: SkillResult;
  revisionRequests: readonly UpstreamRevisionRequest[];
  revisionDigest: string;
};
function revisionDigest(
  binding: Omit<RevisionBinding, "revisionDigest">,
): string {
  return jsonDigest(binding);
}
async function optionalRecord(root: string, name: string) {
  try {
    return object(await readJson(root, name));
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === EXIT.INVALID &&
      error.message === "Input file does not exist"
    )
      return undefined;
    throw error;
  }
}
function acceptedSubmission(
  state: RegistryState,
  binding: Pick<RevisionBinding, "runId" | "taskId" | "baselineSequence">,
  result: SkillResult,
): "accepted" | "blocked" | undefined {
  const terminal = state.events.find((event) => {
    if (
      event.sequence <= binding.baselineSequence ||
      event.runId !== binding.runId ||
      event.action !== "set-work" ||
      event.actor.kind !== "agent" ||
      event.actor.id !== "orchestrator" ||
      event.runAfter.safeActions.includes(binding.taskId) ||
      !result.outputRefs.every(
        (ref) =>
          event.runAfter.artifacts.some(
            (recorded) => canonicalJson(recorded) === canonicalJson(ref),
          ) ||
          (event.runAfter.base.some(
            (recorded) => canonicalJson(recorded) === canonicalJson(ref),
          ) &&
            result.inputRefs.some(
              (input) => canonicalJson(input) === canonicalJson(ref),
            )),
      )
    )
      return false;
    if (result.proposal) {
      const proposed = result.proposal.items.every((item) => {
        const stored = event.runAfter.proposals[item.id];
        if (!stored || stored.packetId !== result.proposal?.packetId)
          return false;
        const declared = Object.fromEntries(
          Object.entries(stored).filter(
            ([key]) =>
              ![
                "packetId",
                "status",
                "readiness",
                "readinessReason",
                "deferred",
              ].includes(key),
          ),
        );
        return canonicalJson(declared) === canonicalJson(item);
      });
      if (!proposed) return false;
    }
    return result.blocked
      ? event.reason === "Skill reported a genuine affected-work blocker" &&
          result.blocked.reason === event.runAfter.blockers[binding.taskId]
      : event.reason ===
          `Skill task ${JSON.stringify(binding.taskId)} completed with verified exact outputs`;
  });
  return terminal ? (result.blocked ? "blocked" : "accepted") : undefined;
}
async function revisionRecords(
  root: string,
  runId: string,
  runtime: ReturnType<typeof createOrchestratorRuntime>,
) {
  const folder = path.join(await metadata(root), "submissions");
  let files: string[];
  try {
    if (!inside(root, await realpath(folder)))
      throw new CliError(EXIT.INVALID, "Submission directory escapes root");
    files = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const state = await runtime.registry.snapshot();
  const records = [];
  for (const name of files.sort()) {
    if (
      !name.startsWith(`${runId}-`) ||
      !/^[a-f0-9]{64}\.json$/.test(name.slice(runId.length + 1))
    )
      continue;
    const marker = object(
      await readJson(root, path.join(".mimic/submissions", name)),
    );
    if (
      marker.runId !== runId ||
      typeof marker.taskId !== "string" ||
      name !== `${runId}-${jsonDigest(marker.taskId)}.json`
    )
      throw new CliError(
        EXIT.CONFLICT,
        "Submission reservation filename changed",
      );
    let value = marker;
    let recordPath = path.join(".mimic/submissions", name);
    if (marker.version === 1) {
      const recovered = await optionalRecord(
        root,
        path.join(".mimic/submissions", `${name.slice(0, -5)}.revision.json`),
      );
      if (!recovered) {
        if (
          Object.hasOwn(marker, "revisionRequests") ||
          Object.hasOwn(marker, "result")
        )
          throw new CliError(
            EXIT.CONFLICT,
            "Unsealed revision request reservation",
          );
        continue;
      }
      if (
        [
          "runId",
          "taskId",
          "packageDigest",
          "workDigest",
          "baselineSequence",
        ].some((key) => marker[key] !== recovered[key])
      )
        throw new CliError(EXIT.CONFLICT, "Recovered revision binding changed");
      value = recovered;
      recordPath = path.join(
        ".mimic/submissions",
        `${name.slice(0, -5)}.revision.json`,
      );
    }
    const binding = value as RevisionBinding;
    if (
      binding.version !== 2 ||
      binding.runId !== runId ||
      binding.taskId !== marker.taskId ||
      !/^[a-f0-9]{64}$/.test(binding.workDigest) ||
      !/^[a-f0-9]{64}$/.test(binding.packageDigest) ||
      !Number.isSafeInteger(binding.baselineSequence) ||
      !binding.result ||
      binding.result.runId !== runId ||
      binding.result.taskId !== binding.taskId ||
      typeof binding.result.skillId !== "string" ||
      !Array.isArray(binding.result.inputRefs) ||
      !Array.isArray(binding.result.outputRefs) ||
      !Array.isArray(binding.revisionRequests)
    )
      throw new CliError(EXIT.CONFLICT, "Invalid revision request binding");
    const { revisionDigest: savedDigest, ...sealed } = binding;
    if (savedDigest !== revisionDigest(sealed))
      throw new CliError(
        EXIT.CONFLICT,
        "Revision request binding digest changed",
      );
    if (
      !binding.revisionRequests.every(
        (request) =>
          request &&
          request.runId === runId &&
          binding.result.inputRefs.some(
            (ref) => canonicalJson(ref) === canonicalJson(request.source),
          ) &&
          binding.result.outputRefs.some(
            (ref) => canonicalJson(ref) === canonicalJson(request.request),
          ) &&
          Array.isArray(request.affectedLocks) &&
          request.affectedLocks.some(
            (ref: unknown) =>
              canonicalJson(ref) === canonicalJson(request.source),
          ),
      )
    )
      throw new CliError(
        EXIT.CONFLICT,
        "Invalid revision request exact binding",
      );
    if (!binding.revisionRequests.length) continue;
    if (!acceptedSubmission(state, binding, binding.result)) continue;
    const requests = [];
    for (let index = 0; index < binding.revisionRequests.length; index++) {
      const request = binding.revisionRequests[index]!;
      const routePath = path.join(
        ".mimic/submissions",
        `${name.slice(0, -5)}.route-${index}.json`,
      );
      const route = await optionalRecord(root, routePath);
      if (
        route &&
        (route.version !== 1 ||
          route.runId !== runId ||
          route.taskId !== binding.taskId ||
          route.workDigest !== binding.workDigest ||
          route.requestDigest !== jsonDigest(request))
      )
        throw new CliError(EXIT.CONFLICT, "Revision route receipt changed");
      let status:
        | "pending-source-approval"
        | "pending-routing"
        | "routed"
        | "source-unavailable"
        | "unroutable-source";
      try {
        const source = await runtime.artifacts.read(
          request.source.artifactId,
          request.source.revision,
        );
        status =
          source.digest !== request.source.lockDigest
            ? "source-unavailable"
            : source.artifact.lifecycle.status === "approved"
              ? route
                ? "routed"
                : "pending-routing"
              : source.artifact.lifecycle.status === "provisional"
                ? "pending-source-approval"
                : "unroutable-source";
      } catch {
        status = "source-unavailable";
      }
      requests.push({ request, state: status });
    }
    records.push({
      runId,
      taskId: binding.taskId,
      workDigest: binding.workDigest,
      packageDigest: binding.packageDigest,
      skillId: binding.result.skillId,
      inputRefs: binding.result.inputRefs,
      outputRefs: binding.result.outputRefs,
      path: recordPath,
      requests,
    });
  }
  return records;
}
function revisionOverview(
  records: Awaited<ReturnType<typeof revisionRecords>>,
) {
  const requests = records.flatMap((record) => record.requests);
  if (!requests.length) return undefined;
  const states = [...new Set(requests.map((item) => item.state))];
  return {
    count: requests.length,
    state: states.length === 1 ? states[0] : "mixed",
    path: records.length === 1 ? records[0]!.path : undefined,
    paths: records.map((record) => record.path),
  };
}
async function routeRevisionRequests(
  root: string,
  markerFile: string,
  binding: RevisionBinding,
  runtime: ReturnType<typeof createOrchestratorRuntime>,
) {
  for (let index = 0; index < binding.revisionRequests.length; index++) {
    const request = binding.revisionRequests[index]!;
    const source = await runtime.artifacts.read(
      request.source.artifactId,
      request.source.revision,
    );
    if (source.digest !== request.source.lockDigest)
      throw new CliError(EXIT.INVALID, "Revision source exact lock mismatch");
    if (source.artifact.lifecycle.status === "provisional") continue;
    if (source.artifact.lifecycle.status !== "approved")
      throw new CliError(EXIT.INVALID, "Revision source is not approvable");
    try {
      await runtime.orchestrator.requestUpstream(
        request,
        { kind: "skill", id: binding.result.skillId },
        new Date().toISOString(),
      );
    } catch (error) {
      throw new CliError(
        EXIT.INVALID,
        `Revision routing rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const routeFile = markerFile.replace(/\.json$/, `.route-${index}.json`);
    const receipt = {
      version: 1,
      runId: binding.runId,
      taskId: binding.taskId,
      workDigest: binding.workDigest,
      requestDigest: jsonDigest(request),
    };
    if (!(await atomicCreateJson(routeFile, receipt))) {
      const stored = await readJson(root, path.relative(root, routeFile));
      if (canonicalJson(stored) !== canonicalJson(receipt))
        throw new CliError(EXIT.CONFLICT, "Revision route receipt changed");
    }
  }
}

async function load(root: string, host: CliHost) {
  await metadata(root);
  const config = configFrom(await readJson(root, ".mimic/config.json"));
  const workspace = new FileWorkspaceStorage(
    path.join(root, ".mimic", "workspace.json"),
  );
  const schemasRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../schemas",
  );
  const schemas = await loadSchemaDirectory(
    path.join(schemasRoot, "artifacts"),
  );
  const localAuthority = new LocalConfirmationAuthority(workspace, root);
  let receiptAuthority: ReceiptAuthority | undefined;
  const signedAuthority = async (): Promise<ReceiptAuthority | undefined> => {
    if (receiptAuthority) return receiptAuthority;
    const trust = host.operatorTrust ?? (await host.loadOperatorTrust?.());
    if (!trust) return undefined;
    receiptAuthority = new ReceiptAuthority(workspace, root, trust);
    return receiptAuthority;
  };
  const authority: RegistryAuthority = host.authority ?? {
    async verify(record, proposal) {
      const marks =
        record.externalRefs?.filter(
          (ref) =>
            ref.startsWith(LOCAL_MARKER) || ref.startsWith(SIGNED_MARKER),
        ) ?? [];
      if (marks.length !== 1) return false;
      if (marks[0]!.startsWith(LOCAL_MARKER))
        return localAuthority.verify(record, proposal);
      try {
        return (
          (await (await signedAuthority())?.verify(record, proposal)) ?? false
        );
      } catch {
        return false;
      }
    },
    async allowCommit(record, proposal, state) {
      const marks =
        record.externalRefs?.filter(
          (ref) =>
            ref.startsWith(LOCAL_MARKER) || ref.startsWith(SIGNED_MARKER),
        ) ?? [];
      if (marks.length !== 1) return false;
      if (marks[0]!.startsWith(LOCAL_MARKER))
        return localAuthority.allowCommit(record, proposal, state);
      try {
        return (
          (await (
            await signedAuthority()
          )?.allowCommit(record, proposal, state)) ?? false
        );
      } catch {
        return false;
      }
    },
  };
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    config.scopes,
    authority,
    host.seedAuthority,
  );
  return {
    config,
    schemas,
    schemasRoot,
    runtime,
    localAuthority,
    signedAuthority,
  };
}
async function savedTasks(
  root: string,
  id: string,
  config: Config,
  scope: string,
): Promise<RoutedTask[]> {
  const tasks = preflightPlan(
    await readJson(root, `.mimic/runs/${safeId(id, "run ID")}.json`),
    config.scopes,
    scope,
  );
  await checkEvidenceFiles(root, tasks);
  return tasks;
}
async function checkEvidenceFiles(
  root: string,
  tasks: readonly RoutedTask[],
): Promise<void> {
  for (const task of tasks)
    for (const file of task.evidenceFiles ?? [])
      await containedFile(root, file);
}
function emit(io: CliIO, value: Record<string, unknown>, json: boolean) {
  io.out(
    json
      ? JSON.stringify(value)
      : Object.entries(value)
          .map(
            ([key, item]) =>
              `${key}: ${Array.isArray(item) ? item.map((entry) => (typeof entry === "object" ? JSON.stringify(entry) : String(entry))).join(", ") : typeof item === "object" ? JSON.stringify(item) : String(item)}`,
          )
          .join("\n"),
  );
}

export async function runCli(
  argv: readonly string[],
  io: CliIO = { out: (v) => console.log(v), err: (v) => console.error(v) },
  host: CliHost = {},
): Promise<number> {
  if (argv.length === 0) {
    io.out(JSON.stringify(getStatus()));
    return EXIT.OK;
  }
  if (argv[0] === "skill") return runSkillCli(argv.slice(1), io);
  try {
    const { command, options, positionals, json, browser } = parse(argv);
    const root = await realpath(path.resolve(options.root ?? process.cwd()));
    if (command === "init") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "init takes no positional arguments");
      const scope = options.scope ?? "org_local";
      if (!scope.trim()) throw new CliError(EXIT.INVALID, "Invalid scope");
      const scopes = options.scopes
        ? object(await readJson(root, options.scopes))
        : undefined;
      const config = configFrom(
        scopes ?? {
          version: 1,
          defaultScope: scope,
          scopes: [{ level: "organization", ownerId: scope }],
        },
      );
      const folder = path.join(root, ".mimic");
      await mkdir(folder, { recursive: true });
      await metadata(root);
      const file = path.join(folder, "config.json");
      if (!(await atomicCreateJson(file, config))) {
        const existing = configFrom(await readJson(root, ".mimic/config.json"));
        if (JSON.stringify(existing) !== JSON.stringify(config))
          throw new CliError(
            EXIT.CONFLICT,
            "Workspace already initialized with different configuration",
          );
      }
      const workspace = new FileWorkspaceStorage(
        path.join(folder, "workspace.json"),
      );
      await workspace.read();
      emit(
        io,
        {
          status: "ready",
          root,
          config: ".mimic/config.json",
          state: ".mimic/workspace.json",
          scope: config.defaultScope,
        },
        json,
      );
      return EXIT.OK;
    }
    const {
      config,
      schemas,
      schemasRoot,
      runtime,
      localAuthority,
      signedAuthority,
    } = await load(root, host);
    if (command === "inspect") {
      if (positionals.length > 1)
        throw new CliError(EXIT.USAGE, "Usage: mimic inspect [run-id]");
      const state = await runtime.registry.snapshot();
      const ids = positionals[0]
        ? [safeId(positionals[0], "run ID")]
        : Object.keys(state.runs);
      for (const id of ids)
        if (!state.runs[id])
          throw new CliError(EXIT.INVALID, `Unknown Run ${id}`);
      const runs = [];
      for (const id of ids)
        runs.push(
          await inspectRun(runtime, id, {
            revisionRecords: await revisionRecords(root, id, runtime),
            async resolveEvidence(reference) {
              const [name, pointer] = reference.split("#");
              if (!name || reference.split("#").length > 2) return false;
              try {
                const file = await containedFile(root, name);
                if (pointer === undefined) return true;
                return pointerExists(
                  JSON.parse(await readFile(file, "utf8")),
                  pointer,
                );
              } catch {
                return false;
              }
            },
          }),
        );
      emit(io, { readOnly: true, runs }, json);
      return EXIT.OK;
    }
    if (command === "status") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "status takes no positional arguments");
      const state = await runtime.registry.snapshot();
      const runs = await Promise.all(
        Object.keys(state.runs).map(async (id) => ({
          id,
          state: (await runtime.registry.run(id)).state,
        })),
      );
      emit(
        io,
        {
          status: "ready",
          scope: config.defaultScope,
          runs,
          canonical: Object.values(state.canonical).map(
            ({ ref }) => `${ref.artifactId}@${ref.revision}`,
          ),
          statePath: ".mimic/workspace.json",
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "run") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "run takes no positional arguments");
      const id = safeId(
        options.id ?? `run_${randomUUID().replaceAll("-", "")}`,
        "run ID",
      );
      const rawTasks = await readJson(root, required(options.tasks, "--tasks"));
      const mode = options.mode ?? "hybrid";
      if (
        !(["system-first", "experience-first", "hybrid"] as string[]).includes(
          mode,
        )
      )
        throw new CliError(EXIT.INVALID, "Invalid entry mode");
      const scope = options.scope ?? config.defaultScope;
      const tasks = preflightPlan(rawTasks, config.scopes, scope);
      await checkEvidenceFiles(root, tasks);
      const folder = path.join(await metadata(root), "runs");
      await mkdir(folder, { recursive: true });
      if (!inside(root, await realpath(folder)))
        throw new CliError(EXIT.INVALID, "Run directory escapes root");
      const planFile = path.join(folder, `${id}.json`);
      const existing = !(await atomicCreateJson(planFile, tasks));
      if (
        existing &&
        JSON.stringify(await savedTasks(root, id, config, scope)) !==
          JSON.stringify(tasks)
      )
        throw new CliError(
          EXIT.CONFLICT,
          "Run ID already has a different task plan",
        );
      const state = await runtime.registry.snapshot();
      if (!state.runs[id])
        await runtime.orchestrator.start({
          id,
          scopeOwnerId: scope,
          entryMode: mode as "hybrid",
          tasks,
          actor: { kind: "agent", id: "cli" },
          at: new Date().toISOString(),
        });
      else if (
        state.runs[id].scope !== scope ||
        state.runs[id].entryMode !== mode
      )
        throw new CliError(
          EXIT.CONFLICT,
          "Run ID already has different scope or mode",
        );
      const plan = await runtime.orchestrator.next(id, tasks);
      const file = await outputFile(root, plan);
      emit(io, summarizeNext(plan, file), json);
      return EXIT.OK;
    }
    if (command === "next") {
      if (positionals.length !== 1)
        throw new CliError(EXIT.USAGE, "Usage: mimic next <run-id>");
      const id = safeId(positionals[0]!, "run ID");
      const { run } = await runtime.registry.run(id);
      const plan = await runtime.orchestrator.next(
        id,
        await savedTasks(root, id, config, run.scope),
      );
      const revisionRequests = revisionOverview(
        await revisionRecords(root, id, runtime),
      );
      emit(
        io,
        {
          ...summarizeNext(plan, await outputFile(root, plan)),
          ...(revisionRequests ? { revisionRequests } : {}),
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "revision-requests") {
      if (positionals.length !== 1)
        throw new CliError(
          EXIT.USAGE,
          "Usage: mimic revision-requests <run-id>",
        );
      const id = safeId(positionals[0]!, "run ID");
      await runtime.registry.run(id);
      const records = await revisionRecords(root, id, runtime);
      emit(
        io,
        {
          runId: id,
          count: records.reduce(
            (sum, record) => sum + record.requests.length,
            0,
          ),
          records,
          requests: records.flatMap((record) =>
            record.requests.map((item) => item.request),
          ),
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "submit") {
      if (positionals.length !== 1)
        throw new CliError(
          EXIT.USAGE,
          "Usage: mimic submit <run-id> --task <task-id>",
        );
      if (!host.executeSkill && (!options.package || !options.work))
        throw new CliError(
          EXIT.UNSUPPORTED,
          "Skill submission requires --package and --work file inputs",
        );
      const id = safeId(positionals[0]!, "run ID");
      const taskId = required(options.task, "--task");
      const { run } = await runtime.registry.run(id);
      const tasks = await savedTasks(root, id, config, run.scope);
      let submissionState: "accepted" | "blocked" | undefined;
      if (options.package && options.work) {
        const packageDirectory = await containedDirectory(
          root,
          options.package,
        );
        const skill = await loadSkillPackage(packageDirectory, schemasRoot);
        const submission = object(await readJson(root, options.work));
        if (
          Object.keys(submission).some(
            (key) => !["artifacts", "work"].includes(key),
          ) ||
          !Array.isArray(submission.artifacts) ||
          !submission.artifacts.every(
            (item) => item && typeof item === "object",
          ) ||
          !submission.work ||
          typeof submission.work !== "object"
        )
          throw new CliError(
            EXIT.INVALID,
            "Invalid file-backed Skill submission",
          );
        const work = submission.work as SkillWork;
        if (
          !work.result ||
          work.result.runId !== id ||
          work.result.taskId !== taskId ||
          work.result.skillId !== skill.manifest.skillId ||
          !Array.isArray(work.result.inputRefs) ||
          !Array.isArray(work.result.outputRefs) ||
          !work.result.outputRefs.every(
            (ref) =>
              ref &&
              typeof ref.artifactId === "string" &&
              Number.isSafeInteger(ref.revision) &&
              typeof ref.lockDigest === "string",
          )
        )
          throw new CliError(
            EXIT.INVALID,
            "Invalid Skill result identity or references",
          );
        if (work.revisionRequests !== undefined) {
          const exact = (a: unknown, b: unknown) =>
            canonicalJson(a) === canonicalJson(b);
          if (
            !Array.isArray(work.revisionRequests) ||
            !work.revisionRequests.every(
              (request) =>
                request &&
                request.runId === id &&
                typeof request.reason === "string" &&
                request.reason.trim() &&
                Array.isArray(request.evidenceRefs) &&
                request.evidenceRefs.length > 0 &&
                request.evidenceRefs.every(
                  (ref: unknown) => typeof ref === "string" && ref.length > 0,
                ) &&
                Array.isArray(request.affectedLocks) &&
                request.affectedLocks.some((ref: unknown) =>
                  exact(ref, request.source),
                ) &&
                work.result.inputRefs.some((ref) =>
                  exact(ref, request.source),
                ) &&
                work.result.outputRefs.some((ref) =>
                  exact(ref, request.request),
                ),
            )
          )
            throw new CliError(
              EXIT.INVALID,
              "Invalid revision request exact bindings",
            );
        }
        for (const artifact of submission.artifacts as ArtifactSnapshot[]) {
          const origin = artifact?.origin as
            Record<string, unknown> | undefined;
          if (
            !schemas.validate(artifact).valid ||
            !origin ||
            origin.actorKind !== "skill" ||
            origin.actorId !== skill.manifest.skillId ||
            origin.runId !== id
          )
            throw new CliError(
              EXIT.INVALID,
              "Candidate origin does not match Skill and Run",
            );
          const exact = artifactDigest(artifact);
          if (
            !work.result.outputRefs.some(
              (ref) =>
                ref.artifactId === artifact.meta.id &&
                ref.revision === artifact.meta.revision &&
                ref.lockDigest === exact,
            )
          )
            throw new CliError(
              EXIT.INVALID,
              "Candidate does not match an exact output reference",
            );
        }
        const markerFolder = path.join(await metadata(root), "submissions");
        await mkdir(markerFolder, { recursive: true });
        if (!inside(root, await realpath(markerFolder)))
          throw new CliError(EXIT.INVALID, "Submission directory escapes root");
        const markerFile = path.join(
          markerFolder,
          `${id}-${jsonDigest(taskId)}.json`,
        );
        const before = await runtime.registry.snapshot();
        const unsealed: Omit<RevisionBinding, "revisionDigest"> = {
          version: 2,
          runId: id,
          taskId,
          packageDigest: jsonDigest(skill),
          workDigest: jsonDigest(submission),
          baselineSequence: before.events.at(-1)?.sequence ?? 0,
          result: work.result,
          revisionRequests: work.revisionRequests ?? [],
        };
        const binding: RevisionBinding = {
          ...unsealed,
          revisionDigest: revisionDigest(unsealed),
        };
        const created = await atomicCreateJson(markerFile, binding);
        const reservation = created
          ? binding
          : object(await readJson(root, path.relative(root, markerFile)));
        if (
          ![1, 2].includes(reservation.version as number) ||
          reservation.runId !== binding.runId ||
          reservation.taskId !== binding.taskId ||
          reservation.packageDigest !== binding.packageDigest ||
          reservation.workDigest !== binding.workDigest ||
          !Number.isSafeInteger(reservation.baselineSequence)
        )
          throw new CliError(EXIT.CONFLICT, "Submission retry changed input");
        if (reservation.version === 2) {
          const stored = reservation as RevisionBinding;
          const { revisionDigest: savedDigest, ...sealed } = stored;
          if (
            savedDigest !== revisionDigest(sealed) ||
            canonicalJson(stored.result) !== canonicalJson(work.result) ||
            canonicalJson(stored.revisionRequests) !==
              canonicalJson(work.revisionRequests ?? [])
          )
            throw new CliError(
              EXIT.CONFLICT,
              "Submission retry changed revision binding",
            );
        }
        const acceptedState = async () =>
          acceptedSubmission(
            await runtime.registry.snapshot(),
            {
              runId: id,
              taskId,
              baselineSequence: reservation.baselineSequence as number,
            },
            work.result,
          );
        submissionState = await acceptedState();
        if (!submissionState) {
          const current = await runtime.registry.snapshot();
          const effects = () =>
            current.events.some(
              (event) =>
                event.sequence > (reservation.baselineSequence as number) &&
                event.runId === id &&
                (event.action === "produce-provisional" ||
                  event.action === "submit-proposal"),
            );
          const nextAction = (
            await runtime.orchestrator.next(id, tasks)
          ).actions.find((action) => action.taskId === taskId);
          if (
            !nextAction?.invocation ||
            !["GENERATE", "UPDATE"].includes(nextAction.action)
          )
            throw new CliError(
              EXIT.CONFLICT,
              `Submission ${effects() ? "partial" : "pending"}; no routable invocation for exact retry`,
            );
          try {
            const acceptedWork = await runSkillPackage({
              orchestrator: runtime.orchestrator,
              package: skill,
              runId: id,
              tasks,
              taskId,
              at: new Date().toISOString(),
              executor: async (context) => {
                if (context.invocation.skillId !== skill.manifest.skillId)
                  throw new CliError(
                    EXIT.INVALID,
                    "Invocation Skill differs from package",
                  );
                for (const artifact of submission.artifacts as ArtifactSnapshot[])
                  await runtime.artifacts.create(artifact);
                return work;
              },
            });
            if (
              canonicalJson(acceptedWork.revisionRequests ?? []) !==
              canonicalJson(work.revisionRequests ?? [])
            )
              throw new CliError(
                EXIT.CONFLICT,
                "Skill revision request side-channel changed",
              );
          } catch (error) {
            const latest = await runtime.registry.snapshot();
            if (
              latest.events.some(
                (event) =>
                  event.sequence > (reservation.baselineSequence as number) &&
                  event.runId === id &&
                  (event.action === "produce-provisional" ||
                    event.action === "submit-proposal"),
              )
            )
              throw new CliError(
                EXIT.CONFLICT,
                `Submission partial; retry identical files: ${error instanceof Error ? error.message : String(error)}`,
              );
            throw error;
          }
          host.afterSkillAccepted?.();
          submissionState = await acceptedState();
          if (!submissionState)
            throw new CliError(
              EXIT.IO,
              "Submission remains partial after Core invocation",
            );
        }
        if (work.revisionRequests?.length) {
          let handoff = reservation as RevisionBinding;
          if (reservation.version === 1) {
            const recovered: Omit<RevisionBinding, "revisionDigest"> = {
              version: 2,
              runId: id,
              taskId,
              packageDigest: reservation.packageDigest as string,
              workDigest: reservation.workDigest as string,
              baselineSequence: reservation.baselineSequence as number,
              result: work.result,
              revisionRequests: work.revisionRequests,
            };
            handoff = {
              ...recovered,
              revisionDigest: revisionDigest(recovered),
            };
            const recoveryFile = markerFile.replace(
              /\.json$/,
              ".revision.json",
            );
            if (!(await atomicCreateJson(recoveryFile, handoff))) {
              const stored = await readJson(
                root,
                path.relative(root, recoveryFile),
              );
              if (canonicalJson(stored) !== canonicalJson(handoff))
                throw new CliError(
                  EXIT.CONFLICT,
                  "Recovered revision binding changed",
                );
            }
          }
          await routeRevisionRequests(root, markerFile, handoff, runtime);
        }
      } else {
        await runtime.orchestrator.invoke(
          id,
          tasks,
          taskId,
          host.executeSkill!,
          new Date().toISOString(),
        );
      }
      const plan = await runtime.orchestrator.next(id, tasks);
      const revisionRequests = revisionOverview(
        await revisionRecords(root, id, runtime),
      );
      emit(
        io,
        {
          ...summarizeNext(plan, await outputFile(root, plan)),
          ...(submissionState ? { submissionState } : {}),
          ...(revisionRequests ? { revisionRequests } : {}),
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "decisions") {
      if (positionals.length > 1)
        throw new CliError(EXIT.USAGE, "Usage: mimic decisions [run-id]");
      const state = await runtime.registry.snapshot();
      const packets = Object.values(state.packets)
        .filter((packet) => !positionals[0] || packet.runId === positionals[0])
        .map((packet) => ({
          id: packet.id,
          runId: packet.runId,
          proposals: packet.proposalIds.map((id) => ({
            id,
            status: state.runs[packet.runId]?.proposals[id]?.status,
            readiness: state.runs[packet.runId]?.proposals[id]?.readiness,
          })),
        }));
      emit(
        io,
        {
          packets,
          authority: host.authority ? "host-injected" : "local-confirmation",
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "decide") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "decide takes no positional arguments");
      if (options.acceptance) {
        if (
          options.file ||
          options.receipt ||
          options.confirmation ||
          options.commit ||
          options["commit-receipt"] ||
          options["commit-confirmation"]
        )
          throw new CliError(
            EXIT.USAGE,
            "Acceptance import takes only --acceptance",
          );
        const receiptAuthority = !host.authority && (await signedAuthority());
        if (!receiptAuthority)
          throw new CliError(
            EXIT.UNSUPPORTED,
            "Acceptance needs a protected trust root",
          );
        const acceptance = (await readJson(
          root,
          options.acceptance,
        )) as SignedAcceptance;
        await receiptAuthority.certify(acceptance);
        emit(
          io,
          { decisionId: acceptance.payload.decisionId, status: "certified" },
          json,
        );
        return EXIT.OK;
      }
      const signed = !!(options.receipt || options["commit-receipt"]);
      const local = !!(options.confirmation || options["commit-confirmation"]);
      if (host.authority && (signed || local))
        throw new CliError(
          EXIT.USAGE,
          "Host-injected authority cannot be mixed with CLI evidence",
        );
      if (signed && local)
        throw new CliError(
          EXIT.USAGE,
          "Signed and local confirmations cannot be mixed",
        );
      if (!host.authority && !signed && !local)
        throw new CliError(EXIT.USAGE, "Missing --confirmation or --receipt");
      if (
        options.commit &&
        !host.authority &&
        signed &&
        !options["commit-receipt"]
      )
        throw new CliError(EXIT.USAGE, "Missing --commit-receipt");
      if (
        options.commit &&
        !host.authority &&
        local &&
        !options["commit-confirmation"]
      )
        throw new CliError(EXIT.USAGE, "Missing --commit-confirmation");
      if (
        !options.commit &&
        (options["commit-receipt"] || options["commit-confirmation"])
      )
        throw new CliError(EXIT.USAGE, "Commit confirmation needs --commit");
      const receiptAuthority =
        signed && !host.authority ? await signedAuthority() : undefined;
      if (signed && !host.authority && !receiptAuthority)
        throw new CliError(
          EXIT.UNSUPPORTED,
          "Signed receipt needs a protected trust root",
        );
      const supplied = (await readJson(
        root,
        required(options.file, "--file"),
      )) as DecisionRecord;
      const decision = receiptAuthority
        ? await receiptAuthority.prepareDecision(
            supplied,
            (await readJson(
              root,
              required(options.receipt, "--receipt"),
            )) as SignedReceipt,
          )
        : local && !host.authority
          ? await localAuthority.prepareDecision(
              supplied,
              (await readJson(
                root,
                required(options.confirmation, "--confirmation"),
              )) as LocalConfirmation,
            )
          : supplied;
      await runtime.registry.decide(decision);
      if (options.commit) {
        const request = (await readJson(root, options.commit)) as CommitRequest;
        if (receiptAuthority)
          await receiptAuthority.prepareCommit(
            request,
            (await readJson(
              root,
              required(options["commit-receipt"], "--commit-receipt"),
            )) as SignedReceipt,
          );
        if (local && !host.authority)
          await localAuthority.prepareCommit(
            request,
            (await readJson(
              root,
              required(options["commit-confirmation"], "--commit-confirmation"),
            )) as LocalConfirmation,
          );
        try {
          await runtime.registry.commit(request);
        } finally {
          receiptAuthority?.clearCommit();
          localAuthority.clearCommit();
        }
      }
      emit(
        io,
        {
          decisionId: decision.id,
          status: options.commit ? "committed" : "recorded",
          statePath: ".mimic/workspace.json",
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "validate") {
      if (positionals.length)
        throw new CliError(
          EXIT.USAGE,
          "validate takes no positional arguments",
        );
      const artifact = await readJson(root, required(options.file, "--file"));
      const result = schemas.validate(artifact);
      const file = result.diagnostics.length
        ? await outputFile(root, result.diagnostics)
        : undefined;
      if (!result.valid)
        io.err(
          `MIMIC_${EXIT.INVALID}: Schema validation failed; diagnostics: ${file}`,
        );
      emit(
        io,
        {
          valid: result.valid,
          level: "schema-only",
          diagnostics: result.diagnostics.length,
          ...(file ? { path: file } : {}),
        },
        json,
      );
      return result.valid ? EXIT.OK : EXIT.INVALID;
    }
    if (command === "preview") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "preview takes no positional arguments");
      const plan = (await readJson(
        root,
        required(options.file, "--file"),
      )) as PreviewPlan;
      const preview = await createPreview(
        root,
        runtime.artifacts,
        plan,
        browser,
      );
      const paths: string[] = [];
      for (const report of preview.reports)
        paths.push(await outputFile(root, report));
      emit(
        io,
        {
          directories: preview.directories.map((directory) =>
            path.relative(root, directory),
          ),
          reports: preview.reports.map((report, i) => ({
            path: paths[i],
            bundleDigest: report.target.bundleDigest,
            findings: report.findings.map((finding) => ({
              criterion: finding.criterion,
              state: finding.state,
              severity: finding.severity,
            })),
          })),
          ...(preview.fallback ? { fallback: preview.fallback } : {}),
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "release") {
      const [action, id] = positionals;
      if (browser)
        throw new CliError(EXIT.USAGE, "--browser is only valid for preview");
      if (action === "inspect" && positionals.length === 1) {
        const plan = (await readJson(
          root,
          required(options.file, "--file"),
        )) as ReleasePlan;
        if (
          !plan ||
          typeof plan !== "object" ||
          !Array.isArray(plan.quality) ||
          !Array.isArray(plan.dependencies) ||
          !plan.files ||
          typeof plan.files !== "object"
        )
          throw new CliError(EXIT.INVALID, "Invalid release evidence");
        const reports = [];
        for (const item of plan.quality) {
          if (!item || typeof item.report !== "string")
            throw new CliError(EXIT.INVALID, "Invalid release quality entry");
          const report = object(await readJson(root, item.report));
          if (!Array.isArray(report.findings))
            throw new CliError(EXIT.INVALID, "Invalid quality report");
          reports.push({
            reportDigest: `sha256:${jsonDigest(report)}`,
            findings: report.findings.map((finding, findingIndex) => {
              const value = object(finding);
              return {
                findingIndex,
                findingDigest: `sha256:${jsonDigest(finding)}`,
                criterion: value.criterion,
                state: value.state,
                severity: value.severity,
              };
            }),
          });
        }
        if (
          plan.dependencies.length > 0 &&
          (!plan.ref ||
            typeof plan.ref.packageId !== "string" ||
            typeof plan.ref.version !== "string" ||
            !["reference", "portable"].includes(plan.mode))
        )
          throw new CliError(EXIT.INVALID, "Invalid dependency consumer");
        const dependencyReview = plan.dependencies.length
          ? await reviewDependencies(
              root,
              `sha256:${jsonDigest(plan)}`,
              { ref: plan.ref, mode: plan.mode },
              plan.dependencies,
            )
          : undefined;
        emit(
          io,
          {
            planDigest: `sha256:${jsonDigest(plan)}`,
            dependencyCount: plan.dependencies?.length ?? 0,
            reports,
            ...(dependencyReview
              ? {
                  dependencyContext: dependencyReview.context,
                  dependencyContextDigest: dependencyReview.contextDigest,
                  missingDecisions: {
                    packages: dependencyReview.context.nodes.map((node) => ({
                      ref: node.ref,
                      digest: node.digest,
                    })),
                    licenses: dependencyReview.context.edges,
                    redistribution:
                      plan.mode === "portable"
                        ? dependencyReview.context.nodes.map((node) => ({
                            ref: node.ref,
                            digest: node.digest,
                          }))
                        : [],
                  },
                }
              : {}),
          },
          json,
        );
        return EXIT.OK;
      }
      if (action === "prepare" && positionals.length === 1) {
        const file = required(options.file, "--file");
        const plan = (await readJson(root, file)) as ReleasePlan;
        const localPolicy = options["policy-confirmation"]
          ? ((await readJson(
              root,
              options["policy-confirmation"],
            )) as LocalReleasePolicyConfirmation)
          : undefined;
        if (options["policy-confirmation"] && !localPolicy)
          throw new CliError(EXIT.INVALID, "Invalid local policy confirmation");
        const dependencyConfirmation = options["dependency-confirmation"]
          ? ((await readJson(
              root,
              options["dependency-confirmation"],
            )) as DependencyConfirmation)
          : undefined;
        if (options["dependency-confirmation"] && !dependencyConfirmation)
          throw new CliError(EXIT.INVALID, "Invalid dependency confirmation");
        const prepared = await prepareRelease(
          root,
          safeId(required(options.id, "--id"), "release ID"),
          required(options.destination, "--destination"),
          plan,
          `sha256:${jsonDigest(plan)}`,
          runtime.artifacts,
          host.release,
          schemas,
          config.scopes,
          localPolicy,
          dependencyConfirmation,
        );
        const review = releaseReview(prepared);
        const reviewPath = await outputFile(root, {
          ...review,
          requestDigest: `sha256:${jsonDigest(review)}`,
        });
        emit(
          io,
          {
            id: prepared.id,
            status: "prepared",
            digest: prepared.request.digest,
            reviewPath,
          },
          json,
        );
        return EXIT.OK;
      }
      if (action === "publish" && positionals.length === 2) {
        const result = await publishRelease(
          root,
          safeId(id!, "release ID"),
          (await readJson(
            root,
            required(options.confirmation, "--confirmation"),
          )) as ReleaseConfirmation,
          runtime.artifacts,
          host.release,
          schemas,
          config.scopes,
        );
        emit(
          io,
          {
            status: result.recovered ? "recovered" : "published",
            ref: result.ref,
            digest: result.digest,
            directory: path.relative(root, result.directory),
          },
          json,
        );
        return EXIT.OK;
      }
      throw new CliError(
        EXIT.USAGE,
        "Usage: mimic release inspect --file <plan> | release prepare --id <id> --file <plan> --destination <directory> [--policy-confirmation <file>] [--dependency-confirmation <file>] | release publish <id> --confirmation <file>",
      );
    }
    throw new CliError(EXIT.USAGE, "Unknown command");
  } catch (error) {
    const code =
      error instanceof CliError
        ? error.code
        : error instanceof PlanError
          ? EXIT.INVALID
          : error instanceof ReceiptError ||
              error instanceof LocalConfirmationError
            ? error.code === "CONFLICT"
              ? EXIT.CONFLICT
              : EXIT.INVALID
            : error instanceof RegistryError
              ? error.code === "CONFLICT"
                ? EXIT.CONFLICT
                : EXIT.INVALID
              : error instanceof CliReleaseError ||
                  error instanceof CliDependencyError
                ? error.code === "CONFLICT"
                  ? EXIT.CONFLICT
                  : error.code === "UNSUPPORTED"
                    ? EXIT.UNSUPPORTED
                    : EXIT.INVALID
                : error instanceof PackageCompilerError
                  ? error.code === "CONFLICT"
                    ? EXIT.CONFLICT
                    : EXIT.INVALID
                  : error instanceof CliPreviewError ||
                      error instanceof PackageRegistryError ||
                      error instanceof PrototypeBuilderError ||
                      error instanceof PrototypeModeError
                    ? EXIT.INVALID
                    : EXIT.IO;
    io.err(
      `MIMIC_${code}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return code;
  }
}
