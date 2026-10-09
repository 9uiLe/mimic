import {
  parseSubscriptionSettings,
  type SubscriptionSettings,
  type ProviderId,
} from "./settings.js";

export interface ExecutorCapabilities {
  subscription: boolean;
  streaming: boolean;
  cancellation: boolean;
  nativeResume: boolean;
  structuredOutput: boolean;
  toolRestriction: boolean;
}
export type AccountEntitlement =
  | {
      status: "confirmed";
      billingMode: "subscription-only";
      /** Positive official-runtime proof that credits/paid fallback cannot be used.
       * Login alone or user intent is not billing enforcement. */
      billingEvidence: { enforcement: "official-runtime"; reference: string };
      models: readonly string[];
    }
  | { status: "unconfirmed"; reason?: "authentication" | "billing" }
  | { status: "unsupported" };
export interface ExecutorDescription {
  provider: ProviderId;
  runtimeVersion: string;
  capabilities: ExecutorCapabilities;
  entitlement: AccountEntitlement;
}
export interface ExecutionRequest {
  requestId: string;
  workspace: string;
  prompt: string;
  settings: SubscriptionSettings;
  requiredCapabilities?: readonly ("structuredOutput" | "toolRestriction")[];
}
export interface ResumeRequest extends ExecutionRequest {
  /** Opaque official-runtime session ID; never an authentication credential. */
  sessionId: string;
}
export type StopReason =
  | "quota"
  | "authentication"
  | "billing-unconfirmed"
  | "unsupported"
  | "cancelled"
  | "timeout"
  | "unknown-outcome";
export type ResumeCondition =
  | "explicit-backend-switch-or-quota-restored"
  | "official-login"
  | "verify-subscription-only"
  | "supported-backend"
  | "explicit-resume"
  | "reconcile-before-retry";
export type ExecutorEvent =
  | { type: "started"; requestId: string }
  | { type: "output"; text: string }
  | { type: "completed"; output: string; sessionId?: string }
  | { type: "stopped"; reason: StopReason; resumeCondition: ResumeCondition };
export interface ExecutionHandle {
  events: AsyncIterable<ExecutorEvent>;
  cancel(): Promise<void>;
  /** Untrusted adapter telemetry; consumers must sanitize it before persistence. */
  diagnostics?(): unknown;
}
export interface ProcessDiagnostics {
  spawned: boolean;
  settled: boolean;
  exitCode: number | null;
  signal:
    | "SIGTERM"
    | "SIGKILL"
    | "SIGINT"
    | "SIGABRT"
    | "SIGSEGV"
    | "SIGPIPE"
    | "other"
    | null;
  stdoutBytes: number;
  stderrBytes: number;
  errorCode: "none" | "ENOENT" | "EACCES" | "EPIPE" | "other";
  failure:
    | "none"
    | "spawn-error"
    | "stdin-error"
    | "output-limit"
    | "stdout-callback"
    | "timeout"
    | "cancelled"
    | "nonzero-exit"
    | "signal";
}
/** Only fixed protocol names and key presence survive a rejected native line. */
export interface RejectedProtocolShape {
  eventType:
    | "thread.started"
    | "turn.started"
    | "item.started"
    | "item.updated"
    | "item.completed"
    | "turn.completed"
    | "turn.failed"
    | "error"
    | "other";
  itemType: "none" | "reasoning" | "agent_message" | "error" | "other";
  hasItem: boolean;
  hasId: boolean;
  hasType: boolean;
  hasText: boolean;
  hasMessage: boolean;
  eventUnknownKeys: number;
  itemUnknownKeys: number;
}
export interface ExecutionDiagnostics {
  version: 1;
  stage:
    | "dispatch"
    | "authorization"
    | "permit-validation"
    | "runtime-metadata"
    | "generation-profile"
    | "safety-metadata"
    | "native-instructions"
    | "generation-launch"
    | "generation";
  /** Local protocol observations never establish backend contact or call count. */
  backendReach: "unknown";
  processKind?: "metadata" | "generation";
  process?: ProcessDiagnostics;
  decoder?: {
    threadStarted: boolean;
    turnStarted: boolean;
    outputObserved: boolean;
    terminalObserved: boolean;
    finished: boolean;
    failed: boolean;
    failure:
      | "none"
      | "utf8"
      | "json"
      | "protocol"
      | "output-limit"
      | "missing-terminal"
      | "invalid-output"
      | "nonzero-exit"
      | "policy-stop";
    rejectedShape?: RejectedProtocolShape;
  };
}
function closed(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Invalid diagnostic");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    Object.values(descriptors).some((item) => item.get || item.set)
  )
    throw new Error("Invalid diagnostic");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}
