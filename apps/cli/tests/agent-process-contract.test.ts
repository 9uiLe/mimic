import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  executeOfficialProcess,
  type OfficialProcessRequest,
} from "../src/agent/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function request(source: string): Promise<OfficialProcessRequest> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "mimic-agent-process-"),
  );
  roots.push(workspace);
  return {
    executable: process.execPath,
    args: ["-e", source],
    workspace,
    env: {},
    timeoutMs: 2_000,
  };
}
test("uses literal argv, workspace, bounded stdin and explicit environment without a shell", async () => {
  const config = await request(
    "let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>console.log(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),text,key:process.env.OPENAI_API_KEY})))",
  );
  config.args = [
    ...config.args,
    "$(touch /tmp/mimic-must-not-run); `echo shell`",
  ];
  config.input = "evidence only";
  const result = await (await executeOfficialProcess(config)).result;
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    arg: config.args.at(-1),
    cwd: await import("node:fs/promises").then((fs) =>
      fs.realpath(config.workspace),
    ),
    text: "evidence only",
  });
});
test.each([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "ACCESS_TOKEN",
  "EXTRA_CREDIT_SECRET",
])("rejects credential environment %s", async (key) => {
  const config = await request("process.exit(0)");
  config.env = { [key]: "secret" };
  await expect(executeOfficialProcess(config)).rejects.toMatchObject({
    reason: "unsupported",
  });
});
test("rejects relative executable/cwd, invalid timeout/argv and nonexistent workspace", async () => {
  const config = await request("process.exit(0)");
  for (const mutation of [
    { executable: "node" },
    { executable: `${process.execPath}\0private-marker` },
    { workspace: "." },
    { workspace: path.join(config.workspace, "missing") },
    { timeoutMs: 0 },
    { args: ["bad\0arg"] },
    { maxOutputBytes: 0 },
  ])
    await expect(
      executeOfficialProcess({ ...config, ...mutation }),
    ).rejects.toMatchObject({ reason: "unsupported" });
});
test("timeout stops official process and hides raw diagnostics", async () => {
  const config = await request(
    "console.error('secret-token');setInterval(()=>{},1000)",
  );
  config.timeoutMs = 60;
  await expect(
    (await executeOfficialProcess(config)).result,
  ).rejects.toMatchObject({ reason: "timeout", message: "timeout" });
});
test("cancel is idempotent and waits for process closure", async () => {
  const config = await request("setInterval(()=>{},1000)");
  const handle = await executeOfficialProcess(config);
  const failure = expect(handle.result).rejects.toMatchObject({
    reason: "cancelled",
  });
  await Promise.all([handle.cancel(), handle.cancel()]);
  await failure;
});
test("oversized runtime output fails closed instead of reporting truncated success", async () => {
  const config = await request("console.log('x'.repeat(4096))");
  config.maxOutputBytes = 32;
  await expect(
    (await executeOfficialProcess(config)).result,
  ).rejects.toMatchObject({ reason: "unknown-outcome" });
});
test("spawn errors never expose executable errors or credentials", async () => {
  const config = await request("process.exit(0)");
  config.executable = path.join(config.workspace, "missing-secret-runtime");
  await expect(
    (await executeOfficialProcess(config)).result,
  ).rejects.toMatchObject({
    reason: "unknown-outcome",
    message: "unknown-outcome",
  });
});
test("nonzero exits remain protocol data for backend classification, not success", async () => {
  const config = await request(
    "console.error('quota-protocol');process.exit(7)",
  );
  const result = await (await executeOfficialProcess(config)).result;
  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("quota-protocol");
});

test("rejects endpoint overrides and oversized stdin before launch", async () => {
  const config = await request("process.exit(0)");
  await expect(
    executeOfficialProcess({
      ...config,
      env: { OPENAI_BASE_URL: "https://paid.invalid" },
    }),
  ).rejects.toMatchObject({ reason: "unsupported" });
  await expect(
    executeOfficialProcess({
      ...config,
      input: "x".repeat(16 * 1024 * 1024 + 1),
    }),
  ).rejects.toMatchObject({ reason: "unsupported" });
});

test("cancellation kills same-group descendants after the leader exits", async () => {
  const config = await request("process.exit(0)");
  const ready = path.join(config.workspace, "descendant-ready");
  const childSource = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  config.args = [
    "-e",
    `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
  ];
  const handle = await executeOfficialProcess(config);
  const failure = expect(handle.result).rejects.toMatchObject({
    reason: "cancelled",
  });
  let descendant: number | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        descendant = Number(await readFile(ready, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(descendant).toBeGreaterThan(0);
    await handle.cancel();
    await failure;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const processState = spawnSync(
      "ps",
      ["-o", "stat=", "-p", String(descendant)],
      { encoding: "utf8" },
    );
    // A zombie has terminated and is awaiting OS reap; a live descendant leaks.
    expect(processState.stdout.trim().replace(/^Z.*$/, "")).toBe("");
  } finally {
    await handle.cancel();
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        /* already terminated */
      }
    }
  }
});
