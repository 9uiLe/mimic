import {
  ExecutorFailure,
  stopEvent,
  type AgentExecutor,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutorDescription,
  type ExecutorEvent,
  type ResumeRequest,
  type StopReason,
} from "./executor.js";
import { executeOfficialProcess } from "./process.js";
import { parseSubscriptionSettings } from "./settings.js";

export interface CodexOptions {
  /** Absolute path to the unmodified official CLI. No executable discovery. */
  executable: string;
  /** Existing native-login environment; API credentials/endpoint overrides fail. */
  env: Readonly<Record<string, string>>;
  workspace: string;
  timeoutMs?: number;
}
export interface CodexInspection {
  runtimeVersion: string;
  authentication: "chatgpt" | "api-key" | "missing" | "unknown";
  billingEnforcement: "unconfirmed";
  modelEntitlement: "unconfirmed";
}

/** Only read-only official commands; never opens auth files or refreshes/login. */
export async function inspectCodex(
  options: CodexOptions,
): Promise<CodexInspection> {
  const run = async (args: string[]) =>
    (
      await executeOfficialProcess({
        executable: options.executable,
        args,
        workspace: options.workspace,
        env: options.env,
        timeoutMs: options.timeoutMs ?? 10_000,
        maxOutputBytes: 64 * 1024,
      })
    ).result;
  const version = await run(["--version"]);
  const match =
    version.exitCode === 0 &&
    /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(version.stdout);
  const login = await run(["login", "status"]);
  // Current official CLI prints login status to stderr. Accept stdout as well,
  // but expose neither raw stream nor account/credential strings.
  const status = `${login.stdout}\n${login.stderr}`;
  const authentication =
    login.exitCode === 0 &&
    /(?:^|\n)Logged in using ChatGPT\s*(?:\n|$)/.test(status)
      ? "chatgpt"
      : login.exitCode === 0 &&
          /(?:^|\n)Logged in using an API key(?:\s|$)/.test(status)
        ? "api-key"
        : /(?:^|\n)Not logged in\s*(?:\n|$)/.test(status)
          ? "missing"
          : "unknown";
  return {
    runtimeVersion: match ? match[1] : "unknown",
    authentication,
    billingEnforcement: "unconfirmed",
    modelEntitlement: "unconfirmed",
  };
}

/** First official adapter boundary. ChatGPT login alone does not verify the
 * account overage/credit settings or prevent API fallback in a generation profile.
 * Existing credits are not authorized for consumption. Official account settings
 * must be verified before dispatch; no caller attestation or quota snapshot alone
 * can unlock execution in this implementation.
 */
export class CodexExecutor implements AgentExecutor {
  private readonly options: CodexOptions;
  constructor(options: CodexOptions) {
    this.options = { ...options, env: { ...options.env } };
  }
  async describe(): Promise<ExecutorDescription> {
    const inspection = await inspectCodex(this.options);
    const known = inspection.runtimeVersion === "0.160.0";
    return {
      provider: "codex",
      runtimeVersion: inspection.runtimeVersion,
      capabilities: {
        subscription: known,
        streaming: known,
        cancellation: true,
        // Ephemeral exec has no persisted native session. Mimic checkpoints are
        // distinct and will be managed by the outer loop, not by a fresh turn.
        nativeResume: false,
        structuredOutput: known,
        // Flags reduce exposure but have not certified a model-only toolset.
        toolRestriction: false,
      },
      entitlement: !known
        ? { status: "unsupported" }
        : {
            status: "unconfirmed",
            reason:
              inspection.authentication === "chatgpt"
                ? "billing"
                : "authentication",
          },
    };
  }
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    let settings;
    try {
      settings = parseSubscriptionSettings(request.settings);
    } catch {
      throw new ExecutorFailure("unsupported");
    }
    if (settings.provider !== "codex") throw new ExecutorFailure("unsupported");
    const description = await this.describe();
    if (description.entitlement.status === "unsupported")
      throw new ExecutorFailure("unsupported");
    if (description.entitlement.status === "unconfirmed") {
      throw new ExecutorFailure(
        description.entitlement.reason === "billing"
          ? "billing-unconfirmed"
          : "authentication",
      );
    }
    // Stop until a trusted official account-setting/control path verifies
    // additional-credit/overage disabled, or no credits plus auto-refill off,
    // together with a ChatGPT-only, tool-restricted generation profile.
    // Do not turn an arbitrary confirmed object into a dispatch override.
    throw new ExecutorFailure("billing-unconfirmed");
  }
  async resume(request: ResumeRequest): Promise<ExecutionHandle> {
    void request;
    // No implicit new turn/replay of accepted work as a substitute for resume.
    throw new ExecutorFailure("unsupported");
  }
}

/** Classify official error text internally; raw messages never reach diagnostics. */
export function classifyCodexError(message: string): StopReason {
  if (
    /quota|usage limit|rate limit|credits? (?:exhausted|depleted)|insufficient_quota/i.test(
      message,
    )
  )
    return "quota";
  if (
    /unauthori[sz]ed|authentication|token (?:expired|invalid)|not logged in|401\b/i.test(
      message,
    )
  )
    return "authentication";
  return "unknown-outcome";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ExecutorFailure("unknown-outcome");
  return value as Record<string, unknown>;
}

/** Check only the submit envelope shape. Core's static submit path remains the
 * authority for artifact schemas, digests, origins, exact locks and acceptance.
 */
