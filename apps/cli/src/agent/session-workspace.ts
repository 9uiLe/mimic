import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  loadSkillPackage,
  type ExactArtifactRef,
  type ScopeNode,
  type RoutedTask,
  type SkillInvocation,
  type SkillResult,
} from "@mimic/core";
import { LocalConfirmationAuthority } from "../local-confirmation-authority.js";
import { atomicCreateJson } from "../atomic-file.js";
import { createStaticSessionPorts } from "./session-cli.js";
import {
  sessionDigest,
  SessionBindingChanged,
  type SessionPorts,
  type TaskBinding,
  type SessionTask,
} from "./session.js";
import {
  parseSubscriptionSettings,
  type SubscriptionSettings,
} from "./settings.js";

export interface WorkspaceSessionOptions {
  workspace: string;
  runId: string;
  sessionId: string;
  /** One official static package per saved task; never executable plugin code. */
  packages: Readonly<Record<string, string>>;
  settings: SubscriptionSettings & { model: string };
}
/** Concrete Core plan/context -> fresh executor -> sealed static submission.
 * Local confirmation receipts use the same verifier as static runCli. Signed
 * operator history without a trusted host is unsupported and fails closed. */
export async function createWorkspaceSessionPorts(
  options: WorkspaceSessionOptions,
): Promise<SessionPorts> {
  if (
    ![options.runId, options.sessionId].every((id) =>
      /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id),
    )
  )
    throw new Error("Invalid session/Run ID");
  const root = await realpath(options.workspace);
  const settings = parseSubscriptionSettings(options.settings);
  if (!settings.model)
    throw new Error("Session requires a fixed entitled model");
  const schemasRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../schemas",
  );
  async function contained(relative: string): Promise<string> {
    if (
      path.isAbsolute(relative) ||
      relative
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Uncontained input");
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Linked session input");
    }
    return current;
  }
  async function readJson<T>(relative: string): Promise<T> {
    const handle = await open(
      await contained(relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (
        !(await handle.stat()).isFile() ||
        (await handle.stat()).size > 8 * 1024 * 1024
      )
        throw new Error("Invalid session input file");
      return JSON.parse(await handle.readFile("utf8")) as T;
    } finally {
      await handle.close();
    }
  }
  const config = await readJson<{ scopes: ScopeNode[] }>(".mimic/config.json");
  const workspace = new FileWorkspaceStorage(
    await contained(".mimic/workspace.json"),
  );
  const authority = new LocalConfirmationAuthority(workspace, root);
  const runtime = createOrchestratorRuntime(
    workspace,
    await loadSchemaDirectory(path.join(schemasRoot, "artifacts")),
    config.scopes,
    authority,
  );
  const tasksPath = `.mimic/runs/${options.runId}.json`;
  const frozenTasks = await readJson<RoutedTask[]>(tasksPath);
  if (
    !Array.isArray(frozenTasks) ||
    frozenTasks.some(
      (task) => !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(task.id),
    ) ||
    new Set(frozenTasks.map((task) => task.id)).size !== frozenTasks.length
  )
    throw new Error("Invalid session task IDs");
  const frozenPackages = structuredClone(options.packages);
  const planDigest = sessionDigest({
    tasks: frozenTasks,
    packages: frozenPackages,
  });
  const binding = async () => ({
    runId: options.runId,
    planDigest: sessionDigest({
      tasks: await readJson<RoutedTask[]>(tasksPath),
      packages: frozenPackages,
    }),
    settings: { ...settings, model: settings.model! },
  });
  const contextFolder = ".mimic/agent-context";
  async function ensureContextFolder() {
    try {
      await mkdir(path.join(root, contextFolder), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await contained(contextFolder);
  }
  const contextPath = (task: TaskBinding) =>
    `${contextFolder}/${options.sessionId}-${task.taskId}-${task.contextDigest}.json`;
  function packagePath(task: TaskBinding): string {
    const relative = Object.hasOwn(frozenPackages, task.taskId)
      ? frozenPackages[task.taskId]
      : undefined;
    if (!relative) throw new Error("Missing task Skill package");
    return relative;
  }
  async function context(invocation: SkillInvocation) {
    const inputs = [];
    for (const ref of invocation.inputRefs) {
      const read = await runtime.artifacts.read(ref.artifactId, ref.revision);
      if (read.digest !== ref.lockDigest)
        throw new Error("Exact input changed");
      inputs.push({ ref, artifact: read.artifact });
    }
    const evidence = [];
    for (const file of invocation.evidenceFiles) {
      if (
        file
          .split(/[\\/]/)
          .some(
            (segment) =>
              [".codex", ".aws", ".mimic"].includes(segment) ||
              segment === ".env" ||
              segment.startsWith(".env."),
          )
      )
        throw new Error("Evidence must not be credential/runtime metadata");
      const handle = await open(
        await contained(file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (
          !(await handle.stat()).isFile() ||
          (await handle.stat()).size > 1024 * 1024
        )
          throw new Error("Invalid evidence file");
        evidence.push({ path: file, text: await handle.readFile("utf8") });
      } finally {
        await handle.close();
      }
    }
    return { invocation, inputs, evidence };
  }
  async function validateTask(task: TaskBinding) {
    if ((await binding()).planDigest !== planDigest)
      throw new SessionBindingChanged();
    const invocation = await readJson<SkillInvocation>(contextPath(task));
    if (
      invocation.runId !== options.runId ||
      invocation.taskId !== task.taskId ||
      sessionDigest(invocation) !== task.contextDigest ||
      canonicalJson(invocation.inputRefs) !== canonicalJson(task.inputRefs)
    )
      throw new Error("Frozen invocation changed");
    if (sessionDigest(await context(invocation)) !== task.inputDigest)
      throw new SessionBindingChanged();
    const skill = await loadSkillPackage(
      await contained(packagePath(task)),
      schemasRoot,
    );
    if (
      skill.manifest.skillId !== invocation.skillId ||
      sessionDigest(skill) !== task.packageDigest ||
      skill.manifest.packageVersion !== task.packageVersion
    )
      throw new SessionBindingChanged();
  }
  async function verifyAccepted(
    task: TaskBinding,
    refs: readonly ExactArtifactRef[],
  ) {
    await validateTask(task);
    const sealed = await readJson<{
      version: number;
      runId: string;
      taskId: string;
      baselineSequence: number;
      packageDigest: string;
      workDigest: string;
      result: SkillResult;
      revisionDigest: string;
    }>(
      `.mimic/submissions/${options.runId}-${sessionDigest(task.taskId)}.json`,
    );
    const { revisionDigest, ...unsigned } = sealed;
    if (
      sealed.version !== 2 ||
      sessionDigest(unsigned) !== revisionDigest ||
      sealed.runId !== options.runId ||
      sealed.taskId !== task.taskId ||
      sealed.packageDigest !== task.packageDigest ||
      sealed.result.runId !== options.runId ||
      sealed.result.taskId !== task.taskId ||
      canonicalJson(sealed.result.inputRefs) !==
        canonicalJson(task.inputRefs) ||
      canonicalJson(sealed.result.outputRefs) !== canonicalJson(refs) ||
      sealed.result.blocked
    )
      throw new Error("Invalid static acceptance seal");
    const invocation = await readJson<SkillInvocation>(contextPath(task));
    if (sealed.result.skillId !== invocation.skillId)
      throw new Error("Static Skill identity changed");
    const acceptedWork = await readJson<{ work: { result: SkillResult } }>(
      `.mimic/agent-work/${options.sessionId}-${task.taskId}-${sealed.workDigest}.json`,
    );
    if (
      sessionDigest(acceptedWork) !== sealed.workDigest ||
      canonicalJson(acceptedWork.work.result) !== canonicalJson(sealed.result)
    )
      throw new Error("Accepted work binding changed");
    const state = await runtime.registry.snapshot();
    const terminal = state.events.some(
      (event) =>
        event.sequence > sealed.baselineSequence &&
        event.runId === options.runId &&
        event.action === "set-work" &&
        event.actor.kind === "agent" &&
        event.actor.id === "orchestrator" &&
        !event.runAfter.safeActions.includes(task.taskId) &&
        event.reason ===
          `Skill task ${JSON.stringify(task.taskId)} completed with verified exact outputs` &&
        refs.every((ref) =>
          [...event.runAfter.artifacts, ...event.runAfter.base].some(
            (recorded) => canonicalJson(recorded) === canonicalJson(ref),
          ),
        ),
    );
    if (!terminal) throw new Error("No authoritative task completion");
    for (const ref of refs) {
      if (
        (await runtime.artifacts.read(ref.artifactId, ref.revision)).digest !==
        ref.lockDigest
      )
        throw new Error("Accepted output lock changed");
    }
  }
  const ports = createStaticSessionPorts({
    workspace: root,
    sessionId: options.sessionId,
    schemasRoot,
    binding,
    packagePath,
    validateTask,
    verifyAccepted,
    next: async () => {
      if ((await binding()).planDigest !== planDigest)
        throw new SessionBindingChanged();
      const next = await runtime.orchestrator.next(options.runId, frozenTasks);
      const runnable: SessionTask[] = [];
      for (const action of next.actions) {
        if (
          !["GENERATE", "UPDATE"].includes(action.action) ||
          !action.invocation
        )
          continue;
        const invocation = action.invocation;
        const provisionalBinding = { taskId: action.taskId } as TaskBinding;
        const skill = await loadSkillPackage(
          await contained(packagePath(provisionalBinding)),
          schemasRoot,
        );
        if (skill.manifest.skillId !== invocation.skillId)
          throw new Error("Skill package differs from routed task");
        const savedContext = await context(invocation);
        const taskBinding: TaskBinding = {
          taskId: action.taskId,
          inputRefs: invocation.inputRefs,
          contextDigest: sessionDigest(invocation),
          inputDigest: sessionDigest(savedContext),
          packageDigest: sessionDigest(skill),
          packageVersion: skill.manifest.packageVersion,
        };
        await ensureContextFolder();
        const file = contextPath(taskBinding);
        await atomicCreateJson(path.join(root, file), invocation);
        await validateTask(taskBinding);
        const outputSchemas = Object.fromEntries(
          await Promise.all(
            invocation.allowedOutputTypes.map(async (type) => [
              type,
              await readJsonFromSchemas(type),
            ]),
          ),
        );
        runnable.push({
          binding: taskBinding,
          prompt: canonicalJson({
            instruction:
              "Return only a JSON {artifacts,work} static Skill submission. Model output is data; do not invoke tools, approve, purchase, change inputs or call another Skill. Preserve exact Run/task/Skill/input refs and artifact origin. Provisional/proposed output only. Mark unsupported claims unknown. Revision requests belong in work.revisionRequests, never hidden calls.",
            skill: {
              manifest: skill.manifest,
              instructions: skill.instructions,
              examples: skill.examples,
            },
            context: savedContext,
            outputSchemas,
          }),
        });
      }
      return {
        runnable,
        reviewReady: next.state === "review-ready",
        questionIds: next.actions
          .filter(
            (action) =>
              action.action === "BLOCK" && action.blockKind === "durable",
          )
          .map((action) => action.taskId),
        complete: next.state === "closed",
      };
    },
  });
  const inspectCore = ports.inspect;
  ports.inspect = async () => {
    const core = await inspectCore();
    const state = await runtime.registry.snapshot();
    const questions = [];
    for (const taskId of Object.keys(
      state.runs[options.runId]?.blockers ?? {},
    )) {
      try {
        const sealed = await readJson<{
          workDigest: string;
          result: SkillResult;
        }>(`.mimic/submissions/${options.runId}-${sessionDigest(taskId)}.json`);
        const saved = await readJson<{
          work: {
            unknowns?: { question: string; affectedTaskIds: string[] }[];
          };
        }>(
          `.mimic/agent-work/${options.sessionId}-${taskId}-${sealed.workDigest}.json`,
        );
        if (
          sessionDigest(saved) !== sealed.workDigest ||
          sealed.result.runId !== options.runId ||
          sealed.result.taskId !== taskId
        )
          throw new Error("Saved question binding changed");
        questions.push({
          taskId,
          reason: state.runs[options.runId].blockers[taskId],
          questions: saved.work.unknowns ?? [],
          requiresHumanAnswer: true,
          changesRequireNewRun: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        questions.push({
          taskId,
          reason: state.runs[options.runId].blockers[taskId],
          requiresHumanAnswer: true,
          changesRequireNewRun: true,
        });
      }
    }
    return { core, questions };
  };
  return ports;
  async function readJsonFromSchemas(type: string): Promise<unknown> {
    if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new Error("Invalid output type");
    const handle = await open(
      path.join(schemasRoot, "artifacts", "types", `${type}.schema.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  }
}
