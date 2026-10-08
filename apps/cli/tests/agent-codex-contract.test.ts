import { afterEach, expect, test, vi } from "vitest";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest, type ArtifactSnapshot } from "@mimic/core";
import { dispatchCli } from "../src/entry.js";
import {
  CodexExecutor,
  createCodexGenerationProfile,
  prepareCodexSubmission,
  CodexJsonlDecoder,
  inspectCodex,
  parseCodexWorkEnvelope,
  executeOfficialProcess,
  startExecution,
  type CodexOptions,
  type ExecutorEvent,
} from "../src/agent/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fakeCodex(
  login = "Logged in using ChatGPT",
  version = "0.160.0",
): Promise<CodexOptions> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "mimic-codex-contract-"),
  );
  roots.push(workspace);
  const executable = path.join(workspace, "fake-official-cli");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(workspace, "calls.jsonl"))},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='--version')console.log(${JSON.stringify(`codex-cli ${version}`)});else if(process.argv.slice(2).join(' ')==='login status')console.error(${JSON.stringify(login)});else { console.error('must not launch inference');process.exit(99); }\n`,
  );
  await chmod(executable, 0o700);
  return { executable, workspace, env: {}, timeoutMs: 2_000 };
}
const request = (workspace: string) => ({
  requestId: "req_168",
  workspace,
  prompt: "Generate candidate work only",
  settings: {
    provider: "codex" as const,
    billingMode: "subscription-only" as const,
    model: "unverified-model",
  },
});
async function calls(options: CodexOptions) {
  return (await readFile(path.join(options.workspace, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function events(handle: { events: AsyncIterable<ExecutorEvent> }) {
  return Array.fromAsync(handle.events);
}
const envelope = { artifacts: [], work: { result: { outputs: [] } } };
const final = JSON.stringify(envelope);
const protocol = (output = final) =>
  [
    { type: "thread.started", thread_id: "thread-test" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "reason", type: "reasoning", text: "private reasoning" },
    },
    {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: output },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

test("read-only official version/login probes redact raw streams and never infer model entitlement", async () => {
  const options = await fakeCodex();
  expect(await inspectCodex(options)).toEqual({
    runtimeVersion: "0.160.0",
    authentication: "chatgpt",
    billingEnforcement: "unconfirmed",
    modelEntitlement: "unconfirmed",
  });
  expect(await calls(options)).toEqual([["--version"], ["login", "status"]]);
});

test("ChatGPT login stops billing-unconfirmed without exec, tokens, fallback or session writes", async () => {
  const options = await fakeCodex();
  const executor = new CodexExecutor(options);
  expect(await executor.describe()).toMatchObject({
    provider: "codex",
    runtimeVersion: "0.160.0",
    capabilities: { nativeResume: false, toolRestriction: false },
    entitlement: { status: "unconfirmed", reason: "billing" },
  });
  expect(
    await events(await startExecution(executor, request(options.workspace))),
  ).toEqual([
    {
      type: "stopped",
      reason: "billing-unconfirmed",
      resumeCondition: "verify-subscription-only",
    },
  ]);
  await expect(
    executor.start(request(options.workspace)),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
  await expect(
    executor.resume({
      ...request(options.workspace),
      sessionId: "thread-test",
    }),
  ).rejects.toMatchObject({ reason: "unsupported" });
  expect(
    (await calls(options)).every(
      (argv: string[]) =>
        argv[0] === "--version" || argv.join(" ") === "login status",
    ),
  ).toBe(true);
});

test.each([
  "Logged in using an API key - sk-private-marker",
  "Not logged in",
  "unknown secret-token account@example.invalid",
])("rejects non-ChatGPT authentication without exposing %s", async (login) => {
  const options = await fakeCodex(login);
  const result = await events(
    await startExecution(
      new CodexExecutor(options),
      request(options.workspace),
    ),
  );
  expect(result).toEqual([
    {
      type: "stopped",
      reason: "authentication",
      resumeCondition: "official-login",
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("private-marker");
  expect(JSON.stringify(result)).not.toContain("account@");
});

test("unknown official versions and provider mismatch stop unsupported", async () => {
  const options = await fakeCodex("Logged in using ChatGPT", "0.161.0");
  expect(
    await events(
      await startExecution(
        new CodexExecutor(options),
        request(options.workspace),
      ),
    ),
  ).toMatchObject([{ reason: "unsupported" }]);
  await expect(
    new CodexExecutor(options).start({
      ...request(options.workspace),
      settings: { provider: "claude", billingMode: "subscription-only" },
    }),
  ).rejects.toMatchObject({ reason: "unsupported" });
});

test("API/endpoint env injection and arbitrary billing attestation cannot unlock the adapter", async () => {
  const options = await fakeCodex();
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"])
    expect(
      await events(
        await startExecution(
          new CodexExecutor({ ...options, env: { [key]: "secret" } }),
          request(options.workspace),
        ),
      ),
    ).toMatchObject([{ reason: "unsupported" }]);
  await expect(
    new CodexExecutor(options).start({
      ...request(options.workspace),
      settings: {
        ...request(options.workspace).settings,
        billingEvidence: "official-runtime",
      } as never,
    }),
  ).rejects.toMatchObject({ reason: "unsupported", message: "unsupported" });
  await expect(
    readFile(path.join(options.workspace, "calls.jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("JSONL decoder preserves UTF-8 across every byte boundary and withholds completion until exit", () => {
  const output = JSON.stringify({
    ...envelope,
    work: { result: { outputs: [], text: "日本語" } },
  });
  const decoder = new CodexJsonlDecoder("req_168");
  const emitted = [...Buffer.from(protocol(output))].flatMap((byte) =>
    decoder.push(Buffer.from([byte])),
  );
  expect(emitted).toEqual([
    { type: "started", requestId: "req_168" },
    { type: "output", text: output },
  ]);
  expect(decoder.finish(0)).toEqual([{ type: "completed", output }]);
  expect(() => decoder.push(Buffer.from("\n"))).toThrow("unknown-outcome");
});

test("fake official CLI stdout drives incremental protocol decoding before process completion", async () => {
  const options = await fakeCodex();
  const decoder = new CodexJsonlDecoder("req_168");
  const received: ExecutorEvent[] = [];
  const handle = await executeOfficialProcess({
    executable: process.execPath,
    args: [
      "-e",
      `const data=${JSON.stringify(protocol())};let n=0;const timer=setInterval(()=>{if(n<data.length){process.stdout.write(data.slice(n,n+3));n+=3;}else{clearInterval(timer)}},1)`,
    ],
    workspace: options.workspace,
    env: {},
    timeoutMs: 2_000,
    onStdout: (chunk) => received.push(...decoder.push(chunk)),
  });
  const result = await handle.result;
  expect(received).toEqual([
    { type: "started", requestId: "req_168" },
    { type: "output", text: final },
  ]);
  expect(decoder.finish(result.exitCode)).toEqual([
    { type: "completed", output: final },
  ]);
});

test.each([
  {
    type: "turn.failed",
    error: { message: "Usage limit reached secret-token" },
  },
  { type: "error", message: "insufficient_quota secret-token" },
])(
  "quota failure is normalized and never exposes diagnostic messages",
  (failure) => {
    const decoder = new CodexJsonlDecoder("req_168");
    const prefix =
      JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n";
    decoder.push(Buffer.from(prefix + JSON.stringify(failure) + "\n"));
    expect(decoder.finish(1)).toEqual([
      {
        type: "stopped",
        reason: "quota",
        resumeCondition: "explicit-backend-switch-or-quota-restored",
      },
    ]);
  },
);

test("auth failure before a turn still yields ordered started/stopped, with no raw token", () => {
  const decoder = new CodexJsonlDecoder("req_168");
  expect(
    decoder.push(
      Buffer.from(
        JSON.stringify({
          type: "error",
          message: "401 token expired secret-token",
        }) + "\n",
      ),
    ),
  ).toEqual([{ type: "started", requestId: "req_168" }]);
  expect(decoder.finish(1)).toEqual([
    {
      type: "stopped",
      reason: "authentication",
      resumeCondition: "official-login",
    },
  ]);
});

test.each([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "future_tool",
])("tool protocol %s fails closed instead of being dispatched", (type) => {
  const decoder = new CodexJsonlDecoder("req_168");
  decoder.push(
    Buffer.from(protocol().split("\n").slice(0, 2).join("\n") + "\n"),
  );
  expect(() =>
    decoder.push(
      Buffer.from(
        JSON.stringify({
          type: "item.started",
          item: { id: "tool", type, text: "untrusted" },
        }) + "\n",
      ),
    ),
  ).toThrow("unknown-outcome");
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

test.each([
  protocol() + '{"type":"turn.started"}\n',
  protocol().replace('"thread.started"', '"future.event"'),
  protocol("```json\n{}\n```"),
  protocol('{"artifacts":[],"work":{"result":{}},"approval":"yes"}'),
  protocol().replace('"turn.completed"', '"turn.failed"'),
  '{"type":"thread.started","thread_id":"t"}\n',
])(
  "malformed, partial, extra and invalid work output cannot complete",
  (wire) => {
    const decoder = new CodexJsonlDecoder("req_168");
    try {
      decoder.push(Buffer.from(wire));
    } catch {
      /* expected fail closed */
    }
    expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
  },
);

test("nonzero exit invalidates completed protocol, and missing newline is handled", () => {
  for (const exit of [0, 1]) {
    const decoder = new CodexJsonlDecoder("req_168");
    decoder.push(Buffer.from(protocol().trimEnd()));
    expect(decoder.finish(exit)).toMatchObject(
      exit === 0
        ? [{ type: "completed", output: final }]
        : [{ reason: "unknown-outcome" }],
    );
  }
});

test("invalid UTF-8 and oversized protocol fail without truncated success", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from("x".repeat(33))]) {
    const decoder = new CodexJsonlDecoder("req_168", 32);
    expect(() => decoder.push(bytes)).toThrow("unknown-outcome");
    expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
  }
});

test("envelope validation does not fabricate Core validation or mutate candidate data", () => {
  expect(parseCodexWorkEnvelope(final)).toEqual(envelope);
  for (const value of [
    "{}",
    '{"artifacts":[],"work":{}}',
    '{"artifacts":[null],"work":{"result":{}}}',
  ])
    expect(() => parseCodexWorkEnvelope(value)).toThrow("unknown-outcome");
});

test("stream callback is bounded, immutable relative to collection, and fails with process cleanup", async () => {
  const options = await fakeCodex();
  let callback = false;
  const oversized = await executeOfficialProcess({
    executable: process.execPath,
    args: ["-e", "console.log('x'.repeat(64))"],
    workspace: options.workspace,
    env: {},
    timeoutMs: 2_000,
    maxOutputBytes: 8,
    onStdout: () => {
      callback = true;
    },
  });
  await expect(oversized.result).rejects.toMatchObject({
    reason: "unknown-outcome",
  });
  expect(callback).toBe(false);
  const normal = await executeOfficialProcess({
    executable: process.execPath,
    args: ["-e", "console.log('original')"],
    workspace: options.workspace,
    env: {},
    timeoutMs: 2_000,
    onStdout: (chunk) => chunk.fill(0),
  });
  expect((await normal.result).stdout).toBe("original\n");
  const failed = await executeOfficialProcess({
    executable: process.execPath,
    args: ["-e", "console.log('start');setInterval(()=>{},1000)"],
    workspace: options.workspace,
    env: {},
    timeoutMs: 2_000,
    onStdout: () => {
      throw new Error("private-marker");
    },
  });
  await expect(failed.result).rejects.toMatchObject({
    reason: "unknown-outcome",
    message: "unknown-outcome",
  });
});

test.each(["cancelled", "timeout"])(
  "fake CLI %s cannot produce a completed candidate",
  async (reason) => {
    const options = await fakeCodex();
    const decoder = new CodexJsonlDecoder("req_168");
    const handle = await executeOfficialProcess({
      executable: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(protocol())});setInterval(()=>{},1000)`,
      ],
      workspace: options.workspace,
      env: {},
      timeoutMs: reason === "timeout" ? 150 : 2_000,
      onStdout: (chunk) => decoder.push(chunk),
    });
    const failure = expect(handle.result).rejects.toMatchObject({ reason });
    if (reason === "cancelled") await handle.cancel();
    await failure;
    // Callers must honor process rejection; JSONL terminal alone is not success.
  },
);

