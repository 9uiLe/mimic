import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { atomicCreateJson } from "./atomic-file.js";
import { PlanError, preflightPlan, scopeChain } from "./plan.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  getStatus,
  loadSchemaDirectory,
  RegistryError,
  type AuthorityVerifier,
  type CommitRequest,
  type DecisionRecord,
  type RegistryAuthority,
  type RoutedTask,
  type ScopeNode,
  type SkillInvocation,
  type SkillResult,
} from "@mimic/core";

export interface CliHost {
  /** Supplied by a trusted embedding host; never constructed from a CLI input file. */
  readonly authority?: RegistryAuthority;
  readonly seedAuthority?: AuthorityVerifier;
  readonly executeSkill?: (invocation: SkillInvocation) => Promise<SkillResult>;
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
  const schemaDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../schemas/artifacts",
  );
  const schemas = await loadSchemaDirectory(schemaDir);
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    config.scopes,
    host.authority ?? denyAuthority,
    host.seedAuthority,
  );
  return { config, schemas, runtime };
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
    const { config, schemas, runtime } = await load(root, host);
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
      if (!host.executeSkill)
        throw new CliError(
          EXIT.UNSUPPORTED,
          "Skill submission requires a trusted host executor; standalone Skill transport is pending",
        );
      const id = safeId(positionals[0]!, "run ID");
      const taskId = required(options.task, "--task");
      const { run } = await runtime.registry.run(id);
      const tasks = await savedTasks(root, id, config, run.scope);
      await runtime.orchestrator.invoke(
        id,
        tasks,
        taskId,
        host.executeSkill,
        new Date().toISOString(),
      );
      const plan = await runtime.orchestrator.next(id, tasks);
      emit(io, summarizeNext(plan, await outputFile(root, plan)), json);
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
          authority: host.authority ? "host-injected" : "unavailable",
        },
        json,
      );
      return EXIT.OK;
    }
    if (command === "decide") {
      if (positionals.length)
        throw new CliError(EXIT.USAGE, "decide takes no positional arguments");
      if (!host.authority)
        throw new CliError(
          EXIT.UNSUPPORTED,
          "Human decisions require a trusted host authority verifier",
        );
      const decision = (await readJson(
        root,
        required(options.file, "--file"),
      )) as DecisionRecord;
      await runtime.registry.decide(decision);
      if (options.commit)
        await runtime.registry.commit(
          (await readJson(root, options.commit)) as CommitRequest,
        );
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
