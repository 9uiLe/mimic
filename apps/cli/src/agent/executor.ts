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
}
/** Adapters use only their official runtime; no token extraction or paid fallback. */
export interface AgentExecutor {
  describe(): Promise<ExecutorDescription>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  resume(request: ResumeRequest): Promise<ExecutionHandle>;
}
export class ExecutorFailure extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
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
  let handle: ExecutionHandle;
  try {
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
      handle = await executor.resume({ ...request, settings });
    } else handle = await executor.start({ ...request, settings });
  } catch (error) {
    const stopped = stopEvent(
      error instanceof ExecutorFailure ? error.reason : "unknown-outcome",
    );
    return {
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
