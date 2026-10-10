#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runHostAuthorizedSessionOnce } from "./authorized-host.js";
import {
  HostCreditAuthorizationStore,
  type RunCreditScope,
} from "./host-credit-authorization.js";

const privateStore = () =>
  new HostCreditAuthorizationStore(
    path.join(
      os.homedir(),
      ".local",
      "share",
      "mimic",
      "credit-authorizations",
    ),
  );

async function authorize(
  configPath: string,
  callCount: string,
  minutesText: string,
  executable: string,
): Promise<number> {
  // This is a cooperative local confirmation, not OS proof of a person's identity.
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("Run authorization requires a directly operated terminal");
  const maxCalls = Number(callCount);
  const minutes = Number(minutesText);
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 20 ||
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > 1440
  )
    throw Error("Invalid call count or duration");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workspace: string;
    runId: string;
    model: string;
    packages: Record<string, string>;
  };
  const scope: RunCreditScope = {
    workspace: config.workspace,
    runId: config.runId,
    model: config.model,
    executable,
    packages: config.packages,
    maxCalls,
    expiresAt: Date.now() + minutes * 60_000,
  };
  const grantId = await privateStore().record(scope, {
    requestDecision: async (frozen) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            workspace: frozen.workspace,
            runId: frozen.runId,
            model: frozen.model,
            executable: frozen.executable,
            maxCalls: frozen.maxCalls,
            expiresAt: new Date(frozen.expiresAt).toISOString(),
            packages: frozen.packages,
            inputsSha256: frozen.inputsSha256,
            risk: "The official Codex subscription may consume existing credits. No purchase or billing setting changes are authorized.",
          },
          null,
          2,
        )}\n`,
      );
      const phrase = `AUTHORIZE ${frozen.runId} ${frozen.inputsSha256.slice(0, 12)}`;
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await terminal.question(
          `Type ${JSON.stringify(phrase)} to authorize: `,
        );
        if (answer !== phrase) return null;
      } finally {
        terminal.close();
      }
      return {
        decisionId: `human_${randomUUID().replaceAll("-", "")}`,
        actorId: os.userInfo().username,
        approvedAt: Date.now(),
      };
    },
  });
  process.stdout.write(`${JSON.stringify({ grantId, runId: scope.runId })}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "authorize" && argv.length === 5)
      return await authorize(argv[1]!, argv[2]!, argv[3]!, argv[4]!);
    if (argv[0] === "run" && argv.length === 3) {
      const config = JSON.parse(await readFile(argv[1]!, "utf8")) as {
        workspace: string;
      };
      const authorization = privateStore();
      const executable = await authorization.executableFor(
        argv[2]!,
        config.workspace,
      );
      return await runHostAuthorizedSessionOnce(
        argv[1]!,
        executable,
        argv[2]!,
        authorization,
      );
    }
    throw Error(
      "Usage: host-credit-cli authorize <config> <max-calls> <minutes> <official-codex-path> | run <config> <grant-id>",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Host authorization failed"}\n`,
    );
    return 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main(process.argv.slice(2));
