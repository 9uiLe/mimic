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
  type ExecutionDiagnostics,
  type RejectedProtocolShape,
  sanitizeExecutionDiagnostics,
} from "./executor.js";
import {
  executeOfficialProcess,
  validateOfficialEnvironment,
  type OfficialProcessRequest,
  type OfficialProcessHandle,
} from "./process.js";
import { lstat, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseSubscriptionSettings } from "./settings.js";

export interface CodexOptions {
  /** Absolute path to the unmodified official CLI. No executable discovery. */
  executable: string;
  /** Existing native-login environment; API credentials/endpoint overrides fail. */
  env: Readonly<Record<string, string>>;
  workspace: string;
  timeoutMs?: number;
  /** Bounded generation effort; does not change tool or account permissions. */
  reasoningEffort?: "low" | "medium";
}
/** Generation only; metadata probes keep their separate ten-second bound. */
export const MAX_CODEX_GENERATION_TIMEOUT_MS = 600_000;
/** Bounded frozen Skill context, including exact upstream artifacts and sources. */
export const MAX_CODEX_PROMPT_BYTES = 96 * 1024;
export interface CodexInspection {
  runtimeVersion: string;
  authentication: "chatgpt" | "api-key" | "missing" | "unknown";
  billingEnforcement: "unconfirmed";
  modelEntitlement: "unconfirmed";
}

/** Only read-only official commands; never opens auth files or refreshes/login. */
export async function inspectCodex(
  options: CodexOptions,
  signal?: AbortSignal,
  observe?: (diagnostic: ExecutionDiagnostics) => void,
): Promise<CodexInspection> {
  const run = async (args: string[]) => {
    const process = await executeOfficialProcess({
      executable: options.executable,
      args,
      workspace: options.workspace,
      env: options.env,
      timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000),
      maxOutputBytes: 64 * 1024,
      signal,
    });
    try {
      return await process.result;
    } finally {
      observe?.({
        version: 1,
        stage: "runtime-metadata",
        backendReach: "unknown",
        processKind: "metadata",
        process: process.diagnostics(),
      });
    }
  };
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

export interface CodexCreditRiskScope {
  requestId: string;
  model: string;
  workspace: string;
  promptSha256: string;
}
/** Trusted application/coordinator port, never model/config/work data. The host
 * consumes a recorded, actual user decision allowing existing-credit risk once.
 * This is permission, NOT evidence of subscription-only billing enforcement. */
export interface CodexCreditRiskDecisionPort {
  consumeUserDecision(
    scope: Readonly<CodexCreditRiskScope>,
    signal?: AbortSignal,
  ): Promise<{
    decisionId: string;
    expiresAt: number;
  }>;
}
declare const creditRiskPermitBrand: unique symbol;
export interface CodexCreditRiskPermit {
  readonly [creditRiskPermitBrand]: true;
}
const permits = new WeakMap<
  CodexCreditRiskPermit,
  {
    scope: CodexCreditRiskScope;
    expiresAt: number;
    consumed: boolean;
  }