test.each([
  {},
  {
    input_tokens: "bad",
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  },
  {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: -1,
    reasoning_output_tokens: 0,
  },
  {
    input_tokens: Number.MAX_SAFE_INTEGER + 1,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  },
  {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    cache_write_input_tokens: -1,
  },
])("malformed official usage cannot publish completed output", (usage) => {
  const decoder = new CodexJsonlDecoder("req_168");
  const wire = protocol().trim().split("\n");
  wire[wire.length - 1] = JSON.stringify({ type: "turn.completed", usage });
  expect(() => decoder.push(Buffer.from(wire.join("\n") + "\n"))).toThrow(
    "unknown-outcome",
  );
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

test.each([
  [
    ["item.started", "agent_message"],
    ["item.completed", "reasoning"],
    ["item.completed", "agent_message"],
  ],
  [
    ["item.completed", "reasoning"],
    ["item.completed", "reasoning"],
  ],
  [
    ["item.completed", "reasoning"],
    ["item.updated", "reasoning"],
  ],
  [
    ["item.started", "reasoning"],
    ["item.started", "reasoning"],
  ],
  [["item.updated", "reasoning"]],
])("inconsistent item identity/lifecycle fails closed", (sequence) => {
  const decoder = new CodexJsonlDecoder("req_168");
  decoder.push(
    Buffer.from(protocol().split("\n").slice(0, 2).join("\n") + "\n"),
  );
  const wire =
    sequence
      .map(([type, itemType]) =>
        JSON.stringify({
          type,
          item: { id: "same", type: itemType, text: final },
        }),
      )
      .join("\n") + "\n";
  expect(() => decoder.push(Buffer.from(wire))).toThrow("unknown-outcome");
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

test("valid started/updated/completed item lifecycle and explicit cache-write usage are accepted", () => {
  const decoder = new CodexJsonlDecoder("req_168");
  const wire = protocol().trim().split("\n");
  wire.splice(
    3,
    0,
    JSON.stringify({
      type: "item.started",
      item: { id: "answer", type: "agent_message", text: "" },
    }),
    JSON.stringify({
      type: "item.updated",
      item: { id: "answer", type: "agent_message", text: final },
    }),
  );
  wire[wire.length - 1] = JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      cache_write_input_tokens: 0,
    },
  });
  decoder.push(Buffer.from(wire.join("\n") + "\n"));
  expect(decoder.finish(0)).toEqual([{ type: "completed", output: final }]);
});

test("turn completion rejects an unfinished tracked item even when the answer completed", () => {
  const decoder = new CodexJsonlDecoder("req_168");
  const wire = protocol().trim().split("\n");
  wire.splice(
    2,
    0,
    JSON.stringify({
      type: "item.started",
      item: { id: "unfinished", type: "reasoning", text: "pending" },
    }),
  );
  expect(() => decoder.push(Buffer.from(wire.join("\n") + "\n"))).toThrow(
    "unknown-outcome",
  );
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

async function schema(options: CodexOptions) {
  const schemaPath = path.join(options.workspace, "output-schema.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object" }));
  return schemaPath;
}

test("fixed official fresh-turn profile uses stdin, Standard and native-login environment without granting dispatch", async () => {
  const options = await fakeCodex();
  const input = {
    ...request(options.workspace),
    prompt: "Literal $(touch forbidden) `echo shell` evidence",
  };
  const profile = await createCodexGenerationProfile(
    options,
    input,
    await schema(options),
  );
  expect(profile).toMatchObject({
    mode: "fresh",
    nativeResume: false,
    toolRestriction: false,
    process: {
      executable: options.executable,
      env: {},
      input: input.prompt,
      timeoutMs: 2_000,
    },
  });
  const args = profile.process.args;
  expect(args.slice(0, 14)).toEqual([
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--strict-config",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "--model",
    "unverified-model",
    "--output-schema",
  ]);
  expect(args.at(-1)).toBe("-");
  expect(args).not.toContain("--last");
  expect(args).not.toContain("resume");
  const controls = args.filter((arg, index) => args[index - 1] === "--config");
  expect(controls).toEqual(
    expect.arrayContaining([
      'forced_login_method="chatgpt"',
      'model_provider="openai"',
      'service_tier="default"',
      'approval_policy="never"',
      'web_search="disabled"',
      'shell_environment_policy.inherit="none"',
      "tools.update_plan.enabled=false",
      "tools.experimental_request_user_input.enabled=false",
    ]),
  );
  const disabled = args.filter((arg, index) => args[index - 1] === "--disable");
  expect(disabled).toEqual(
    expect.arrayContaining([
      "shell_tool",
      "unified_exec",
      "hooks",
      "apps",
      "plugins",
      "multi_agent",
      "fast_mode",
      "memories",
      "unbounded_connection_retries",
    ]),
  );
  await expect(
    readFile(path.join(options.workspace, "calls.jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(new CodexExecutor(options).start(input)).rejects.toMatchObject({
    reason: "billing-unconfirmed",
  });
});

test.each([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "CHATGPT_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NODE_OPTIONS",
  "HTTPS_PROXY",
])(
  "profile rejects ambient API, provider, process and proxy override %s before launch",
  async (key) => {
    const options = await fakeCodex();
    await expect(
      createCodexGenerationProfile(
        { ...options, env: { [key]: "private-marker" } },
        request(options.workspace),
        await schema(options),
      ),
    ).rejects.toMatchObject({ reason: "unsupported", message: "unsupported" });
    await expect(
      readFile(path.join(options.workspace, "calls.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("profile rejects arbitrary argv, model flags, long budgets, external schema/cwd and escaping symlinks", async () => {
  const options = await fakeCodex();
  const outside = await fakeCodex();
  const schemaPath = await schema(options);
  const outsideSchema = await schema(outside);
  await symlink(
    outsideSchema,
    path.join(options.workspace, "outside-schema.json"),
  );
  for (const mutation of [
    { ...options, args: ["--oss"] },
    { ...options, timeoutMs: 60_001 },
    { ...options, env: { HOME: "relative" } },
    { ...options, workspace: outside.workspace },
  ])
    await expect(
      createCodexGenerationProfile(
        mutation,
        request(options.workspace),
        schemaPath,
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
  for (const invalid of [
    outsideSchema,
    "outside-schema.json",
    "missing.json",
    ".",
  ])
    await expect(
      createCodexGenerationProfile(
        options,
        request(options.workspace),
        invalid,
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
  for (const invalid of [
    { ...request(options.workspace), prompt: "x".repeat(64 * 1024 + 1) },
    {
      ...request(options.workspace),
      settings: {
        provider: "codex" as const,
        billingMode: "subscription-only" as const,
        model: "--oss",
      },
    },
  ])
    await expect(
      createCodexGenerationProfile(options, invalid, schemaPath),
    ).rejects.toMatchObject({ reason: "unsupported" });
});

test("explicit fake official subprocess validates profile controls, literal input and emits structured candidate JSONL", async () => {
  const options = await fakeCodex();
  const output = JSON.stringify({
    artifacts: [],
    work: { result: { runId: "run_fake", taskId: "task_fake", outputs: [] } },
  });
  await writeFile(
    options.executable,
    `#!${process.execPath}\nconst argv=process.argv.slice(2);const needed=['forced_login_method="chatgpt"','model_provider="openai"','service_tier="default"','approval_policy="never"'];if(argv[0]!=='exec'||!needed.every(v=>argv.includes(v))||!argv.includes('--ephemeral')||argv.includes('--last')||process.env.OPENAI_API_KEY){process.exit(99)}let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{if(input!=='literal $(shell)'){process.exit(98)}process.stdout.write(${JSON.stringify(protocol(output))})});\n`,
  );
  const profile = await createCodexGenerationProfile(
    options,
    { ...request(options.workspace), prompt: "literal $(shell)" },
    await schema(options),
  );
  const decoder = new CodexJsonlDecoder("req_168");
  const received: ExecutorEvent[] = [];
  const result = await (
    await executeOfficialProcess({
      ...profile.process,
      onStdout: (chunk) => received.push(...decoder.push(chunk)),
    })
  ).result;
  expect(result.exitCode).toBe(0);
  expect(received).toEqual([
    { type: "started", requestId: "req_168" },
    { type: "output", text: output },
  ]);
  const completed = decoder.finish(result.exitCode);
  expect(completed).toEqual([{ type: "completed", output }]);
  const handoff = prepareCodexSubmission({
    output,
    runId: "run_fake",
    taskId: "task_fake",
    packagePath: "skill",
    workPath: "work.json",
    workspace: options.workspace,
  });
  expect(handoff.argv).toEqual([
    "submit",
    "run_fake",
    "--task",
    "task_fake",
    "--package",
    "skill",
    "--work",
    "work.json",
    "--root",
    options.workspace,
    "--json",
  ]);
  expect(JSON.parse(handoff.serializedWork)).toEqual(JSON.parse(output));
});

test("static handoff rejects identity changes, CLI-incompatible IDs, escaping paths and hidden host authority", async () => {
  const options = await fakeCodex();
  const input = {
    output: JSON.stringify({
      artifacts: [],
      work: { result: { runId: "run_bound", taskId: "task_bound" } },
    }),
    runId: "run_bound",
    taskId: "task_bound",
    packagePath: "skill",
    workPath: "work.json",
    workspace: options.workspace,
  };
  for (const mutation of [
    { runId: "other" },
    { taskId: "other" },
    { runId: "0numeric" },
    { runId: "dot.id" },
    { runId: "a".repeat(81) },
    { packagePath: "../outside" },
    { workPath: "--host" },
    { workspace: "." },
  ])
    expect(() => prepareCodexSubmission({ ...input, ...mutation })).toThrow();
  expect(() =>
    prepareCodexSubmission({
      ...input,
      output: JSON.stringify({
        artifacts: [],
        work: { result: { runId: "run_bound", taskId: "task_bound" } },
        executeSkill: "bypass",
      }),
    }),
  ).toThrow("unknown-outcome");
});

test("decoded candidate uses production static Skill submit with immutable retry/conflict and pending human decision", async () => {
  const options = await fakeCodex();
  const workspace = options.workspace;
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await dispatchCli(["init", "--root", workspace, "--json"])).toBe(0);
  await cp(
    path.join(repo, "fixtures/skill-runtime/demo"),
    path.join(workspace, "skill"),
    { recursive: true },
  );
  const task = {
    id: "task_adapter",
    skillId: "mimic.runtime.demo",
    outputType: "product-definition",
    scopeOwnerId: "org_local",
    intent: "create",
    authority: "PROPOSE_ONLY",
    humanBrief: "Bounded fake-model fixture",
    proposalIds: ["proposal_adapter"],
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }],
      optional: [{ name: "research", kind: "evidence-file" }],
      alternatives: [
        {
          oneOf: [
            {
              name: "existing-definition",
              kind: "artifact",
              artifactType: "product-definition",
              schemaVersion: "1.0.0",
            },
            { name: "context-brief", kind: "human-brief" },
          ],
        },
      ],
    },
  };
  await writeFile(path.join(workspace, "tasks.json"), JSON.stringify([task]));
  expect(
    await dispatchCli([
      "run",
      "--root",
      workspace,
      "--tasks",
      "tasks.json",
      "--id",
      "run_adapter",
      "--json",
    ]),
  ).toBe(0);
  const fixture = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const candidate: ArtifactSnapshot = {
    ...fixture,
    meta: { ...fixture.meta, id: "art_adapter" },
    scope: { level: "organization", ownerId: "org_local" },
    lifecycle: { status: "proposed", freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: task.skillId,
      runId: "run_adapter",
      createdAt: "2026-10-06T12:00:00Z",
    },
  };
  const ref = {
    artifactId: candidate.meta.id,
    revision: candidate.meta.revision,
    lockDigest: artifactDigest(candidate),
  };
  const work = {
    artifacts: [candidate],
    work: {
      result: {
        runId: "run_adapter",
        taskId: task.id,
        skillId: task.skillId,
        inputRefs: [],
        outputRefs: [ref],
        proposal: {
          packetId: "packet_adapter",
          reason: "Human review",
          items: [
            {
              id: "proposal_adapter",
              ref,
              alternatives: ["approve", "reject"],
              rationale: "Review exact candidate",
              evidenceLimits: [],
              dependents: [],
            },
          ],
        },
      },
    },
  };
  const decoder = new CodexJsonlDecoder("req_168");
  decoder.push(Buffer.from(protocol(JSON.stringify(work))));
  const terminal = decoder.finish(0)[0];
  expect(terminal.type).toBe("completed");
  const handoff = prepareCodexSubmission({
    output: terminal.type === "completed" ? terminal.output : "",
    runId: "run_adapter",
    taskId: task.id,
    packagePath: "skill",
    workPath: "work.json",
    workspace,
  });
  // Only the test's host saves bytes here;168 helper neither saves nor approves.
  await writeFile(path.join(workspace, "work.json"), handoff.serializedWork);
  expect(await dispatchCli(handoff.argv)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
    submissionState: "accepted",
    packetIds: ["packet_adapter"],
    actions: [{ action: "REQUEST_DECISION" }],
  });
  expect(await dispatchCli(handoff.argv)).toBe(0);
  const stateFile = path.join(workspace, ".mimic/workspace.json");
  const accepted = await readFile(stateFile, "utf8");
  await writeFile(
    path.join(workspace, "work.json"),
    JSON.stringify({ ...work, work: { ...work.work, unknowns: [] } }),
  );
  expect(await dispatchCli(handoff.argv)).toBe(5);
  expect(await readFile(stateFile, "utf8")).toBe(accepted);
  expect(await dispatchCli(["status", "--root", workspace, "--json"])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
    canonical: [],
  });
  const outside = await fakeCodex();
  await writeFile(
    path.join(outside.workspace, "external-work.json"),
    handoff.serializedWork,
  );
  await symlink(
    path.join(outside.workspace, "external-work.json"),
    path.join(workspace, "external-link.json"),
  );
  const escaped = prepareCodexSubmission({
    output: JSON.stringify(work),
    runId: "run_adapter",
    taskId: task.id,
    packagePath: "skill",
    workPath: "external-link.json",
    workspace,
  });
  expect(await dispatchCli(escaped.argv)).toBe(3);
  expect(await readFile(stateFile, "utf8")).toBe(accepted);
});