export function parseCodexWorkEnvelope(text: string): Record<string, unknown> {
  let envelope: Record<string, unknown>;
  try {
    envelope = object(JSON.parse(text));
  } catch {
    throw new ExecutorFailure("unknown-outcome");
  }
  if (
    Object.keys(envelope).some((key) => !["artifacts", "work"].includes(key)) ||
    !Array.isArray(envelope.artifacts)
  )
    throw new ExecutorFailure("unknown-outcome");
  for (const artifact of envelope.artifacts) object(artifact);
  object(object(envelope.work).result);
  return envelope;
}

/** Bounded, incremental official exec JSONL decoder. It does not launch a model
 * or grant tools. Its output is candidate data and never approval authority.
 */
export class CodexJsonlDecoder {
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private bytes = 0;
  private threadId: string | undefined;
  private turn = false;
  private terminal: ExecutorEvent | undefined;
  private finalText: string | undefined;
  private readonly items = new Map<
    string,
    { type: string; completed: boolean }
  >();
  private failed = false;
  private finished = false;
  constructor(
    private readonly requestId: string,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {
    if (
      !requestId.trim() ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 16 * 1024 * 1024
    )
      throw new ExecutorFailure("unsupported");
  }
  push(chunk: Buffer): ExecutorEvent[] {
    if (this.failed || this.finished)
      throw new ExecutorFailure("unknown-outcome");
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.failed = true;
      throw new ExecutorFailure("unknown-outcome");
    }
    try {
      return this.consume(this.utf8.decode(chunk, { stream: true }));
    } catch {
      this.failed = true;
      throw new ExecutorFailure("unknown-outcome");
    }
  }
  private consume(text: string): ExecutorEvent[] {
    this.pending += text;
    const events: ExecutorEvent[] = [];
    let newline: number;
    try {
      while ((newline = this.pending.indexOf("\n")) !== -1) {
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        if (line.trim()) events.push(...this.line(line));
      }
    } catch {
      this.failed = true;
      throw new ExecutorFailure("unknown-outcome");
    }
    return events;
  }
  private line(line: string): ExecutorEvent[] {
    const event = object(JSON.parse(line));
    if (this.terminal) throw new ExecutorFailure("unknown-outcome");
    if (event.type === "thread.started") {
      if (
        this.threadId ||
        typeof event.thread_id !== "string" ||
        !event.thread_id.trim()
      )
        throw new ExecutorFailure("unknown-outcome");
      this.threadId = event.thread_id;
      return [{ type: "started", requestId: this.requestId }];
    }
    if (event.type === "error" || event.type === "turn.failed") {
      const error = event.type === "error" ? event : object(event.error);
      if (typeof error.message !== "string")
        throw new ExecutorFailure("unknown-outcome");
      this.terminal = stopEvent(classifyCodexError(error.message));
      return this.threadId
        ? []
        : [{ type: "started", requestId: this.requestId }];
    }
    if (!this.threadId) throw new ExecutorFailure("unknown-outcome");
    if (event.type === "turn.started") {
      if (this.turn) throw new ExecutorFailure("unknown-outcome");
      this.turn = true;
      return [];
    }
    if (!this.turn) throw new ExecutorFailure("unknown-outcome");
    if (
      ["item.started", "item.updated", "item.completed"].includes(
        String(event.type),
      )
    ) {
      const item = object(event.item);
      if (
        typeof item.id !== "string" ||
        !item.id ||
        !["reasoning", "agent_message"].includes(String(item.type)) ||
        typeof item.text !== "string"
      )
        throw new ExecutorFailure("unknown-outcome");
      const previous = this.items.get(item.id);
      if (
        previous?.completed ||
        (previous && previous.type !== item.type) ||
        (previous && event.type === "item.started") ||
        (!previous && event.type === "item.updated")
      )
        throw new ExecutorFailure("unknown-outcome");
      this.items.set(item.id, {
        type: String(item.type),
        completed: event.type === "item.completed",
      });
      // Never expose reasoning as operational logs, nor dispatch tool items.
      if (item.type === "agent_message" && event.type === "item.completed") {
        if (this.finalText !== undefined)
          throw new ExecutorFailure("unknown-outcome");
        this.finalText = item.text;
        return [{ type: "output", text: item.text }];
      }
      return [];
    }
    if (event.type === "turn.completed" && this.finalText !== undefined) {
      if ([...this.items.values()].some((item) => !item.completed))
        throw new ExecutorFailure("unknown-outcome");
      parseCodexWorkEnvelope(this.finalText);
      const usage = object(event.usage);
      for (const key of [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "cache_write_input_tokens",
      ]) {
        const value = usage[key];
        if (key === "cache_write_input_tokens" && value === undefined) continue;
        if (!Number.isSafeInteger(value) || Number(value) < 0)
          throw new ExecutorFailure("unknown-outcome");
      }
      this.terminal = { type: "completed", output: this.finalText };
      return [];
    }
    throw new ExecutorFailure("unknown-outcome");
  }
  /** Terminal withheld until clean process exit/EOF; malformed trailing output,
   * nonzero exit, cancellation or timeout cannot publish a completed candidate.
   */
  finish(exitCode: number): ExecutorEvent[] {
    if (this.failed || this.finished) return [stopEvent("unknown-outcome")];
    this.finished = true;
    try {
      const events = this.consume(this.utf8.decode());
      if (this.pending.trim()) {
        events.push(...this.line(this.pending));
        this.pending = "";
      }
      if (!this.terminal) return [...events, stopEvent("unknown-outcome")];
      if (exitCode !== 0 && this.terminal.type === "completed")
        return [...events, stopEvent("unknown-outcome")];
      return [...events, this.terminal];
    } catch {
      this.failed = true;
      return [stopEvent("unknown-outcome")];
    }
  }
}