>();
const decisions = new WeakMap<CodexCreditRiskDecisionPort, Set<string>>();
function snapshotCodexRequest(request: ExecutionRequest): ExecutionRequest {
  let settings;
  try {
    settings = parseSubscriptionSettings(request.settings);
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  return {
    requestId: request.requestId,
    workspace: request.workspace,
    prompt: request.prompt,
    settings: { ...settings },
    requiredCapabilities: request.requiredCapabilities
      ? [...request.requiredCapabilities]
      : undefined,
  };
}
async function creditRiskScope(
  request: ExecutionRequest,
): Promise<CodexCreditRiskScope> {
  let settings;
  try {
    settings = parseSubscriptionSettings(request.settings);
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  if (
    settings.provider !== "codex" ||
    !settings.model ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(settings.model) ||
    !request.requestId.trim() ||
    !request.prompt ||
    Buffer.byteLength(request.prompt) > MAX_CODEX_PROMPT_BYTES ||
    !path.isAbsolute(request.workspace)
  )
    throw new ExecutorFailure("unsupported");
  let workspace: string;
  try {
    workspace = await realpath(request.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error();
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  return {
    requestId: request.requestId,
    model: settings.model,
    workspace,
    promptSha256: createHash("sha256").update(request.prompt).digest("hex"),
  };
}
/** Only a trusted host may call this after the actual user answer. No inference,
 * login, billing assertion, or automatic reissuance occurs here. */
export async function createCodexCreditRiskPermit(
  port: CodexCreditRiskDecisionPort,
  request: ExecutionRequest,
  signal?: AbortSignal,
): Promise<CodexCreditRiskPermit> {
  request = snapshotCodexRequest(request);
  checkAbort(signal);
  const scope = await creditRiskScope(request);
  checkAbort(signal);
  const receipt = await port.consumeUserDecision(
    Object.freeze({ ...scope }),
    signal,
  );
  const now = Date.now();
  if (
    !receipt ||
    typeof receipt.decisionId !== "string" ||
    !receipt.decisionId.trim() ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.expiresAt <= now ||
    receipt.expiresAt > now + 300_000
  )
    throw new ExecutorFailure("billing-unconfirmed");
  let used = decisions.get(port);
  if (!used) {
    used = new Set();
    decisions.set(port, used);
  }
  if (used.has(receipt.decisionId) || used.size >= 1000)
    throw new ExecutorFailure("billing-unconfirmed");
  used.add(receipt.decisionId);
  checkAbort(signal);
  const permit = Object.freeze({}) as CodexCreditRiskPermit;
  permits.set(permit, { scope, expiresAt: receipt.expiresAt, consumed: false });
  return permit;
}

/** First official adapter boundary. ChatGPT login alone does not verify the
 * account overage/credit settings or prevent API fallback in a generation profile.
 * Existing credits are not authorized for consumption. Official account settings
 * must be verified before dispatch; no caller attestation or quota snapshot alone
 * can unlock execution in this implementation.
 */
export class CodexExecutor implements AgentExecutor {
  private readonly options: CodexOptions;
  private startupDiagnostics?: ExecutionDiagnostics;
  diagnostics(): ExecutionDiagnostics | undefined {
    return sanitizeExecutionDiagnostics(this.startupDiagnostics);
  }
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
  /** Explicit, separate one-generation authorization. Never called by ordinary
   * startExecution and never upgrades the subscription-only entitlement. */
  async startAuthorizedOnce(
    request: ExecutionRequest,
    outputSchemaPath: string,
    permit: CodexCreditRiskPermit,
    signal?: AbortSignal,
  ): Promise<ExecutionHandle> {
    let diagnostic: ExecutionDiagnostics = {
      version: 1,
      stage: "permit-validation",
      backendReach: "unknown",
    };
    this.startupDiagnostics = diagnostic;
    const enter = (stage: ExecutionDiagnostics["stage"]) => {
      diagnostic = { version: 1, stage, backendReach: "unknown" };
      this.startupDiagnostics = diagnostic;
    };
    const observe = (observed: ExecutionDiagnostics) => {
      diagnostic = observed;
      this.startupDiagnostics = diagnostic;
    };
    try {
      const authorization = permits.get(permit);
      if (
        !authorization ||
        authorization.consumed ||
        authorization.expiresAt <= Date.now()
      )
        throw new ExecutorFailure("billing-unconfirmed");
      // Consume before asynchronous preflight/spawn; failed attempts and cancellation
      // do not restore permission or permit concurrent/replayed generations.
      authorization.consumed = true;
      request = snapshotCodexRequest(request);
      checkAbort(signal);
      const scope = await creditRiskScope(request);
      checkAbort(signal);
      if (
        Object.keys(scope).some(
          (key) =>
            scope[key as keyof CodexCreditRiskScope] !==
            authorization.scope[key as keyof CodexCreditRiskScope],
        )
      )
        throw new ExecutorFailure("billing-unconfirmed");
      enter("runtime-metadata");
      const inspection = await inspectCodex(this.options, signal, observe);
      checkAbort(signal);
      if (inspection.runtimeVersion !== "0.160.0")
        throw new ExecutorFailure("unsupported");
      if (inspection.authentication !== "chatgpt")
        throw new ExecutorFailure("authentication");
      enter("generation-profile");
      const profile = await createCodexGenerationProfile(
        this.options,
        request,
        outputSchemaPath,
      );
      if (
        profile.process.workspace !== authorization.scope.workspace ||
        createHash("sha256")
          .update(profile.process.input ?? "")
          .digest("hex") !== authorization.scope.promptSha256
      )
        throw new ExecutorFailure("billing-unconfirmed");
      if (authorization.expiresAt <= Date.now())
        throw new ExecutorFailure("billing-unconfirmed");
      enter("safety-metadata");
      await verifyCodexSafetyProfile(profile, signal, observe);
      if (authorization.expiresAt <= Date.now())
        throw new ExecutorFailure("billing-unconfirmed");
      enter("native-instructions");
      await verifyNativeInstructions(profile.process.env);
      checkAbort(signal);
      if (authorization.expiresAt <= Date.now())
        throw new ExecutorFailure("billing-unconfirmed");
      enter("generation-launch");
      return await launchCodex(profile, request.requestId, signal);
    } catch (error) {
      // Use only the validated process observation; do not copy raw errors or
      // mistake a metadata subprocess for a dispatched generation.
      const observed =
        error instanceof ExecutorFailure
          ? sanitizeExecutionDiagnostics(error.diagnostics)
          : undefined;
      if (observed?.process) {
        diagnostic.process = observed.process;
        diagnostic.processKind =
          diagnostic.stage === "generation-launch" ? "generation" : "metadata";
      }
      throw new ExecutorFailure(
        error instanceof ExecutorFailure ? error.reason : "unknown-outcome",
        diagnostic,
      );
    }
  }
  async resume(request: ResumeRequest): Promise<ExecutionHandle> {
    void request;
    // No implicit new turn/replay of accepted work as a substitute for resume.
    throw new ExecutorFailure("unsupported");
  }
}

/** Conservative metadata gate: app-server config/read includes user config,
 * whereas exec ignores it. Reject unsafe retained maps/layers; never treat this
 * superset read as an exact effective-turn tool inventory or billing proof.
 * No thread/start, turn/start, account refresh, or inference request is sent. */
/** Safe control-name diagnostic only; never carries raw config or account data. */
export class CodexSafetyFailure extends ExecutorFailure {
  constructor(readonly control: string) {
    super("unsupported");
  }
}
export async function inspectCodexGenerationSafety(
  options: CodexOptions,
  request: ExecutionRequest,
  outputSchemaPath: string,
): Promise<void> {
  await verifyCodexSafetyProfile(
    await createCodexGenerationProfile(options, request, outputSchemaPath),
  );
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExecutorFailure("cancelled");
}
async function verifyNativeInstructions(
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const home =
    env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME, ".codex") : undefined);
  if (!home) throw new CodexSafetyFailure("native-instructions.home");
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    try {
      const info = await lstat(path.join(home, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 0)
        throw new ExecutorFailure("unsupported");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new CodexSafetyFailure("native-instructions");
    }
  }
}
async function verifyCodexSafetyProfile(
  profile: CodexGenerationProfile,
  signal?: AbortSignal,
  observe?: (diagnostic: ExecutionDiagnostics) => void,
): Promise<void> {
  checkAbort(signal);
  await verifyNativeInstructions(profile.process.env);
  checkAbort(signal);
  const args = ["app-server", "--strict-config"];
  for (let index = 0; index < profile.process.args.length; index++) {
    const arg = profile.process.args[index];
    if (arg === "--config" || arg === "--disable")
      args.push(arg, profile.process.args[++index]);
  }
  const initialized = JSON.stringify({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "mimic_codex_safety", version: "1" },
      capabilities: { experimentalApi: true },
    },
  });
  let pending = "";
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let phase = 0;
  let snapshot: Record<string, unknown> | undefined;
  let requirements: Record<string, unknown> | undefined;
  const handle: OfficialProcessHandle = await executeOfficialProcess({
    ...profile.process,
    args,
    input: initialized + "\n",
    keepStdinOpen: true,
    signal,
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: Math.min(profile.process.timeoutMs, 10_000),
    onStdout: (chunk) => {
      pending += utf8.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const response = object(JSON.parse(line));
        if (
          response.id === 1 &&
          phase === 0 &&
          response.result &&
          !response.error
        ) {
          phase = 1;
          handle.writeInput(
            JSON.stringify({ method: "initialized", params: {} }) +
              "\n" +
              JSON.stringify({
                id: 2,
                method: "config/read",
                params: {
                  includeLayers: true,
                  cwd: profile.process.workspace,
                },
              }) +
              "\n",
          );
        } else if (
          response.id === 2 &&
          phase === 1 &&
          response.result &&
          !response.error
        ) {
          snapshot = object(response.result);
          phase = 2;
          handle.writeInput(
            JSON.stringify({
              id: 3,
              method: "configRequirements/read",
              params: null,
            }) + "\n",
          );
        } else if (
          response.id === 3 &&
          phase === 2 &&
          response.result &&
          !response.error
        ) {
          requirements = object(response.result);
          phase = 3;
          handle.closeInput();
        } else if (response.id !== undefined || response.method === "error") {
          throw new ExecutorFailure("unsupported");
        }
      }
    },
  });
  let result;
  try {
    result = await handle.result;
  } finally {
    observe?.({
      version: 1,
      stage: "safety-metadata",
      backendReach: "unknown",
      processKind: "metadata",
      process: handle.diagnostics(),
    });
  }
  checkAbort(signal);
  pending += utf8.decode();
  if (result.exitCode !== 0 || pending.trim() || !snapshot || phase !== 3)
    throw new ExecutorFailure("unsupported");
  // Requirements have higher authority than raw CLI config. Official0.160
  // generates allowedLoginMethods=["chatgpt"] from forced_login_method. Accept
  // that exact restriction with all other policy values null, or no policy.
  if (!requirements || !Object.hasOwn(requirements, "requirements"))
    throw new CodexSafetyFailure("requirements.response");
  if (requirements.requirements !== null) {
    const policy = object(requirements.requirements);
    const known = new Set([
      "modelProvider",
      "modelProviders",
      "chatgptBaseUrl",
      "additionalDeveloperInstructions",
      "defaultPermissions",
      "featureRequirements",
      "allowedPermissionProfiles",
      "allowedSandboxModes",
      "allowedApprovalPolicies",
      "modelCatalogJson",
      "network",
      "application",
      "hooks",
      "autoReview",
      "models",
    ]);
    for (const [key, value] of Object.entries(policy)) {
      if (value === null) continue;
      if (
        key === "allowedLoginMethods" &&
        Array.isArray(value) &&
        value.length === 1 &&
        value[0] === "chatgpt"
      )
        continue;
      throw new CodexSafetyFailure(
        known.has(key) ? `requirements.${key}` : "requirements.policy",
      );
    }
  }
  validateCodexSafetySnapshot(snapshot, profile);
}
/** Safety projection for stock unmodified0.160.0 exec: API layers are high to
 * low and omit embedded packaged defaults. That version's stock defaults have
 * no MCP/provider/permission overrides; pin the guarded defaults here. Public
 * exec cannot inject an alternate packaged-default file. Preserve remaining
 * layers in supplied order; never re-sort equal-precedence enterprise layers. */