/** Reject unknown keys/getters/strings rather than spreading adapter metadata.
 * These observations cannot change execution, billing or authority policy. */
export function sanitizeExecutionDiagnostics(
  value: unknown,
): ExecutionDiagnostics | undefined {
  try {
    const d = closed(value, [
      "version",
      "stage",
      "backendReach",
      "processKind",
      "process",
      "decoder",
    ]);
    if (
      d.version !== 1 ||
      d.backendReach !== "unknown" ||
      typeof d.stage !== "string" ||
      ![
        "dispatch",
        "authorization",
        "permit-validation",
        "runtime-metadata",
        "generation-profile",
        "safety-metadata",
        "native-instructions",
        "generation-launch",
        "generation",
      ].includes(d.stage) ||
      (d.processKind !== undefined &&
        d.processKind !== "metadata" &&
        d.processKind !== "generation")
    )
      return undefined;
    const result: ExecutionDiagnostics = {
      version: 1,
      stage: d.stage as ExecutionDiagnostics["stage"],
      backendReach: "unknown",
    };
    if (d.processKind !== undefined) result.processKind = d.processKind;
    if (d.process !== undefined) {
      const p = closed(d.process, [
        "spawned",
        "settled",
        "exitCode",
        "signal",
        "stdoutBytes",
        "stderrBytes",
        "errorCode",
        "failure",
      ]);
      if (
        typeof p.spawned !== "boolean" ||
        typeof p.settled !== "boolean" ||
        !(
          p.exitCode === null ||
          (Number.isSafeInteger(p.exitCode) &&
            Number(p.exitCode) >= 0 &&
            Number(p.exitCode) <= 2147483647)
        ) ||
        !(
          p.signal === null ||
          (typeof p.signal === "string" &&
            [
              "SIGTERM",
              "SIGKILL",
              "SIGINT",
              "SIGABRT",
              "SIGSEGV",
              "SIGPIPE",
              "other",
            ].includes(p.signal))
        ) ||
        [p.stdoutBytes, p.stderrBytes].some(
          (n) =>
            !Number.isSafeInteger(n) ||
            Number(n) < 0 ||
            Number(n) > 16 * 1024 * 1024,
        ) ||
        typeof p.errorCode !== "string" ||
        !["none", "ENOENT", "EACCES", "EPIPE", "other"].includes(p.errorCode) ||
        typeof p.failure !== "string" ||
        ![
          "none",
          "spawn-error",
          "stdin-error",
          "output-limit",
          "stdout-callback",
          "timeout",
          "cancelled",
          "nonzero-exit",
          "signal",
        ].includes(p.failure)
      )
        return undefined;
      result.process = {
        spawned: p.spawned,
        settled: p.settled,
        exitCode: p.exitCode as number | null,
        signal: p.signal as ProcessDiagnostics["signal"],
        stdoutBytes: p.stdoutBytes as number,
        stderrBytes: p.stderrBytes as number,
        errorCode: p.errorCode as ProcessDiagnostics["errorCode"],
        failure: p.failure as ProcessDiagnostics["failure"],
      };
    }
    if (d.decoder !== undefined) {
      const keys = [
        "threadStarted",
        "turnStarted",
        "outputObserved",
        "terminalObserved",
        "finished",
        "failed",
      ] as const;
      const decoder = closed(d.decoder, [...keys, "failure", "rejectedShape"]);
      if (keys.some((key) => typeof decoder[key] !== "boolean"))
        return undefined;
      if (
        typeof decoder.failure !== "string" ||
        ![
          "none",
          "utf8",
          "json",
          "protocol",
          "output-limit",
          "missing-terminal",
          "invalid-output",
          "nonzero-exit",
          "policy-stop",
        ].includes(decoder.failure)
      )
        return undefined;
      result.decoder = {
        ...Object.fromEntries(keys.map((key) => [key, decoder[key]])),
        failure: decoder.failure,
      } as ExecutionDiagnostics["decoder"];
      if (decoder.rejectedShape !== undefined) {
        const flags = [
          "hasItem",
          "hasId",
          "hasType",
          "hasText",
          "hasMessage",
        ] as const;
        const shape = closed(decoder.rejectedShape, [
          "eventType",
          "itemType",
          ...flags,
          "eventUnknownKeys",
          "itemUnknownKeys",
        ]);
        if (
          typeof shape.eventType !== "string" ||
          ![
            "thread.started",
            "turn.started",
            "item.started",
            "item.updated",
            "item.completed",
            "turn.completed",
            "turn.failed",
            "error",
            "other",
          ].includes(shape.eventType) ||
          typeof shape.itemType !== "string" ||
          !["none", "reasoning", "agent_message", "error", "other"].includes(
            shape.itemType,
          ) ||
          flags.some((key) => typeof shape[key] !== "boolean") ||
          [shape.eventUnknownKeys, shape.itemUnknownKeys].some(
            (value) =>
              !Number.isSafeInteger(value) ||
              Number(value) < 0 ||
              Number(value) > 255,
          )
        )
          return undefined;
        result.decoder!.rejectedShape = {
          eventType: shape.eventType as RejectedProtocolShape["eventType"],
          itemType: shape.itemType as RejectedProtocolShape["itemType"],
          hasItem: shape.hasItem as boolean,
          hasId: shape.hasId as boolean,
          hasType: shape.hasType as boolean,
          hasText: shape.hasText as boolean,
          hasMessage: shape.hasMessage as boolean,
          eventUnknownKeys: shape.eventUnknownKeys as number,
          itemUnknownKeys: shape.itemUnknownKeys as number,
        };
      }
    }
    return result;
  } catch {
    return undefined;
  }
}
/** Adapters use only their official runtime; no token extraction or paid fallback. */
export interface AgentExecutor {
  describe(): Promise<ExecutorDescription>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  resume(request: ResumeRequest): Promise<ExecutionHandle>;
}
export class ExecutorFailure extends Error {
  readonly diagnostics?: ExecutionDiagnostics;
  constructor(
    readonly reason: StopReason,
    diagnostics?: unknown,
  ) {
    super(reason);
    this.diagnostics = sanitizeExecutionDiagnostics(diagnostics);
  }
}
export function stopEvent(
  reason: StopReason,
): Extract<ExecutorEvent, { type: "stopped" }> {
  const conditions: Record<StopReason, ResumeCondition> = {
    quota: "explicit-backend-switch-or-quota-restored",
    authentication: "official-login",
    "billing-unconfirmed": "verify-subscription-only",
    unsupported: "supported-backend",
    cancelled: "reconcile-before-retry",
    timeout: "reconcile-before-retry",
    "unknown-outcome": "reconcile-before-retry",
  };
  if (!Object.hasOwn(conditions, reason)) reason = "unknown-outcome";
  return { type: "stopped", reason, resumeCondition: conditions[reason] };
}

