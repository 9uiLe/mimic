import {
  CodexExecutor,
  createCodexCreditRiskPermit,
  type CodexOptions,
  type CodexCreditRiskDecisionPort,
} from "./codex.js";
import {
  containExecution,
  ExecutorFailure,
  type AgentExecutor,
  type ExecutionHandle,
  type ExecutionRequest,
} from "./executor.js";

/** A trusted host's explicit one-call credit-risk authorization, separate from
 * confirmed subscription-only entitlement. It is never decoded from JSON. */
export interface AuthorizedSessionDispatch {
  readonly policy: "authorized-existing-credit-risk-once";
  diagnostics?(): unknown;
  start(
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionHandle>;
}
const executors = new WeakMap<AuthorizedSessionDispatch, AgentExecutor>();
export function isAuthorizedSessionDispatch(
  dispatch: AuthorizedSessionDispatch,
  executor: AgentExecutor,
): boolean {
  return executors.get(dispatch) === executor;
}

/** The decision port must atomically consume an actual user decision in trusted
 * host storage. A model/config cannot supply it. Creating this adapter does not
 * issue a permit, inspect credentials, or invoke the official CLI. */
export function createAuthorizedCodexSessionDispatch(
  options: CodexOptions,
  outputSchemaPath: string,
  decision: CodexCreditRiskDecisionPort,
): { executor: CodexExecutor; dispatch: AuthorizedSessionDispatch } {
  const frozen = { ...options, env: { ...options.env } };
  const executor = new CodexExecutor(frozen);
  let attempted = false;
  const dispatch: AuthorizedSessionDispatch = Object.freeze({
    policy: "authorized-existing-credit-risk-once" as const,
    diagnostics: () =>
      executor.diagnostics() ??
      (attempted
        ? { version: 1, stage: "authorization", backendReach: "unknown" }
        : undefined),
    start: (request: ExecutionRequest, signal?: AbortSignal) =>
      containExecution(request, async () => {
        if (attempted) throw new ExecutorFailure("billing-unconfirmed");
        attempted = true;
        if (signal?.aborted) throw new ExecutorFailure("cancelled");
        let permit;
        try {
          permit = await createCodexCreditRiskPermit(decision, request, signal);
        } catch (error) {
          throw new ExecutorFailure(
            error instanceof ExecutorFailure ? error.reason : "unknown-outcome",
            {
              version: 1,
              stage: "authorization",
              backendReach: "unknown",
            },
          );
        }
        return executor.startAuthorizedOnce(
          request,
          outputSchemaPath,
          permit,
          signal,
        );
      }),
  });
  executors.set(dispatch, executor);
  return { executor, dispatch };
}
