import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CodexExecutor,
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
