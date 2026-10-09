import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { atomicCreateJson } from "../atomic-file.js";
import { canonicalJson, type ExactArtifactRef } from "@mimic/core";
import {
  startExecution,
  type AgentExecutor,
  type ExecutionRequest,
  type StopReason,
  sanitizeExecutionDiagnostics,
  type ExecutionDiagnostics,
} from "./executor.js";
import {
  isAuthorizedSessionDispatch,
  type AuthorizedSessionDispatch,
} from "./session-authorized.js";
import {
  parseSubscriptionSettings,
  type SubscriptionSettings,
} from "./settings.js";

/** This is a Mimic checkpoint, separate from a Core Run or native conversation. */
export interface SessionBinding {
  runId: string;
  planDigest: string;
  settings: SubscriptionSettings & { model: string };
}
export interface TaskBinding {
  taskId: string;
  inputDigest: string;
  packageDigest: string;
  packageVersion: string;
  contextDigest: string;
  inputRefs: readonly ExactArtifactRef[];
}
export interface SessionTask {
  binding: TaskBinding;
  /** Reconstructed from frozen Skill/context inputs; never in checkpoint diagnostics. */
  prompt: string;
}
export interface SessionPlan {
  runnable: readonly SessionTask[];
  reviewReady: boolean;
  questionIds: readonly string[];
  complete: boolean;
}
export interface SavedWork {
  path: string;
  digest: string;
}
/** Trusted ports retain the Core/static-submit authority boundary. They must not
 * grant approval or use CliHost.executeSkill's raw invoke shortcut. */
export interface SessionPorts {
  workspace: string;
  binding(): Promise<SessionBinding>;
  next(): Promise<SessionPlan>;
  saveWork(task: TaskBinding, output: string): Promise<SavedWork>;
  /** Idempotent exact-file static submission also recovers revision side channels. */
  submit(
    task: TaskBinding,
    work: SavedWork,
  ): Promise<readonly ExactArtifactRef[]>;
  /** Authority-read accepted Run production, not checkpoint assertions. */
  verifyAccepted(
    task: TaskBinding,
    refs: readonly ExactArtifactRef[],
  ): Promise<void>;
  /** Use 165's authority-validating read ports; inspection never advances state. */
  inspect(): Promise<unknown>;
}
export type SessionStop =
  | StopReason
  | "question"
  | "approval"
  | "waiting"
  | "reservation-invalid"
  | "candidate-rejected"
  | "iteration-limit";
interface TaskCheckpoint {
  binding: TaskBinding;
  phase: "executing" | "prepared" | "accepted" | "blocked" | "rejected";
  rejectionReason?: "preparation" | "static-validation";
  work?: SavedWork;
  outputRefs?: readonly ExactArtifactRef[];
  diagnostics?: ExecutionDiagnostics;
}
export interface SessionCheckpoint {
  version: 1;
  sessionId: string;
  binding: SessionBinding;
  generationCount: number;
  tasks: Record<string, TaskCheckpoint>;
  status: "ready" | "stopped" | "complete";
  stop?: SessionStop;
  questionIds: readonly string[];
  /** Records an explicit one-call exception, never a billing-proof assertion. */
  executionPolicy?: "authorized-existing-credit-risk-once";
}
export function sessionDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const artifactIdentifier = /^art_[A-Za-z0-9_-]{1,255}$/;
function validateBinding(value: SessionBinding): SessionBinding {
  const settings = parseSubscriptionSettings(value.settings);
  if (
    !identifier.test(value.runId) ||
    !/^[a-f0-9]{64}$/.test(value.planDigest) ||
    !settings.model
  )
    throw new Error("Invalid frozen session binding");
  return {
    runId: value.runId,
    planDigest: value.planDigest,
    settings: { ...settings, model: settings.model },
  };
}
function validateTask(task: TaskBinding): void {
  if (
    !identifier.test(task.taskId) ||
    !task.packageVersion ||
    [task.inputDigest, task.packageDigest, task.contextDigest].some(
      (digest) => !/^[a-f0-9]{64}$/.test(digest),
    ) ||
    !Array.isArray(task.inputRefs) ||
    task.inputRefs.some(
      (ref) =>
        !artifactIdentifier.test(ref.artifactId) ||
        !Number.isSafeInteger(ref.revision) ||
        ref.revision < 1 ||
        !/^sha256:[a-f0-9]{64}$/.test(ref.lockDigest),
    )
  )
    throw new Error("Invalid exact task binding");
}
/** Directory is private and exclusively locked across the entire model/submit
 * operation. Refuse links; checkpoint hashes detect damage, not Core authority. */
