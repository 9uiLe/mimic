#!/usr/bin/env node
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexExecutor, type CodexCreditRiskDecisionPort } from "./codex.js";
import { createAuthorizedCodexSessionDispatch } from "./session-authorized.js";
import { AgentSession, FileSessionStore } from "./session.js";
import { createWorkspaceSessionPorts } from "./session-workspace.js";

const allowedEnvironment = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "TERM",
  "NO_COLOR",
] as const;
interface SessionConfiguration {
  workspace: string;
  runId: string;
  sessionId: string;
  packages: Record<string, string>;
  model: string;
  reasoningEffort?: "low" | "medium";
  executable: string;
  maxGenerations?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
function parseConfiguration(value: unknown): SessionConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid configuration");
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (key) =>
        ![
          "workspace",
          "runId",
          "sessionId",
          "packages",
          "model",
          "reasoningEffort",
          "executable",
          "maxGenerations",
          "timeoutMs",
          "maxOutputBytes",
        ].includes(key),
    ) ||
    ["workspace", "runId", "sessionId", "model", "executable"].some(
      (key) => typeof config[key] !== "string" || !String(config[key]).trim(),
    ) ||
    !path.isAbsolute(String(config.workspace)) ||
    !path.isAbsolute(String(config.executable)) ||
    !config.packages ||
    typeof config.packages !== "object" ||
    Array.isArray(config.packages) ||
    Object.values(config.packages).some(
      (value) => typeof value !== "string" || !value,
    )
  )
    throw new Error("Invalid configuration");
  if (
    config.reasoningEffort !== undefined &&
    (typeof config.reasoningEffort !== "string" ||
      !["low", "medium"].includes(config.reasoningEffort))
  )
    throw new Error("Invalid reasoning effort");
  for (const [key, maximum] of [
    ["maxGenerations", 20],
    ["timeoutMs", 120000],
    ["maxOutputBytes", 4 * 1024 * 1024],
  ] as const) {
    if (
      config[key] !== undefined &&
      (!Number.isSafeInteger(config[key]) ||
        Number(config[key]) < 1 ||
        Number(config[key]) > maximum)
    )
      throw new Error("Invalid session limit");
  }
  return config as unknown as SessionConfiguration;
}
/** Fixed production adapter and billing policy. No host/fake executor injection,
 * custom environment, arbitrary argv, approval operation or entitlement unlock. */
export async function runSessionCli(
  argv: readonly string[],
  io: { out(value: string): void; err(value: string): void } = {
    out: console.log,
    err: console.error,
  },
): Promise<number> {
  return runConfiguredSession(argv, io);
}

/** Trusted coordinator entry after an actual user decision. It is intentionally
 * unavailable as a JSON setting or CLI flag. The decision port consumes the
 * host's receipt; no entitlement/billing-proof object is invented. */
export async function runAuthorizedSessionOnce(
  configPath: string,
  outputSchemaPath: string,
  decision: CodexCreditRiskDecisionPort,
  io: { out(value: string): void; err(value: string): void } = {
    out: console.log,
    err: console.error,
  },
): Promise<number> {
  return runConfiguredSession(["start", "--config", configPath], io, {
    decision,
    outputSchemaPath,
  });
}

async function runConfiguredSession(
  argv: readonly string[],
  io: { out(value: string): void; err(value: string): void },
  authorized?: {
    decision: CodexCreditRiskDecisionPort;
    outputSchemaPath: string;
  },
): Promise<number> {
  const [command, flag, configPath, ...remaining] = argv;
  if (
    !["start", "resume", "inspect", "recover-lock"].includes(command ?? "") ||
    flag !== "--config" ||
    !configPath ||
    remaining.some((arg) => arg !== "--reconciled-unknown-outcome") ||
    remaining.length > 1 ||
    (remaining.length && command !== "resume")
  ) {
    io.err(
      "Usage: session-main <start|resume|inspect|recover-lock> --config <file> [--reconciled-unknown-outcome for resume]",
    );
    return 2;
  }
  try {
    const handle = await open(
      await realpath(configPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let config: SessionConfiguration;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024)
        throw new Error("Invalid configuration file");
      config = parseConfiguration(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
    } finally {
      await handle.close();
    }
    const settings = {
      provider: "codex" as const,
      model: config.model,
      billingMode: "subscription-only" as const,
    };
    const store = new FileSessionStore(config.workspace);
    if (command === "recover-lock") {
      await store.recoverAbandonedLock(config.sessionId);
      io.out(
        JSON.stringify({
          sessionId: config.sessionId,
          recoveredDeadOwnerLock: true,
          inference: false,
          next: "Reconcile interrupted effects, then explicitly resume.",
        }),
      );
      return 0;
    }
    const env = Object.fromEntries(
      allowedEnvironment.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    );
    const codexOptions = {
      executable: config.executable,
      env,
      workspace: config.workspace,
      timeoutMs: config.timeoutMs ?? 30000,
      ...(config.reasoningEffort
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    };
    const oneShot = authorized
      ? createAuthorizedCodexSessionDispatch(
          codexOptions,
          authorized.outputSchemaPath,
          authorized.decision,
        )
      : undefined;
    const executor = oneShot?.executor ?? new CodexExecutor(codexOptions);
    const ports = await createWorkspaceSessionPorts({
      workspace: config.workspace,
      runId: config.runId,
      sessionId: config.sessionId,
      packages: config.packages,
      settings,
    });
    const session = new AgentSession(
      config.sessionId,
      store,
      ports,
      executor,
      {
        maxGenerations: authorized ? 1 : (config.maxGenerations ?? 4),
        timeoutMs: config.timeoutMs ?? 60000,
        maxOutputBytes: config.maxOutputBytes ?? 1_000_000,
      },
      oneShot?.dispatch,
    );
    const interrupt = () => {
      void session.cancel().catch(() => {});
    };
    if (command !== "inspect") {
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        await session.advance({
          resume: command === "resume",
          reconciledUnknownOutcome: remaining.length === 1,
        });
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
    io.out(JSON.stringify(await session.inspect()));
    return 0;
  } catch {
    // Never print raw official diagnostics, configuration content or model output.
    io.err(
      "Session operation did not complete. Check configuration, exact bindings and process-owned lock; inspect before retry.",
    );
    return 2;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runSessionCli(process.argv.slice(2));