/** Validate entitlement before dispatch and contain malformed/failed adapters.
 * Output events are model data, not diagnostics: callers must not log them as
 * operational events or interpret them as tool calls or approval authority.
 */
export async function startExecution(
  executor: AgentExecutor,
  request: ExecutionRequest | ResumeRequest,
): Promise<ExecutionHandle> {
  return containExecution(request, async () => {
    let settings: SubscriptionSettings;
    try {
      settings = parseSubscriptionSettings(request.settings);
    } catch {
      throw new ExecutorFailure("unsupported");
    }
    const description = await executor.describe();
    if (!request.requestId.trim() || !request.workspace || !request.prompt)
      throw new ExecutorFailure("unsupported");
    if (
      description.provider !== settings.provider ||
      !description.capabilities.subscription ||
      !description.capabilities.cancellation
    )
      throw new ExecutorFailure("unsupported");
    if (description.entitlement.status === "unconfirmed")
      throw new ExecutorFailure(
        description.entitlement.reason === "billing"
          ? "billing-unconfirmed"
          : "authentication",
      );
    if (
      description.entitlement.status !== "confirmed" ||
      description.entitlement.billingMode !== "subscription-only"
    )
      throw new ExecutorFailure("unsupported");
    if (
      description.entitlement.billingEvidence?.enforcement !==
        "official-runtime" ||
      !description.entitlement.billingEvidence.reference?.trim()
    )
      throw new ExecutorFailure("billing-unconfirmed");
    if (
      request.requiredCapabilities?.some(
        (capability) =>
          !["structuredOutput", "toolRestriction"].includes(capability) ||
          !description.capabilities[capability],
      )
    )
      throw new ExecutorFailure("unsupported");
    settings = {
      ...settings,
      model: settings.model ?? description.entitlement.models[0],
    };
    if (
      !settings.model ||
      !description.entitlement.models.includes(settings.model)
    )
      throw new ExecutorFailure("unsupported");
    if ("sessionId" in request) {
      if (!request.sessionId.trim() || !description.capabilities.nativeResume)
        throw new ExecutorFailure("unsupported");
      return executor.resume({ ...request, settings });
    }
    return executor.start({ ...request, settings });
  });
}