export class FileSessionStore {
  private readonly retainedLocks = new Set<string>();
  constructor(
    readonly workspace: string,
    readonly relativeDirectory = ".mimic/agent-sessions",
  ) {
    if (
      path.isAbsolute(relativeDirectory) ||
      relativeDirectory
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid session directory");
  }
  get directory(): string {
    return path.join(this.workspace, this.relativeDirectory);
  }
  private async directoryPath(create = true): Promise<string> {
    let current = await realpath(this.workspace);
    for (const part of this.relativeDirectory.split(path.sep)) {
      current = path.join(current, part);
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Session directory must not contain a link");
    }
    return current;
  }
  /** Incomplete cancellation keeps the live process lease. Explicit stale-lock
   * recovery becomes possible only after that owner exits. */
  retainLock(id: string): void {
    this.retainedLocks.add(id);
  }
  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!identifier.test(id)) throw new Error("Invalid session ID");
    const directory = await this.directoryPath();
    const lock = path.join(directory, `${id}.lock`);
    try {
      await lstat(path.join(directory, `${id}.recovery`));
      throw new Error("Session lock recovery is active");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(lock, { mode: 0o700 });
    try {
      await atomicCreateJson(path.join(lock, "owner.json"), {
        pid: process.pid,
        host: hostname(),
        nonce: randomUUID(),
      });
      return await operation();
    } finally {
      if (!this.retainedLocks.has(id))
        await rm(lock, { recursive: true, force: true });
    }
  }
  /** Explicit recovery only. Never remove a live/unknown/foreign-host owner.
   * A recovery marker serializes recovery attempts; normal acquisition refuses it. */
  async recoverAbandonedLock(id: string): Promise<void> {
    if (!identifier.test(id)) throw new Error("Invalid session ID");
    const directory = await this.directoryPath();
    const recovery = path.join(directory, `${id}.recovery`);
    await mkdir(recovery, { mode: 0o700 });
    try {
      const lock = path.join(directory, `${id}.lock`);
      if (
        !(await lstat(lock)).isDirectory() ||
        (await lstat(lock)).isSymbolicLink()
      )
        throw new Error("Invalid session lock");
      const handle = await open(
        path.join(lock, "owner.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let owner: { pid: number; host: string; nonce: string };
      try {
        owner = JSON.parse(await handle.readFile("utf8")) as typeof owner;
      } finally {
        await handle.close();
      }
      if (
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        owner.host !== hostname() ||
        typeof owner.nonce !== "string" ||
        !owner.nonce
      )
        throw new Error("Unknown session lock owner");
      try {
        process.kill(owner.pid, 0);
        throw new Error("Session lock owner is still alive");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const abandoned = path.join(directory, `${id}.${randomUUID()}.abandoned`);
      await rename(lock, abandoned);
      await rm(abandoned, { recursive: true, force: true });
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  async read(id: string): Promise<SessionCheckpoint | undefined> {
    if (!identifier.test(id)) throw new Error("Invalid session ID");
    try {
      const file = path.join(await this.directoryPath(false), `${id}.json`);
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || (await lstat(file)).isSymbolicLink())
          throw new Error("Invalid checkpoint file");
        const envelope = JSON.parse(await handle.readFile("utf8")) as {
          digest: string;
          checkpoint: SessionCheckpoint;
        };
        const value = envelope.checkpoint;
        if (
          sessionDigest(value) !== envelope.digest ||
          value.version !== 1 ||
          value.sessionId !== id ||
          !Number.isSafeInteger(value.generationCount) ||
          value.generationCount < 0 ||
          !["ready", "stopped", "complete"].includes(value.status) ||
          !Array.isArray(value.questionIds) ||
          (value.executionPolicy !== undefined &&
            value.executionPolicy !== "authorized-existing-credit-risk-once")
        )
          throw new Error("Invalid checkpoint");
        validateBinding(value.binding);
        for (const [taskId, task] of Object.entries(value.tasks)) {
          validateTask(task.binding);
          if (
            taskId !== task.binding.taskId ||
            ![
              "executing",
              "prepared",
              "accepted",
              "blocked",
              "rejected",
            ].includes(task.phase) ||
            (task.phase !== "executing" &&
              task.phase !== "rejected" &&
              !task.work) ||
            (task.phase === "rejected" &&
              !["preparation", "static-validation"].includes(
                task.rejectionReason ?? "",
              )) ||
            (task.phase !== "rejected" && task.rejectionReason !== undefined) ||
            (task.phase === "accepted" && !Array.isArray(task.outputRefs)) ||
            (task.diagnostics !== undefined &&
              !sanitizeExecutionDiagnostics(task.diagnostics))
          )
            throw new Error("Invalid task checkpoint");
        }
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(checkpoint: SessionCheckpoint): Promise<void> {
    checkpoint = {
      ...checkpoint,
      tasks: Object.fromEntries(
        Object.entries(checkpoint.tasks).map(([id, task]) => {
          const raw = task.diagnostics;
          const diagnostics = sanitizeExecutionDiagnostics(raw);
          if (raw !== undefined && !diagnostics)
            throw new Error("Invalid task diagnostics");
          return [id, { ...task, diagnostics }];
        }),
      ),
    };
    if (!identifier.test(checkpoint.sessionId))
      throw new Error("Invalid session ID");
    const directory = await this.directoryPath();
    const temporary = path.join(
      directory,
      `${checkpoint.sessionId}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ digest: sessionDigest(checkpoint), checkpoint }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(
        temporary,
        path.join(directory, `${checkpoint.sessionId}.json`),
      );
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
export class SessionBindingChanged extends Error {
  constructor() {
    super("Frozen session binding changed; create a new Run");
  }
}
export class SessionQuestion extends Error {
  constructor(readonly taskId: string) {
    super("Saved Skill work requires a human answer");
  }
}
/** A candidate failed before any immutable static submission reservation. */
export class SessionCandidateRejected extends Error {
  constructor(readonly reason: "preparation" | "static-validation") {
    super("Generated candidate rejected before static reservation");
  }
}
export interface SessionLimits {
  maxGenerations: number;
  timeoutMs: number;
  maxOutputBytes: number;
}
/** Uses fresh official sessions, including after resume. It preserves Mimic
 * context/accepted work, not the native provider's conversation history. */
export class AgentSession {
  private cancelled = false;
  private cancelExecution?: () => Promise<void>;
  private startupAbort?: AbortController;
  constructor(
    readonly id: string,
    private readonly store: FileSessionStore,
    private readonly ports: SessionPorts,
    private readonly executor: AgentExecutor,
    private readonly limits: SessionLimits,
    private readonly authorizedDispatch?: AuthorizedSessionDispatch,
  ) {
    if (
      !identifier.test(id) ||
      !Number.isSafeInteger(limits.maxGenerations) ||
      limits.maxGenerations < 1 ||
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs < 1 ||
      !Number.isSafeInteger(limits.maxOutputBytes) ||
      limits.maxOutputBytes < 1 ||
      (authorizedDispatch &&
        (!isAuthorizedSessionDispatch(authorizedDispatch, executor) ||
          limits.maxGenerations !== 1))
    )
      throw new Error("Invalid session limits");
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.startupAbort?.abort();
    if (this.cancelExecution) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.cancelExecution(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.limits.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }
  }
  async inspect() {
    const state = await this.store.read(this.id);
    return {
      readOnly: true,
      sessionId: this.id,
      status: state?.status ?? "not-started",
      stop: state?.stop,
      questionIds: state?.questionIds ?? [],
      executionPolicy: state?.executionPolicy,
      tasks: Object.values(state?.tasks ?? {}).map((task) => ({
        taskId: task.binding.taskId,
        phase: task.phase,
        rejectionReason: task.rejectionReason,
        inputRefs: task.binding.inputRefs,
        outputRefs: task.outputRefs,
        work: task.work,
        diagnostics: sanitizeExecutionDiagnostics(task.diagnostics),
      })),
      next:
        state?.stop === "question"
          ? "Read saved questions; record the human answer in an explicit new Run if frozen inputs change."
          : state?.stop === "unknown-outcome" ||
              state?.stop === "timeout" ||
              state?.stop === "cancelled"
            ? "Reconcile the official process and exact saved work before explicit resume; a live lease prevents retry."
            : "Inspect Core actions, resolve the stop and explicitly resume only unfinished work.",
      core: await this.ports.inspect(),
    };
  }
  /** A stop remains stopped until an explicit resume. For an interrupted model
   * call, reconcile external effects before acknowledging a new generation. */
  async advance(
    options: {
      resume?: boolean;
      reconciledUnknownOutcome?: boolean;
      /** Trusted, model-free replay of exactly one authorized saved work. */
      reconcilePreparedWorkDigest?: string;
    } = {},
  ): Promise<SessionCheckpoint> {
    return this.store.exclusive(this.id, async () => {
      let state = await this.store.read(this.id);
      if (options.reconcilePreparedWorkDigest !== undefined && !state)
        throw new Error("No saved authorized session to reconcile");
      let binding: SessionBinding;
      try {
        binding = validateBinding(await this.ports.binding());
      } catch (error) {
        if (!state) throw error;
        state.status = "stopped";
        state.stop = "reservation-invalid";
        await this.store.write(state);
        return state;
      }
      if (!state) {
        state = {
          version: 1,
          sessionId: this.id,
          binding,
          generationCount: 0,
          tasks: {},
          status: "ready",
          questionIds: [],
          ...(this.authorizedDispatch
            ? { executionPolicy: this.authorizedDispatch.policy }
            : {}),
        };
        await this.store.write(state);
      }
      let diagnosticTask: TaskCheckpoint | undefined;
      let readDiagnostics: (() => unknown) | undefined;
      const captureDiagnostics = () => {
        try {
          const diagnostic = sanitizeExecutionDiagnostics(readDiagnostics?.());
          if (diagnosticTask && diagnostic)
            diagnosticTask.diagnostics = diagnostic;
        } catch {
          /* Untrusted adapter telemetry never changes stop semantics. */
        }
      };
      const stop = async (reason: SessionStop) => {
        captureDiagnostics();
        state!.status = "stopped";
        state!.stop = reason;
        await this.store.write(state!);
        return state!;
      };
      const matchesBinding = async () => {
        try {
          return (
            sessionDigest(validateBinding(await this.ports.binding())) ===
            sessionDigest(state!.binding)
          );
        } catch {
          return false;
        }
      };
      if (sessionDigest(binding) !== sessionDigest(state.binding))
        return stop("reservation-invalid");
      if (state.executionPolicy !== this.authorizedDispatch?.policy)
        // A caller without the original execution policy must not poison a
        // checkpoint that a trusted, model-free reconciliation can still use.
        return { ...state, status: "stopped", stop: "reservation-invalid" };

      if (options.reconcilePreparedWorkDigest !== undefined) {
        const tasks = Object.values(state.tasks);
        if (
          !options.resume ||
          options.reconciledUnknownOutcome ||
          !this.authorizedDispatch ||
          this.limits.maxGenerations !== 1 ||
          !(
            (state.status === "stopped" &&
              ["unknown-outcome", "reservation-invalid"].includes(
                state.stop ?? "",
              )) ||
            (state.status === "ready" && state.stop === undefined)
          ) ||
          state.generationCount !== 1 ||
          tasks.length !== 1 ||
          tasks[0].phase !== "prepared" ||
          tasks[0].work?.digest !== options.reconcilePreparedWorkDigest
        )
          throw new Error("Saved authorized work does not match");
      }

      if (state.status === "stopped" && !options.resume) return state;
      if (
        state.stop === "reservation-invalid" &&
        options.reconcilePreparedWorkDigest === undefined
      )
        return state;
      this.cancelled = false;
      // Reconcile exact persisted work before any new model invocation. If Core
      // accepted before a crash, static submit replays only its sealed handoff.
      for (const task of Object.values(state.tasks)) {
        try {
          if (task.phase === "accepted")
            await this.ports.verifyAccepted(task.binding, task.outputRefs!);
          else if (task.phase === "rejected") continue;
          else if (task.phase === "prepared" || task.phase === "blocked") {
            task.outputRefs = await this.ports.submit(task.binding, task.work!);
            task.phase = "accepted";
            await this.store.write(state);
          } else if (
            !options.resume ||
            (![
              "quota",
              "authentication",
              "billing-unconfirmed",
              "unsupported",
            ].includes(state.stop ?? "") &&
              !options.reconciledUnknownOutcome)
          )
            return stop("unknown-outcome");
        } catch (error) {
          if (error instanceof SessionBindingChanged)
            return stop("reservation-invalid");
          if (error instanceof SessionQuestion) {
            task.phase = "blocked";
            state.questionIds = [error.taskId];
            return stop("question");
          }
          if (error instanceof SessionCandidateRejected) {
            task.phase = "rejected";
            task.rejectionReason = error.reason;
            return stop("candidate-rejected");
          }
          return stop("unknown-outcome");
        }
      }
      if (state.status === "complete") return state;
      state.status = "ready";
      delete state.stop;
      await this.store.write(state);
      while (true) {
        if (this.cancelled) return stop("cancelled");
        if (!(await matchesBinding())) return stop("reservation-invalid");
        const plan = await this.ports.next();
        state.questionIds = [...plan.questionIds];
        for (const candidate of plan.runnable) {
          const previous = Object.hasOwn(state.tasks, candidate.binding.taskId)
            ? state.tasks[candidate.binding.taskId]
            : undefined;
          if (
            previous &&
            sessionDigest(previous.binding) !== sessionDigest(candidate.binding)
          )
            return stop("reservation-invalid");
        }
        const task = plan.runnable.find(
          (candidate) =>
            !Object.hasOwn(state!.tasks, candidate.binding.taskId) ||
            state!.tasks[candidate.binding.taskId]?.phase !== "accepted",
        );
        if (!task) {
          if (plan.questionIds.length) return stop("question");
          if (plan.reviewReady) return stop("approval");
          if (!plan.complete) return stop("waiting");
          state.status = "complete";
          delete state.stop;
          await this.store.write(state);
          return state;
        }
        validateTask(task.binding);
        const prior = Object.hasOwn(state.tasks, task.binding.taskId)
          ? state.tasks[task.binding.taskId]
          : undefined;
        if (
          prior &&
          sessionDigest(prior.binding) !== sessionDigest(task.binding)
        )
          return stop("reservation-invalid");
        if (state.generationCount >= this.limits.maxGenerations)
          return stop("iteration-limit");
        state.tasks[task.binding.taskId] = {
          binding: structuredClone(task.binding),
          phase: "executing",
          diagnostics: {
            version: 1,
            stage: "dispatch",
            backendReach: "unknown",
          },
        };
        diagnosticTask = state.tasks[task.binding.taskId];
        readDiagnostics = undefined;
        state.generationCount++;
        await this.store.write(state);
        if (this.cancelled) return stop("cancelled");
        const deadline = Date.now() + this.limits.timeoutMs;
        const startupAbort = new AbortController();
        this.startupAbort = startupAbort;
        const request: ExecutionRequest = {
          requestId: `${this.id}-${state.generationCount}`,
          workspace: this.ports.workspace,
          prompt: task.prompt,
          settings: state.binding.settings,
          requiredCapabilities: ["toolRestriction"],
        };
        const starting = this.authorizedDispatch
          ? this.authorizedDispatch.start(request, startupAbort.signal)
          : startExecution(this.executor, request);
        readDiagnostics = () => this.authorizedDispatch?.diagnostics?.();
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        const handle = await Promise.race([
          starting,
          new Promise<undefined>((resolve) => {
            startTimer = setTimeout(
              () => resolve(undefined),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]).finally(() => clearTimeout(startTimer));
        if (!handle) {
          startupAbort.abort();
          this.startupAbort = undefined;
          void starting.then((late) => late.cancel()).catch(() => {});
          this.store.retainLock(this.id);
          return stop("timeout");
        }
        this.cancelExecution = handle.cancel;
        readDiagnostics = () => handle.diagnostics?.();
        this.startupAbort = undefined;
        const iterator = handle.events[Symbol.asyncIterator]();
        let output: string | undefined;
        let backendStop: StopReason | undefined;
        let byteCount = 0;
        let pending:
          | Promise<IteratorResult<import("./executor.js").ExecutorEvent>>
          | undefined;
        const settleCancellation = async () => {
          const settlement = (async () => {
            await handle.cancel();
            let proven = false;
            for (let remaining = 0; remaining < 100; remaining++) {
              const next = await (pending ?? iterator.next());
              pending = undefined;
              if (next.done) return proven;
              if (next.value.type === "stopped")
                proven = next.value.reason === "cancelled";
            }
            return false;
          })().catch(() => false);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const proven = await Promise.race([
            settlement,
            new Promise<false>((resolve) => {
              timer = setTimeout(
                () => resolve(false),
                Math.min(1000, this.limits.timeoutMs),
              );
            }),
          ]).finally(() => clearTimeout(timer));
          if (!proven) this.store.retainLock(this.id);
        };
        if (this.cancelled) {
          await settleCancellation();
          return stop("cancelled");
        }
        try {
          while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([
              (pending = iterator.next()),
              new Promise<undefined>((resolve) => {
                timer = setTimeout(
                  () => resolve(undefined),
                  Math.max(0, deadline - Date.now()),
                );
              }),
            ]).finally(() => clearTimeout(timer));
            if (!next) {
              await settleCancellation();
              backendStop = "timeout";
              break;
            }
            pending = undefined;
            if (next.done) break;
            const event = next.value;
            if (event.type === "output")
              byteCount += Buffer.byteLength(event.text);
            if (event.type === "completed") {
              output = event.output;
              byteCount = Math.max(byteCount, Buffer.byteLength(output));
            }
            if (byteCount > this.limits.maxOutputBytes) {
              await settleCancellation();
              backendStop = "unknown-outcome";
              break;
            }
            if (event.type === "stopped") backendStop = event.reason;
          }
        } catch {
          backendStop = "unknown-outcome";
        } finally {
          this.cancelExecution = undefined;
          captureDiagnostics();
        }
        if (backendStop || output === undefined || this.cancelled)
          return stop(
            this.cancelled ? "cancelled" : (backendStop ?? "unknown-outcome"),
          );
        if (!(await matchesBinding())) return stop("reservation-invalid");
        try {
          const record = state.tasks[task.binding.taskId]!;
          record.work = await this.ports.saveWork(task.binding, output);
          record.phase = "prepared";
          await this.store.write(state);
          record.outputRefs = await this.ports.submit(
            task.binding,
            record.work,
          );
          record.phase = "accepted";
          await this.store.write(state);
        } catch (error) {
          if (error instanceof SessionBindingChanged)
            return stop("reservation-invalid");
          if (error instanceof SessionQuestion) {
            state.tasks[task.binding.taskId]!.phase = "blocked";
            state.questionIds = [error.taskId];
            return stop("question");
          }
          if (error instanceof SessionCandidateRejected) {
            state.tasks[task.binding.taskId]!.phase = "rejected";
            state.tasks[task.binding.taskId]!.rejectionReason = error.reason;
            return stop("candidate-rejected");
          }
          return stop("unknown-outcome");
        }
      }
    });
  }
}
