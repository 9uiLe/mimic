import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicCreateJson } from "../atomic-file.js";
import { runAuthorizedSessionOnce } from "./session-main.js";
import { FileSessionStore } from "./session.js";
import { createWorkspaceSessionPorts } from "./session-workspace.js";
import {
  frozenRunInputsSha256,
  HostCreditAuthorizationStore,
} from "./host-credit-authorization.js";

interface HostSessionConfig {
  workspace: string;
  runId: string;
  sessionId: string;
  model: string;
  packages: Record<string, string>;
}

async function stageOutputSchema(workspace: string): Promise<string> {
  const installed = await realpath(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../schemas/agent/codex-submission-output.schema.json",
    ),
  );
  const trusted = await open(
    installed,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let schema: unknown;
  try {
    if ((await trusted.stat()).size > 1024 * 1024)
      throw Error("Invalid installed output schema");
    schema = JSON.parse(await trusted.readFile("utf8")) as unknown;
  } finally {
    await trusted.close();
  }
  const folder = path.join(workspace, ".mimic", "agent-schema");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await realpath(folder)) !== folder)
    throw Error("Output schema directory escapes workspace");
  const schemaDigest = createHash("sha256")
    .update(JSON.stringify(schema))
    .digest("hex");
  const target = path.join(
    folder,
    `codex-submission-output-${schemaDigest}.schema.json`,
  );
  await atomicCreateJson(target, schema);
  const staged = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (
      !(await staged.stat()).isFile() ||
      (await staged.stat()).size > 1024 * 1024 ||
      JSON.stringify(JSON.parse(await staged.readFile("utf8"))) !==
        JSON.stringify(schema)
    )
      throw Error("Workspace output schema differs from installed schema");
  } finally {
    await staged.close();
  }
  return target;
}

/** Trusted application entry. It reads the same frozen task and prompt as the
 * dispatcher, then binds the user's Run grant to precisely that one call. */
export async function runHostAuthorizedSessionOnce(
  configPath: string,
  trustedExecutable: string,
  grantId: string,
  authorization: HostCreditAuthorizationStore,
  io: { out(value: string): void; err(value: string): void } = {
    out: console.log,
    err: console.error,
  },
): Promise<number> {
  const file = await realpath(configPath);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: HostSessionConfig;
  try {
    if ((await handle.stat()).size > 64 * 1024)
      throw Error("Invalid session config");
    config = JSON.parse(await handle.readFile("utf8")) as HostSessionConfig;
  } finally {
    await handle.close();
  }
  if (
    !config ||
    typeof config.workspace !== "string" ||
    typeof config.runId !== "string" ||
    typeof config.sessionId !== "string" ||
    typeof config.model !== "string" ||
    !config.packages ||
    typeof config.packages !== "object"
  )
    throw Error("Invalid host session config");
  const workspace = await realpath(config.workspace);
  if (config.workspace !== workspace)
    throw Error("Host session workspace must use its canonical path");
  const executable = await realpath(trustedExecutable);
  if (
    !(await stat(executable)).isFile() ||
    executable === workspace ||
    executable.startsWith(`${workspace}${path.sep}`)
  )
    throw Error("Trusted Codex executable is not a regular file");
  if (!file.startsWith(`${workspace}${path.sep}`))
    throw Error("Host session config must be inside its workspace");
  const existing = await new FileSessionStore(workspace).read(config.sessionId);
  if (existing) throw Error("Authorized generation requires a new session ID");
  const schemaPath = await stageOutputSchema(workspace);
  const ports = await createWorkspaceSessionPorts({
    workspace,
    runId: config.runId,
    sessionId: config.sessionId,
    packages: config.packages,
    settings: {
      provider: "codex",
      model: config.model,
      billingMode: "subscription-only",
    },
  });
  const task = (await ports.next()).runnable[0];
  if (!task) throw Error("No safe unfinished task to authorize");
  const expected = {
    requestId: `${config.sessionId}-1`,
    model: config.model,
    workspace,
    promptSha256: createHash("sha256").update(task.prompt).digest("hex"),
  };
  const inputsSha256 = await frozenRunInputsSha256(
    workspace,
    config.runId,
    config.packages,
  );
  return runAuthorizedSessionOnce(
    file,
    schemaPath,
    authorization.port(
      grantId,
      config.runId,
      expected,
      inputsSha256,
      config.packages,
      executable,
    ),
    io,
    executable,
  );
}