/** Shared lifecycle containment after a trusted dispatch boundary. This helper
 * does not establish entitlement or grant permission; callers must enforce
 * their explicit dispatch policy before returning an official handle. */
export async function containExecution(
  request: ExecutionRequest,
  dispatch: () => Promise<ExecutionHandle>,
): Promise<ExecutionHandle> {
  let handle: ExecutionHandle;
  try {
    handle = await dispatch();
  } catch (error) {
    const stopped = stopEvent(
      error instanceof ExecutorFailure ? error.reason : "unknown-outcome",
    );
    return {
      diagnostics: () => {
        try {
          return error instanceof ExecutorFailure
            ? sanitizeExecutionDiagnostics(error.diagnostics)
            : undefined;
        } catch {
          return undefined;
        }
      },
      events: (async function* () {
        yield stopped;
      })(),
      cancel: async () => {},
    };
  }
  let cancelRequested = false;
  let cancelFailed = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (cancellation) return cancellation;
    cancelRequested = true;
    cancellation = (async () => {
      try {
        await handle.cancel();
      } catch {
        cancelFailed = true;
      }
    })();
    return cancellation;
  };
  return {
    cancel,
    diagnostics: () => {
      try {
        return sanitizeExecutionDiagnostics(handle.diagnostics?.());
      } catch {
        return undefined;
      }
    },
    events: (async function* () {
      let started = false;
      let terminal: ExecutorEvent | undefined;
      let exhausted = false;
      try {
        for await (const event of handle.events) {
          if (
            terminal ||
            !event ||
            !["started", "output", "completed", "stopped"].includes(event.type)
          )
            throw new ExecutorFailure("unknown-outcome");
          if (
            (event.type === "output" && typeof event.text !== "string") ||
            (event.type === "completed" &&
              (typeof event.output !== "string" ||
                (event.sessionId !== undefined &&
                  typeof event.sessionId !== "string")))
          )
            throw new ExecutorFailure("unknown-outcome");
          if (event.type === "started") {
            if (started || event.requestId !== request.requestId)
              throw new ExecutorFailure("unknown-outcome");
            started = true;
          } else if (!started) throw new ExecutorFailure("unknown-outcome");
          if (event.type === "completed" || event.type === "stopped") {
            terminal =
              event.type === "stopped" ? stopEvent(event.reason) : event;
          } else {
            yield event;
          }
        }
        exhausted = true;
        if (cancellation) await cancellation;
        if (!terminal)
          throw new ExecutorFailure(
            cancelRequested && !cancelFailed ? "cancelled" : "unknown-outcome",
          );
        yield cancelFailed
          ? stopEvent("unknown-outcome")
          : cancelRequested && (!terminal || terminal.type === "completed")
            ? stopEvent("cancelled")
            : (terminal ?? stopEvent("unknown-outcome"));
      } catch (error) {
        try {
          await cancel();
        } catch {
          /* adapter diagnostics are never exposed */
        }
        yield stopEvent(
          error instanceof ExecutorFailure ? error.reason : "unknown-outcome",
        );
      } finally {
        if (!exhausted) await cancel();
      }
    })(),
  };
}