function reconstructCodexExecSafetyConfig(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(snapshot.layers) || !snapshot.layers.length)
    throw new CodexSafetyFailure("layers");
  const precedence: Record<string, number> = Object.assign(
    Object.create(null),
    {
      mdm: 0,
      system: 10,
      enterpriseManaged: 15,
      user: 20,
      project: 25,
      sessionFlags: 30,
      legacyManagedConfigTomlFromFile: 40,
      legacyManagedConfigTomlFromMdm: 50,
    },
  );
  const layers = snapshot.layers.map(object);
  let previous = Infinity;
  let sessionFlags = 0;
  for (const layer of layers) {
    const name = object(layer.name),
      type = String(name.type);
    if (
      !Object.hasOwn(precedence, type) ||
      typeof layer.version !== "string" ||
      !layer.version ||
      (layer.disabledReason !== undefined &&
        typeof layer.disabledReason !== "string")
    )
      throw new CodexSafetyFailure("layers.identity");
    object(layer.config);
    const absolute = (key: string) =>
      typeof name[key] === "string" &&
      path.isAbsolute(name[key] as string) &&
      !(name[key] as string).includes("\0");
    if (
      (["system", "user", "legacyManagedConfigTomlFromFile"].includes(type) &&
        !absolute("file")) ||
      (type === "project" && !absolute("dotCodexFolder")) ||
      (type === "user" &&
        name.profile !== null &&
        typeof name.profile !== "string") ||
      (type === "mdm" &&
        ["domain", "key"].some(
          (key) => typeof name[key] !== "string" || !name[key],
        )) ||
      (type === "enterpriseManaged" &&
        ["id", "name"].some(
          (key) => typeof name[key] !== "string" || !name[key],
        ))
    )
      throw new CodexSafetyFailure("layers.identity");
    const rank = precedence[type] + (type === "user" && name.profile ? 1 : 0);
    if (rank > previous) throw new CodexSafetyFailure("layers.precedence");
    previous = rank;
    if (type === "sessionFlags") {
      if (layer.disabledReason)
        throw new CodexSafetyFailure("layers.sessionFlags");
      sessionFlags++;
    }
    if (type === "project" && !layer.disabledReason)
      throw new CodexSafetyFailure("project");
  }
  if (sessionFlags !== 1) throw new CodexSafetyFailure("layers.sessionFlags");
  let config: unknown = Object.assign(Object.create(null), {
    chatgpt_base_url: "https://chatgpt.com/backend-api/",
    mcp_servers: Object.create(null),
    model_providers: Object.create(null),
  });
  for (const layer of [...layers].reverse()) {
    const type = object(layer.name).type;
    if (type === "user" || layer.disabledReason) continue;
    config = mergeCodexConfig(config, layer.config);
  }
  return object(config);
}
function mergeCodexConfig(
  base: unknown,
  overlay: unknown,
  keys: string[] = [],
): unknown {
  const table = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const structured =
    keys.length === 2 &&
    keys[0] === "features" &&
    ["code_mode", "multi_agent_v2", "network_proxy", "sleep_tool"].includes(
      keys[1],
    );
  if (structured && table(base) && typeof overlay === "boolean")
    return Object.assign(Object.create(null), base, { enabled: overlay });
  if (structured && typeof base === "boolean" && table(overlay))
    base = { enabled: base };
  if (!table(overlay))
    return Array.isArray(overlay)
      ? overlay.map((value) => mergeCodexConfig(undefined, value))
      : overlay;
  const result: Record<string, unknown> = Object.create(null);
  if (table(base))
    for (const [key, value] of Object.entries(base)) result[key] = value;
  for (const [key, value] of Object.entries(overlay)) {
    // Aliases/filter normalizers are intentionally unsupported in retained
    // non-user layers: silently guessing public TOML semantics would be unsafe.
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      (keys.join(".") === "tui" && key === "whimsy") ||
      (keys.join(".") === "memories" &&
        key === "no_memories_if_mcp_or_web_search") ||
      (keys.join(".") === "agents" && key === "max_threads") ||
      (keys.join(".") === "shell_environment_policy" &&
        ["filters", "exclude", "include_only"].includes(key)) ||
      (keys.join(".") === "features" &&
        key === "network_proxy" &&
        overlay[key] !== false)
    )
      throw new CodexSafetyFailure("layers.keys");
    result[key] = mergeCodexConfig(
      Object.hasOwn(result, key) ? result[key] : undefined,
      value,
      [...keys, key],
    );
  }
  return result;
}

