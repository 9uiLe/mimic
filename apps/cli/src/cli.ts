import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { atomicCreateJson } from "./atomic-file.js";
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
} from "@mimic/core";

export interface CliHost {
  /** Supplied by a trusted embedding host; never constructed from a CLI input file. */
  readonly authority?: RegistryAuthority;
  /** Trusted launch configuration; the standalone binary loads it only from an OS-protected fixed path. */
  readonly operatorTrust?: OperatorTrust;
  readonly seedAuthority?: AuthorityVerifier;
  readonly executeSkill?: (invocation: SkillInvocation) => Promise<SkillResult>;
  /** Trusted host fault hook; useful for testing recovery after Core accepts a submission. */
  readonly afterSkillAccepted?: () => void;
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
const denyAuthority: RegistryAuthority = {
  async verify() {
    return false;
  },
  async allowCommit() {
    return false;
  },
};
const commands = new Set([
  "init",
  "status",
  "run",
  "next",
  "submit",
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
      "Usage: mimic <init|status|run|next|submit|decisions|decide|preview|validate|release> [options]",
    );
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") {
      json = true;
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
          "acceptance",
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
  return { command, options, positionals, json };
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
  const receiptAuthority =
    !host.authority && host.operatorTrust
      ? new ReceiptAuthority(workspace, root, host.operatorTrust)
      : undefined;
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    config.scopes,
    host.authority ?? receiptAuthority ?? denyAuthority,
    host.seedAuthority,
  );
  return { config, schemas, schemasRoot, runtime, receiptAuthority };
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
  try {
    const { command, options, positionals, json } = parse(argv);
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
    const { config, schemas, schemasRoot, runtime, receiptAuthority } =
      await load(root, host);
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
      emit(io, summarizeNext(plan, await outputFile(root, plan)), json);
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
        const binding = {
          version: 1,
          runId: id,
          taskId,
          packageDigest: jsonDigest(skill),
          workDigest: jsonDigest(submission),
          baselineSequence: before.events.at(-1)?.sequence ?? 0,
        };
        const created = await atomicCreateJson(markerFile, binding);
        const reservation = created
          ? binding
          : object(await readJson(root, path.relative(root, markerFile)));
        if (
          reservation.version !== binding.version ||
          reservation.runId !== binding.runId ||
          reservation.taskId !== binding.taskId ||
          reservation.packageDigest !== binding.packageDigest ||
          reservation.workDigest !== binding.workDigest ||
          !Number.isSafeInteger(reservation.baselineSequence)
        )
          throw new CliError(EXIT.CONFLICT, "Submission retry changed input");
        const acceptedState = async () => {
          const state = await runtime.registry.snapshot();
          const terminal = state.events.find((event) => {
            if (
              event.sequence <= (reservation.baselineSequence as number) ||
              event.runId !== id ||
              event.action !== "set-work" ||
              event.actor.kind !== "agent" ||
              event.actor.id !== "orchestrator" ||
              event.runAfter.safeActions.includes(taskId) ||
              !work.result.outputRefs.every((ref) =>
                event.runAfter.artifacts.some(
                  (recorded) => canonicalJson(recorded) === canonicalJson(ref),
                ),
              )
            )
              return false;
            if (work.result.proposal) {
              const proposed = work.result.proposal.items.every((item) => {
                const stored = event.runAfter.proposals[item.id];
                if (
                  !stored ||
                  stored.packetId !== work.result.proposal?.packetId
                )
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
            return work.result.blocked
              ? event.reason ===
                  "Skill reported a genuine affected-work blocker" &&
                  work.result.blocked.reason === event.runAfter.blockers[taskId]
              : event.reason ===
                  `Skill task ${JSON.stringify(taskId)} completed with verified exact outputs`;
          });
          return terminal
            ? work.result.blocked
              ? "blocked"
              : "accepted"
            : undefined;
        };
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
            await runSkillPackage({
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
      emit(
        io,
        {
          ...summarizeNext(plan, await outputFile(root, plan)),
          ...(submissionState ? { submissionState } : {}),
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
          authority: host.authority
            ? "host-injected"
            : receiptAuthority
              ? "signed-receipt"
              : "unavailable",
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
          options.commit ||
          options["commit-receipt"]
        )
          throw new CliError(
            EXIT.USAGE,
            "Acceptance import takes only --acceptance",
          );
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
      if (!host.authority && !receiptAuthority)
        throw new CliError(
          EXIT.UNSUPPORTED,
          "Human decisions require an operator-protected trust root",
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
        try {
          await runtime.registry.commit(request);
        } finally {
          receiptAuthority?.clearCommit();
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
    if (command === "preview" || command === "release")
      throw new CliError(
        EXIT.UNSUPPORTED,
        `${command} backend is not implemented`,
      );
    throw new CliError(EXIT.USAGE, "Unknown command");
  } catch (error) {
    const code =
      error instanceof CliError
        ? error.code
        : error instanceof PlanError
          ? EXIT.INVALID
          : error instanceof ReceiptError
            ? error.code === "CONFLICT"
              ? EXIT.CONFLICT
              : EXIT.INVALID
            : error instanceof RegistryError
              ? error.code === "CONFLICT"
                ? EXIT.CONFLICT
                : EXIT.INVALID
              : EXIT.IO;
    io.err(
      `MIMIC_${code}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return code;
  }
}