function validateCodexSafetySnapshot(
  snapshot: Record<string, unknown>,
  profile: CodexGenerationProfile,
): void {
  const reject = (control = "configuration") => {
    throw new CodexSafetyFailure(control);
  };
  object(snapshot.config); // Require the documented snapshot envelope as well.
  const config = reconstructCodexExecSafetyConfig(snapshot);
  const get = (keys: string[]): unknown =>
    keys.reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)[key]
          : undefined,
      config,
    );
  // Fixed scalar controls must survive managed overrides.
  for (let index = 0; index < profile.process.args.length; index++) {
    const flag = profile.process.args[index];
    const value = profile.process.args[index + 1];
    if (flag === "--disable") {
      const feature = get(["features", value]);
      if (
        feature !== false &&
        !(
          feature &&
          typeof feature === "object" &&
          ["code_mode", "multi_agent_v2", "sleep_tool"].includes(value) &&
          object(feature).enabled === false
        )
      )
        reject("features");
    } else if (
      flag === "--config" &&
      /=(true|false|0|"[^"\\]*")$/.test(value)
    ) {
      const separator = value.indexOf("=");
      const expected = JSON.parse(value.slice(separator + 1));
      const keys = value.slice(0, separator).split(".");
      const actual = get(keys);
      if (actual !== expected) reject("fixed-controls");
    }
  }
  if (
    get(["features", "code_mode_host", "enabled"]) !== false ||
    get(["features", "code_mode_host", "disable_in_process_fallback"]) !==
      false ||
    get(["projects", profile.process.workspace, "trust_level"]) !== "untrusted"
  )
    reject();
  const permission = object(object(config.permissions).mimic);
  if (
    permission.extends !== ":read-only" ||
    object(permission.network).enabled !== false
  )
    reject();
  if (
    Object.keys(permission).some(
      (key) =>
        permission[key] != null &&
        !["extends", "network", "filesystem"].includes(key),
    ) ||
    Object.entries(object(permission.network)).some(
      ([key, value]) => value != null && key !== "enabled",
    )
  )
    reject();
  const denyPaths = object(permission.filesystem);
  if (
    Object.entries(denyPaths).some(
      ([key, value]) =>
        !(key === "glob_scan_max_depth" && value == null) && value !== "deny",
    )
  )
    reject();
  if (!Array.isArray(config.notify) || config.notify.length) reject();
  if (
    !Array.isArray(config.project_root_markers) ||
    config.project_root_markers.length
  )
    reject("project_root_markers");
  for (const file of [
    ...(profile.process.env.HOME
      ? [
          path.join(profile.process.env.HOME, ".codex"),
          path.join(profile.process.env.HOME, ".ssh"),
          path.join(profile.process.env.HOME, ".aws"),
        ]
      : []),
    ...(profile.process.env.CODEX_HOME ? [profile.process.env.CODEX_HOME] : []),
  ])
    if (denyPaths[file] !== "deny") reject();
  // Inline tables recursively merge. An empty CLI table does not clear retained
  // MCP servers or provider settings; inspect and conservatively reject them.
  if (
    config.mcp_servers !== undefined &&
    Object.keys(object(config.mcp_servers)).length
  )
    reject("mcp_servers");
  if (
    config.model_providers !== undefined &&
    Object.keys(object(config.model_providers)).length
  )
    reject("model_providers");
  for (const key of [
    "openai_base_url",
    "model_catalog_json",
    "model_instructions_file",
    "instructions",
    "developer_instructions",
    "compact_prompt",
  ]) {
    if (config[key] !== undefined && config[key] !== null) reject(key);
  }
  if (!Array.isArray(snapshot.layers)) reject();
  if (
    config.chatgpt_base_url !== undefined &&
    config.chatgpt_base_url !== null &&
    config.chatgpt_base_url !== "https://chatgpt.com/backend-api/"
  )
    reject("chatgpt_base_url");
  for (const entry of snapshot.layers as unknown[]) {
    const layer = object(entry);
    if (object(layer.name).type === "project" && !layer.disabledReason)
      reject();
  }
}

/** Single subprocess, incremental decoding, and group cancellation. No retries.
 * Raw stderr remains private. JSON candidate data has no approval authority. */
async function launchCodex(
  profile: CodexGenerationProfile,
  requestId: string,
  signal?: AbortSignal,
): Promise<ExecutionHandle> {
  const decoder = new CodexJsonlDecoder(requestId, 4 * 1024 * 1024, "json");
  const queue: ExecutorEvent[] = [];
  let done = false;
  let wake: (() => void) | undefined;
  let started = false;
  const publish = (events: ExecutorEvent[]) => {
    if (!started && events.some((event) => event.type === "stopped")) {
      queue.push({ type: "started", requestId });
      started = true;
    }
    if (events.some((event) => event.type === "started")) started = true;
    queue.push(...events);
    wake?.();
    wake = undefined;
  };
  const process = await executeOfficialProcess({
    ...profile.process,
    onStdout: (chunk) => publish(decoder.push(chunk)),
    signal,
  });
  void process.result
    .then(
      (result) => publish(decoder.finish(result.exitCode)),
      (error) =>
        publish([
          stopEvent(
            decoder.policyStop() ??
              (error instanceof ExecutorFailure
                ? error.reason
                : "unknown-outcome"),
          ),
        ]),
    )
    .finally(() => {
      done = true;
      wake?.();
      wake = undefined;
    });
  return {
    cancel: process.cancel,
    diagnostics: () => ({
      version: 1,
      stage: "generation",
      backendReach: "unknown",
      processKind: "generation",
      process: process.diagnostics(),
      decoder: decoder.diagnostics(),
    }),
    events: (async function* () {
      let exhausted = false;
      try {
        while (!done || queue.length) {
          if (queue.length) yield queue.shift()!;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
        exhausted = true;
      } finally {
        if (!exhausted) await process.cancel();
      }
    })(),
  };
}

/** A reviewable fresh-turn plan, not authority to launch a model. */
export interface CodexGenerationProfile {
  mode: "fresh";
  nativeResume: false;
  toolRestriction: false;
  process: OfficialProcessRequest;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Fixed official controls only: callers cannot append args, override providers,
 * change the tier, or smuggle ambient API credentials through this profile.
 * No model is dispatched here; production start still applies the billing hold.
 */
export async function createCodexGenerationProfile(
  options: CodexOptions,
  request: ExecutionRequest,
  outputSchemaPath: string,
): Promise<CodexGenerationProfile> {
  let settings;
  try {
    settings = parseSubscriptionSettings(request.settings);
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  if (
    settings.provider !== "codex" ||
    !settings.model ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(settings.model) ||
    !request.requestId.trim() ||
    !request.prompt ||
    Buffer.byteLength(request.prompt) > MAX_CODEX_PROMPT_BYTES ||
    !path.isAbsolute(options.executable) ||
    options.executable.includes("\0") ||
    !path.isAbsolute(request.workspace) ||
    !path.isAbsolute(options.workspace) ||
    Object.keys(options).some(
      (key) =>
        ![
          "executable",
          "env",
          "workspace",
          "timeoutMs",
          "reasoningEffort",
        ].includes(key),
    )
  )
    throw new ExecutorFailure("unsupported");
  const env = validateOfficialEnvironment(options.env);
  if (
    (env.HOME && !path.isAbsolute(env.HOME)) ||
    (env.CODEX_HOME && !path.isAbsolute(env.CODEX_HOME))
  )
    throw new ExecutorFailure("unsupported");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CODEX_GENERATION_TIMEOUT_MS ||
    (options.reasoningEffort !== undefined &&
      !["low", "medium"].includes(options.reasoningEffort)) ||
    outputSchemaPath.includes("\0")
  )
    throw new ExecutorFailure("unsupported");
  let workspace: string, schema: string;
  try {
    workspace = await realpath(request.workspace);
    if (
      workspace !== (await realpath(options.workspace)) ||
      !(await stat(workspace)).isDirectory()
    )
      throw new Error();
    const lexicalRoot = path.resolve(request.workspace);
    const lexicalSchema = path.resolve(lexicalRoot, outputSchemaPath);
    if (!within(lexicalRoot, lexicalSchema)) throw new Error();
    schema = await realpath(lexicalSchema);
    if (!within(workspace, schema) || !(await stat(schema)).isFile())
      throw new Error();
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  const controls = [
    'forced_login_method="chatgpt"',
    'model_provider="openai"',
    // Version0.160.0 maps Standard to the default service tier, not priority.
    'service_tier="default"',
    ...(options.reasoningEffort
      ? [`model_reasoning_effort="${options.reasoningEffort}"`]
      : []),
    'approval_policy="never"',
    'web_search="disabled"',
    "tools.update_plan.enabled=false",
    "tools.experimental_request_user_input.enabled=false",
    "memories.generate_memories=false",
    "memories.use_memories=false",
    "agents.enabled=false",
    "orchestrator.mcp.enabled=false",
    "cloud.skills.enabled=false",
    "skills.include_instructions=false",
    "project_doc_max_bytes=0",
    "project_root_markers=[]",
    'shell_environment_policy.inherit="none"',
    "analytics.enabled=false",
    "feedback.enabled=false",
    `projects={${JSON.stringify(workspace)}={trust_level="untrusted"}}`,
    'default_permissions="mimic"',
    `permissions={mimic={extends=":read-only",network={enabled=false},filesystem={${[
      ...new Set([
        ...(env.HOME
          ? [
              path.join(env.HOME, ".codex"),
              path.join(env.HOME, ".ssh"),
              path.join(env.HOME, ".aws"),
            ]
          : []),
        ...(env.CODEX_HOME ? [env.CODEX_HOME] : []),
      ]),
    ]
      .map((file) => `${JSON.stringify(file)}="deny"`)
      .join(",")}}}}`,
    "features.code_mode_host={enabled=false,disable_in_process_fallback=false}",
    "skills.bundled.enabled=false",
    "features.skip_host_skill_discovery=true",
    "notify=[]",
  ];
  const features = [
    "shell_tool",
    "unified_exec",
    "hooks",
    "plugins",
    "apps",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "fast_mode",
    "step_model_switching",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "code_mode",
    "sleep_tool",
    "skill_search",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "auth_elicitation",
    "unbounded_connection_retries",
    "workspace_dependencies",
    "request_permissions_tool",
    "token_budget",
    "deferred_executor",
    "current_time_reminder",
    "send_message_to_user_async",
  ];
  return {
    mode: "fresh",
    nativeResume: false,
    toolRestriction: false,
    process: {
      executable: options.executable,
      args: [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--strict-config",
        "--skip-git-repo-check",
        "--json",
        "--color",
        "never",
        "--model",
        settings.model,
        "--output-schema",
        schema,
        ...controls.flatMap((control) => ["--config", control]),
        ...features.flatMap((feature) => ["--disable", feature]),
        "-",
      ],
      workspace,
      env,
      input: request.prompt,
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
    },
  };
}

export interface CodexSubmissionInput {
  output: string;
  runId: string;
  taskId: string;
  packagePath: string;
  workPath: string;
  workspace: string;
}
/** No filesystem writes, execution host, approval, or commit. The session layer
 * saves serializedWork immutably; the existing static CLI submit is authority.
 */
export function prepareCodexSubmission(input: CodexSubmissionInput): {
  envelope: Record<string, unknown>;
  serializedWork: string;
  argv: string[];
} {
  if (
    !path.isAbsolute(input.workspace) ||
    input.workspace.includes("\0") ||
    ![input.runId, input.taskId].every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
    )
  )
    throw new ExecutorFailure("unsupported");
  const workspace = path.resolve(input.workspace);
  for (const file of [input.packagePath, input.workPath]) {
    if (
      !file ||
      file.includes("\0") ||
      file.startsWith("-") ||
      !within(workspace, path.resolve(workspace, file))
    )
      throw new ExecutorFailure("unsupported");
  }
  const envelope = parseCodexWorkEnvelope(input.output);
  const result = object(object(envelope.work).result);
  if (result.runId !== input.runId || result.taskId !== input.taskId)
    throw new ExecutorFailure("unknown-outcome");
  return {
    envelope,
    serializedWork: `${JSON.stringify(envelope)}\n`,
    argv: [
      "submit",
      input.runId,
      "--task",
      input.taskId,
      "--package",
      input.packagePath,
      "--work",
      input.workPath,
      "--root",
      workspace,
      "--json",
    ],
  };
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
    // Strict Structured Outputs cannot describe arbitrary artifact content.
    // The official CLI may instead return one JSON-encoded submission string;
    // the same static submit path validates its decoded contents below.
    if (
      Object.keys(envelope).length === 1 &&
      typeof envelope.submissionJson === "string"
    ) {
      const serialized = envelope.submissionJson;
      try {
        envelope = object(JSON.parse(serialized));
      } catch {
        // A single redundant closing brace is an unambiguous syntax error.
        // Keep the original output separately and let static submit validate
        // every resulting field, origin and exact lock.
        if (!serialized.endsWith("}")) throw new Error();
        envelope = object(JSON.parse(serialized.slice(0, -1)));
      }
    }
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
  private awaitingFailedTurn = false;
  private finalText: string | undefined;
  private readonly items = new Map<
    string,
    { type: string; completed: boolean }
  >();
  private failed = false;
  private finished = false;
  private rejectedShape: RejectedProtocolShape | undefined;
  private policyReason: "unsupported" | "quota" | "authentication" | undefined;
  /** Set only by the closed native warning handler, never an adapter error. */
  policyStop(): "unsupported" | "quota" | "authentication" | undefined {
    return this.policyReason;
  }
  private failure: NonNullable<ExecutionDiagnostics["decoder"]>["failure"] =
    "none";
  private noteFailure(
    value: NonNullable<ExecutionDiagnostics["decoder"]>["failure"],
  ): void {
    if (this.failure === "none") this.failure = value;
  }
  constructor(
    private readonly requestId: string,
    private readonly maxBytes = 4 * 1024 * 1024,
    private readonly outputFormat: "work-envelope" | "json" = "work-envelope",
  ) {
    if (
      !requestId.trim() ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 16 * 1024 * 1024
    )
      throw new ExecutorFailure("unsupported");
  }
  diagnostics(): NonNullable<ExecutionDiagnostics["decoder"]> {
    return {
      threadStarted: this.threadId !== undefined,
      turnStarted: this.turn,
      outputObserved: this.finalText !== undefined,
      terminalObserved: this.terminal !== undefined,
      finished: this.finished,
      failed: this.failed,
      failure: this.failure,
      ...(this.rejectedShape
        ? { rejectedShape: { ...this.rejectedShape } }
        : {}),
    };
  }
  push(chunk: Buffer): ExecutorEvent[] {
    if (this.failed || this.finished)
      throw new ExecutorFailure("unknown-outcome");
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.failed = true;
      this.noteFailure("output-limit");
      throw new ExecutorFailure("unknown-outcome");
    }
    try {
      let text: string;
      try {
        text = this.utf8.decode(chunk, { stream: true });
      } catch {
        this.noteFailure("utf8");
        throw new ExecutorFailure("unknown-outcome");
      }
      return this.consume(text);
    } catch {
      this.failed = true;
      this.noteFailure("protocol");
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
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.noteFailure("json");
      throw new ExecutorFailure("unknown-outcome");
    }
    try {
      return this.event(decoded);
    } catch (error) {
      this.rejectedShape ??= this.shape(decoded);
      throw error;
    }
  }
  private shape(decoded: unknown): RejectedProtocolShape {
    const event =
      decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    const item =
      event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : undefined;
    const eventTypes = [
      "thread.started",
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
      "turn.completed",
      "turn.failed",
      "error",
    ];
    const itemTypes = ["reasoning", "agent_message", "error"];
    const unknownKeys = (value: Record<string, unknown>, known: string[]) =>
      Math.min(
        255,
        Object.keys(value).filter((key) => !known.includes(key)).length,
      );
    return {
      eventType:
        typeof event.type === "string" && eventTypes.includes(event.type)
          ? (event.type as RejectedProtocolShape["eventType"])
          : "other",
      itemType: !item
        ? "none"
        : typeof item.type === "string" && itemTypes.includes(item.type)
          ? (item.type as RejectedProtocolShape["itemType"])
          : "other",
      hasItem: Object.hasOwn(event, "item"),
      hasId: !!item && Object.hasOwn(item, "id"),
      hasType: !!item && Object.hasOwn(item, "type"),
      hasText: !!item && Object.hasOwn(item, "text"),
      hasMessage: !!item && Object.hasOwn(item, "message"),
      eventUnknownKeys: unknownKeys(event, [
        "type",
        "item",
        "thread_id",
        "usage",
        "error",
        "message",
      ]),
      itemUnknownKeys: item
        ? unknownKeys(item, ["id", "type", "text", "message"])
        : 0,
    };
  }
  private event(decoded: unknown): ExecutorEvent[] {
    const event = object(decoded);
    if (this.terminal) {
      if (this.awaitingFailedTurn && event.type === "turn.failed") {
        const failure = object(event.error);
        if (typeof failure.message !== "string")
          throw new ExecutorFailure("unknown-outcome");
        this.awaitingFailedTurn = false;
        return [];
      }
      throw new ExecutorFailure("unknown-outcome");
    }
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
      this.awaitingFailedTurn = event.type === "error";
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
    // rust-v0.160.0 warnings/deprecations are completed error items, including
    // before turn.started. This exception never supplies turn/output authority.
    if (
      event.type === "item.completed" &&
      object(event.item).type === "error"
    ) {
      const item = object(event.item);
      if (
        Object.keys(event).length !== 2 ||
        Object.keys(event).some((key) => !["type", "item"].includes(key)) ||
        Object.keys(item).length !== 3 ||
        Object.keys(item).some(
          (key) => !["id", "type", "message"].includes(key),
        ) ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        typeof item.message !== "string" ||
        this.items.has(item.id)
      )
        throw new ExecutorFailure("unknown-outcome");
      this.items.set(item.id, { type: "error", completed: true });
      const reason = item.message.startsWith("model rerouted: ")
        ? "unsupported"
        : classifyCodexError(item.message);
      if (
        reason === "unsupported" ||
        reason === "quota" ||
        reason === "authentication"
      ) {
        this.policyReason = reason;
        this.noteFailure("policy-stop");
        // The shared stdout callback shuts down the process group. Preserve
        // this fixed reason at settlement even if native events keep arriving.
        throw new ExecutorFailure(reason);
      }
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
        // The official CLI may complete more than one distinct message in a
        // turn. Only the final completed message at turn.completed is a work
        // candidate; earlier messages remain bounded, uncommitted output.
        this.finalText = item.text;
        return [{ type: "output", text: item.text }];
      }
      return [];
    }
    if (event.type === "turn.completed" && this.finalText !== undefined) {
      if ([...this.items.values()].some((item) => !item.completed))
        throw new ExecutorFailure("unknown-outcome");
      try {
        if (this.outputFormat === "work-envelope")
          parseCodexWorkEnvelope(this.finalText);
        else object(JSON.parse(this.finalText));
      } catch {
        this.noteFailure("invalid-output");
        throw new ExecutorFailure("unknown-outcome");
      }
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
    if (this.failed || this.finished)
      return [stopEvent(this.policyReason ?? "unknown-outcome")];
    this.finished = true;
    try {
      let text: string;
      try {
        text = this.utf8.decode();
      } catch {
        this.noteFailure("utf8");
        throw new ExecutorFailure("unknown-outcome");
      }
      const events = this.consume(text);
      if (this.pending.trim()) {
        events.push(...this.line(this.pending));
        this.pending = "";
      }
      if (!this.terminal) {
        this.noteFailure(exitCode !== 0 ? "nonzero-exit" : "missing-terminal");
        return [...events, stopEvent("unknown-outcome")];
      }
      if (exitCode !== 0 && this.terminal.type === "completed") {
        this.noteFailure("nonzero-exit");
        return [...events, stopEvent("unknown-outcome")];
      }
      return [...events, this.terminal];
    } catch {
      this.failed = true;
      this.noteFailure("protocol");
      return [stopEvent(this.policyReason ?? "unknown-outcome")];
    }
  }
}
