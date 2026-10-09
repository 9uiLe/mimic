import { afterEach, expect, test, vi } from "vitest";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
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
import * as processModule from "../src/agent/process.js";
import {
  CodexExecutor,
  createCodexCreditRiskPermit,
  inspectCodexGenerationSafety,
  type CodexCreditRiskDecisionPort,
  type CodexCreditRiskPermit,
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
test("longer generation deadline retains bounded metadata probes", async () => {
  const options = await fakeCodex();
  options.timeoutMs = 45_000;
  const execute = vi.spyOn(processModule, "executeOfficialProcess");
  expect((await inspectCodex(options)).authentication).toBe("chatgpt");
  expect(execute.mock.calls).toHaveLength(2);
  expect(execute.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
    10_000, 10_000,
  ]);
  await writeFile(path.join(options.workspace, "output-schema.json"), "{}");
  const profile = await createCodexGenerationProfile(
    options,
    request(options.workspace),
    "output-schema.json",
  );
  expect(profile.process.timeoutMs).toBe(45_000);
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

// Official rust-v0.160.0 collect_warning/DeprecationNotice wire shape.
const warning = (message = "private configuration warning", id = "item_0") => ({
  type: "item.completed",
  item: { id, type: "error", message },
});
const withWarning = (position: number, notice = warning()) => {
  const lines = protocol().trimEnd().split("\n");
  lines.splice(position, 0, JSON.stringify(notice));
  return lines.join("\n") + "\n";
};
test.each([1, 2])(
  "official completed warning at position %i does not replace turn/output/terminal validation",
  (position) => {
    const decoder = new CodexJsonlDecoder("req_168");
    expect(decoder.push(Buffer.from(withWarning(position)))).toEqual([
      { type: "started", requestId: "req_168" },
      { type: "output", text: final },
    ]);
    expect(decoder.finish(0)).toEqual([{ type: "completed", output: final }]);
    expect(JSON.stringify(decoder.diagnostics())).not.toContain("private");
  },
);

test.each([1, 2])(
  "official warning survives the production fake-process adapter at position %i",
  async (position) => {
    const options = await fakeCodex();
    await fakeRuntime(options, undefined, { wire: withWarning(position) });
    const input = request(options.workspace);
    const permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const executor = new CodexExecutor(options);
    const handle = await executor.startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    );
    expect(await events(handle)).toEqual([
      { type: "started", requestId: input.requestId },
      { type: "output", text: final },
      { type: "completed", output: final },
    ]);
    expect(handle.diagnostics?.()).toMatchObject({
      backendReach: "unknown",
      process: { settled: true, exitCode: 0, failure: "none" },
      decoder: {
        threadStarted: true,
        turnStarted: true,
        outputObserved: true,
        terminalObserved: true,
        finished: true,
        failed: false,
        failure: "none",
      },
    });
    expect(JSON.stringify(handle.diagnostics?.())).not.toContain("private");
  },
);

test.each(["item.started", "item.updated"])(
  "warning %s remains rejected after turn start",
  (type) => {
    const decoder = new CodexJsonlDecoder("req_168");
    expect(() =>
      decoder.push(Buffer.from(withWarning(2, { ...warning(), type }))),
    ).toThrow("unknown-outcome");
    expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
  },
);

test("warning cannot complete or overwrite an unfinished text item ID", () => {
  const decoder = new CodexJsonlDecoder("req_168");
  decoder.push(
    Buffer.from(protocol().split("\n").slice(0, 2).join("\n") + "\n"),
  );
  decoder.push(
    Buffer.from(
      JSON.stringify({
        type: "item.started",
        item: { id: "same", type: "reasoning", text: "private reasoning" },
      }) + "\n",
    ),
  );
  expect(() =>
    decoder.push(
      Buffer.from(JSON.stringify(warning(undefined, "same")) + "\n"),
    ),
  ).toThrow("unknown-outcome");
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

test.each([
  { type: "item.started", item: warning().item },
  { type: "item.updated", item: warning().item },
  { ...warning(), privateKey: "private-value" },
  {
    type: "item.completed",
    item: { ...warning().item, text: "private-value" },
  },
  { type: "item.completed", item: { id: "item_0", type: "error" } },
  { type: "item.completed", item: { ...warning().item, id: " " } },
  { type: "item.completed", item: { ...warning().item, message: {} } },
  {
    type: "item.completed",
    item: { ...warning().item, type: "private-unknown" },
  },
  { type: "private-event", item: warning().item },
])("warning compatibility rejects malformed/unknown event %j", (notice) => {
  const decoder = new CodexJsonlDecoder("req_168");
  expect(() =>
    decoder.push(
      Buffer.from(withWarning(1, notice as ReturnType<typeof warning>)),
    ),
  ).toThrow("unknown-outcome");
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
  expect(JSON.stringify(decoder.diagnostics())).not.toMatch(/private/);
});

test.each([
  JSON.stringify(warning()) + "\n" + protocol(),
  protocol() + JSON.stringify(warning()) + "\n",
  withWarning(1, warning(undefined, "reason")),
  withWarning(1, warning(undefined, "answer")),
  withWarning(3, warning(undefined, "reason")),
  withWarning(1).replace(
    '"type":"turn.started"',
    JSON.stringify(warning()).slice(1, -1),
  ),
])("warning IDs/order remain fail closed: %s", (wire) => {
  const decoder = new CodexJsonlDecoder("req_168");
  expect(() => decoder.push(Buffer.from(wire))).toThrow("unknown-outcome");
  expect(decoder.finish(0)).toMatchObject([{ reason: "unknown-outcome" }]);
});

test.each([
  { wire: withWarning(1).split("\n").slice(0, 2).join("\n") + "\n", exit: 0 },
  { wire: withWarning(1).replace('{"type":"turn.started"}\n', ""), exit: 0 },
  { wire: withWarning(1), exit: 7 },
  { wire: withWarning(1) + "{private-malformed}\n", exit: 0 },
  { wire: withWarning(1).replace('"usage":{', '"wrong-usage":{'), exit: 0 },
])(
  "warnings never supply missing terminal/turn/usage or clean exit: %j",
  ({ wire, exit }) => {
    const decoder = new CodexJsonlDecoder("req_168");
    try {
      decoder.push(Buffer.from(wire));
    } catch {
      /* malformed protocol */
    }
    expect(decoder.finish(exit)).toMatchObject([{ reason: "unknown-outcome" }]);
  },
);

test.each([
  {
    message: "model rerouted: private-model -> private-other (Unknown)",
    reason: "unsupported",
  },
  { message: "private-account quota exhausted", reason: "quota" },
  { message: "private-token authentication failed", reason: "authentication" },
])(
  "known warning policy stop survives continuation: $reason",
  async ({ message, reason }) => {
    const options = await fakeCodex();
    await fakeRuntime(options, undefined, {
      wire: withWarning(1, warning(message)),
      lingerAfterWire: true,
    });
    const input = request(options.workspace);
    const permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const executor = new CodexExecutor(options);
    const handle = await executor.startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    );
    const result = await events(handle);
    expect(result).toEqual([
      { type: "started", requestId: input.requestId },
      expect.objectContaining({ type: "stopped", reason }),
    ]);
    expect(handle.diagnostics?.()).toMatchObject({
      backendReach: "unknown",
      process: {
        spawned: true,
        settled: true,
        failure: "stdout-callback",
        signal: "SIGTERM",
      },
      decoder: {
        threadStarted: true,
        turnStarted: false,
        outputObserved: false,
        terminalObserved: false,
        failed: true,
        failure: "policy-stop",
        rejectedShape: { eventType: "item.completed", itemType: "error" },
      },
    });
    expect(JSON.stringify(handle.diagnostics?.())).not.toMatch(
      /private|rerouted/,
    );
    await expect(
      executor.startAuthorizedOnce(input, await schema(options), permit),
    ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
  },
);

test("an official error followed by turn.failed retains the first safe stop classification", () => {
  const decoder = new CodexJsonlDecoder("req_174");
  decoder.push(
    Buffer.from(
      [
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "error", message: "Usage limit reached private detail" },
        {
          type: "turn.failed",
          error: { message: "Usage limit reached private detail" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    ),
  );
  expect(decoder.finish(1)).toMatchObject([
    { type: "stopped", reason: "quota" },
  ]);
  expect(decoder.diagnostics()).toMatchObject({
    terminalObserved: true,
    failed: false,
    failure: "none",
  });
});

test.each(["error", "turn.failed"])(
  "warning compatibility preserves fatal %s classification",
  (type) => {
    const decoder = new CodexJsonlDecoder("req_168");
    const prefix = withWarning(1).split("\n").slice(0, 2).join("\n") + "\n";
    const error = { message: "private-account quota exhausted" };
    decoder.push(
      Buffer.from(
        prefix +
          JSON.stringify(
            type === "error" ? { type, ...error } : { type, error },
          ) +
          "\n",
      ),
    );
    expect(decoder.finish(1)).toMatchObject([
      { type: "stopped", reason: "quota" },
    ]);
  },
);

test.each([1, 2])(
  "unterminated reroute notice preserves the fixed EOF policy stop at position %i",
  (position) => {
    const decoder = new CodexJsonlDecoder("req_168");
    const prefix = protocol().split("\n").slice(0, position).join("\n") + "\n";
    decoder.push(
      Buffer.from(
        prefix +
          JSON.stringify(
            warning("model rerouted: private-from -> private-to (Unknown)"),
          ),
      ),
    );
    expect(decoder.finish(0)).toMatchObject([
      { type: "stopped", reason: "unsupported" },
    ]);
    expect(decoder.diagnostics()).toMatchObject({
      failure: "policy-stop",
      rejectedShape: { eventType: "item.completed", itemType: "error" },
    });
    expect(JSON.stringify(decoder.diagnostics())).not.toContain("private");
  },
);

test("rejected shape saturates counts, redacts names/values and retains first rejection", () => {
  const decoder = new CodexJsonlDecoder("private-request");
  decoder.push(Buffer.from(protocol().split("\n")[0] + "\n"));
  const item = {
    id: "private-id",
    type: "private-tool",
    message: "private-message",
    ...Object.fromEntries(
      Array.from({ length: 260 }, (_, i) => [
        `private-key-${i}`,
        "private-value",
      ]),
    ),
  };
  expect(() =>
    decoder.push(
      Buffer.from(
        JSON.stringify({
          type: "item.completed",
          item,
          "private-key": "private-value",
        }) + "\n",
      ),
    ),
  ).toThrow("unknown-outcome");
  const shape = decoder.diagnostics().rejectedShape;
  expect(shape).toEqual({
    eventType: "item.completed",
    itemType: "other",
    hasItem: true,
    hasId: true,
    hasType: true,
    hasText: false,
    hasMessage: true,
    eventUnknownKeys: 1,
    itemUnknownKeys: 255,
  });
  expect(() =>
    decoder.push(Buffer.from('{"type":"error","message":"secret"}\n')),
  ).toThrow();
  expect(decoder.diagnostics().rejectedShape).toEqual(shape);
  expect(JSON.stringify(decoder.diagnostics())).not.toMatch(/private|secret/);
});

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
  expect(args.slice(0, 12)).toEqual([
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

/** Explicitly fake subprocess protocol. This fixture is not official safety or
 * billing evidence; official metadata/source checks are documented separately. */
async function fakeRuntime(
  options: CodexOptions,
  mutation: (
    config: Record<string, unknown>,
    snapshot: Record<string, unknown>,
  ) => void = () => {},
  behavior: {
    output?: string;
    exit?: number;
    hang?: boolean;
    login?: string;
    malformed?: boolean;
    metadataWait?: boolean;
    spawnFailure?: boolean;
    wire?: string;
    stderr?: string;
    lingerAfterWire?: boolean;
  } = {},
) {
  if (!options.env.HOME) options.env = { HOME: options.workspace };
  const config: Record<string, unknown> = {
    forced_login_method: "chatgpt",
    model_provider: "openai",
    service_tier: "default",
    approval_policy: "never",
    web_search: "disabled",
    tools: {
      update_plan: { enabled: false },
      experimental_request_user_input: { enabled: false },
    },
    memories: { generate_memories: false, use_memories: false },
    agents: { enabled: false },
    orchestrator: { mcp: { enabled: false } },
    cloud: { skills: { enabled: false } },
    skills: { include_instructions: false, bundled: { enabled: false } },
    project_doc_max_bytes: 0,
    project_root_markers: [],
    shell_environment_policy: { inherit: "none" },
    analytics: { enabled: false },
    feedback: { enabled: false },
    notify: [],
    default_permissions: "mimic",
    projects: {
      [await import("node:fs/promises").then((fs) =>
        fs.realpath(options.workspace),
      )]: { trust_level: "untrusted" },
    },
    permissions: {
      mimic: {
        extends: ":read-only",
        network: { enabled: false },
        filesystem: {},
      },
    },
    features: Object.fromEntries(
      [
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
      ].map((key) => [key, false]),
    ),
  };
  (config.features as Record<string, unknown>).skip_host_skill_discovery = true;
  (config.features as Record<string, unknown>).code_mode_host = {
    enabled: false,
    disable_in_process_fallback: false,
  };
  const deny = (
    config.permissions as { mimic: { filesystem: Record<string, string> } }
  ).mimic.filesystem;
  if (options.env.HOME)
    for (const name of [".codex", ".ssh", ".aws"])
      deny[path.join(options.env.HOME, name)] = "deny";
  if (options.env.CODEX_HOME) deny[options.env.CODEX_HOME] = "deny";
  const snapshot = {
    config,
    origins: {},
    layers: [{ name: { type: "sessionFlags" }, config, version: "test" }],
  };
  mutation(config, snapshot);
  await writeFile(
    options.executable,
    `#!${process.execPath}
const fs=require('node:fs'), readline=require('node:readline'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(options.workspace, "calls.jsonl"))},JSON.stringify(args)+'\\n');
if(args[0]==='--version')console.log('codex-cli 0.160.0');
else if(args.join(' ')==='login status')console.error(${JSON.stringify(behavior.login ?? "Logged in using ChatGPT")});
else if(args[0]==='app-server'){
  let phase=0;const input=readline.createInterface({input:process.stdin}); input.on('line',line=>{
    const msg=JSON.parse(line);
    if(msg.method==='initialize'&&phase===0){phase=1;console.log(JSON.stringify({id:1,result:{userAgent:'fake'}}));}
    else if(msg.method==='initialized'&&phase===1){phase=2;}
    else if(msg.method==='config/read'&&phase===2&&msg.params.includeLayers&&msg.params.cwd){phase=3;${behavior.metadataWait ? `fs.writeFileSync(${JSON.stringify(path.join(options.workspace, "preflight.marker"))},'ready');const interval=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(options.workspace, "preflight.release"))})){clearInterval(interval);console.log(JSON.stringify({id:2,result:JSON.parse(${JSON.stringify(JSON.stringify(snapshot))})}));}},10);` : `console.log(JSON.stringify({id:2,result:JSON.parse(${JSON.stringify(JSON.stringify(snapshot))})}));`}${behavior.spawnFailure ? `fs.unlinkSync(${JSON.stringify(options.executable)});` : ""}}
    else if(msg.method==='configRequirements/read'&&phase===3){phase=4;console.log(JSON.stringify({id:3,result:{requirements:${JSON.stringify(snapshot.requirements ?? null)}}}));}
    else{console.error('forbidden RPC');process.exit(97);}
  });
}else if(args[0]==='exec'){
  if(!args.includes('features.code_mode_host={enabled=false,disable_in_process_fallback=false}')||!args.includes('notify=[]')||!args.includes('default_permissions="mimic"')||args.includes('--sandbox')||args.includes('--last'))process.exit(96);
  let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(options.workspace, "execution.json"))},JSON.stringify({model:args[args.indexOf('--model')+1],input})); ${behavior.hang ? "setInterval(()=>{},1000);" : `process.stderr.write(${JSON.stringify(behavior.stderr ?? "")});process.stdout.write(${JSON.stringify(behavior.wire ?? (behavior.malformed ? "{malformed}\n" : protocol(behavior.output ?? final)))});process.exitCode=${behavior.exit ?? 0};${behavior.lingerAfterWire ? "setInterval(()=>{},1000);" : ""}`} });
}else process.exit(99);
`,
  );
}
function fakeDecisionPort(
  expiresAt = Date.now() + 60_000,
): CodexCreditRiskDecisionPort {
  return {
    consumeUserDecision: vi.fn(async () => ({
      decisionId: "fake-user-decision",
      expiresAt,
    })),
  };
}
test("explicit one-shot trusted-host permission uses production metadata gate, launcher and incremental decoder without changing entitlement", async () => {
  const options = await fakeCodex();
  options.env = { HOME: options.workspace };
  const output = '{"smoke":"日本語"}';
  await fakeRuntime(options, undefined, { output });
  const input = request(options.workspace),
    port = fakeDecisionPort();
  const permit = await createCodexCreditRiskPermit(port, input);
  expect(port.consumeUserDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: input.requestId,
      model: input.settings.model,
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    undefined,
  );
  const executor = new CodexExecutor(options);
  expect(
    await events(
      await executor.startAuthorizedOnce(input, await schema(options), permit),
    ),
  ).toEqual([
    { type: "started", requestId: input.requestId },
    { type: "output", text: output },
    { type: "completed", output },
  ]);
  expect((await executor.describe()).entitlement).toEqual({
    status: "unconfirmed",
    reason: "billing",
  });
  await expect(executor.start(input)).rejects.toMatchObject({
    reason: "billing-unconfirmed",
  });
  await expect(
    executor.startAuthorizedOnce(input, await schema(options), permit),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
  expect(
    (await calls(options)).filter((args: string[]) => args[0] === "exec"),
  ).toHaveLength(1);
});
test("opaque permits reject forged objects and repeated decision receipts without launching", async () => {
  const options = await fakeCodex();
  const input = request(options.workspace),
    port = fakeDecisionPort();
  await createCodexCreditRiskPermit(port, input);
  await expect(createCodexCreditRiskPermit(port, input)).rejects.toMatchObject({
    reason: "billing-unconfirmed",
  });
  await expect(
    new CodexExecutor(options).startAuthorizedOnce(
      input,
      await schema(options),
      {} as CodexCreditRiskPermit,
    ),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
  await expect(
    readFile(path.join(options.workspace, "calls.jsonl")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["requestId", "model", "workspace", "prompt", "expired"])(
  "one-shot permission is bound to %s and burns failed attempts",
  async (key) => {
    const options = await fakeCodex(),
      outside = await fakeCodex(),
      input = request(options.workspace);
    const permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const changed = { ...input, settings: { ...input.settings } };
    if (key === "requestId") changed.requestId = "different";
    if (key === "model") changed.settings.model = "different";
    if (key === "workspace") changed.workspace = outside.workspace;
    if (key === "prompt") changed.prompt = "different";
    if (key === "expired")
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    const executor = new CodexExecutor(options);
    await expect(
      executor.startAuthorizedOnce(changed, await schema(options), permit),
    ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
    await expect(
      executor.startAuthorizedOnce(input, await schema(options), permit),
    ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
    await expect(
      readFile(path.join(options.workspace, "calls.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test.each([
  "MCP",
  "host",
  "project",
  "write",
  "notify",
  "endpoint",
  "catalog",
  "instructions",
  "approval",
])("metadata gate rejects %s authority before exec", async (kind) => {
  const options = await fakeCodex();
  await fakeRuntime(options, (config, snapshot) => {
    if (kind === "MCP")
      config.mcp_servers = { unsafe: { command: "forbidden" } };
    if (kind === "host") {
      (config.features as Record<string, unknown>).code_mode_host = {
        enabled: true,
        disable_in_process_fallback: false,
      };
    }
    if (kind === "project")
      snapshot.layers.push({
        name: { type: "project" },
        config: {},
        version: "bad",
      });
    if (kind === "write")
      (
        config.permissions as { mimic: { filesystem: Record<string, string> } }
      ).mimic.filesystem["/tmp"] = "write";
    if (kind === "notify") config.notify = ["forbidden"];
    if (kind === "endpoint")
      config.chatgpt_base_url = "https://forbidden.invalid";
    if (kind === "catalog") config.model_catalog_json = "/forbidden.json";
    if (kind === "instructions") config.model_instructions_file = "/private";
    if (kind === "approval") config.approval_policy = "on-request";
  });
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
  await expect(
    new CodexExecutor(options).startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    ),
  ).rejects.toMatchObject({ reason: "unsupported" });
  expect(
    (await calls(options)).some((args: string[]) => args[0] === "exec"),
  ).toBe(false);
});
test.each([{ malformed: true }, { exit: 4 }, { output: "not JSON" }])(
  "production launch withholds successful output after invalid protocol/process %j",
  async (behavior) => {
    const options = await fakeCodex();
    await fakeRuntime(options, undefined, behavior);
    const input = request(options.workspace),
      permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const handle = await new CodexExecutor(options).startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    );
    const result = await events(handle);
    expect(result.at(-1)).toMatchObject({
      type: "stopped",
      reason: "unknown-outcome",
    });
    expect(result.some((event) => event.type === "completed")).toBe(false);
    expect(handle.diagnostics?.()).toMatchObject({
      backendReach: "unknown",
      stage: "generation",
      processKind: "generation",
      process: { spawned: true, settled: true },
      decoder: {
        failure: behavior.malformed
          ? "json"
          : behavior.output
            ? "invalid-output"
            : "nonzero-exit",
      },
    });
  },
);
test("concurrent start attempts consume the permit before metadata and dispatch exactly once", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options);
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input),
    executor = new CodexExecutor(options),
    schemaPath = await schema(options);
  const result = await Promise.allSettled([
    executor.startAuthorizedOnce(input, schemaPath, permit),
    executor.startAuthorizedOnce(input, schemaPath, permit),
  ]);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  for (const item of result)
    if (item.status === "fulfilled") await events(item.value);
  expect(
    (await calls(options)).filter((args: string[]) => args[0] === "exec"),
  ).toHaveLength(1);
});
test("cancelled production execution cannot reuse its authorization", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, undefined, { hang: true });
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input),
    executor = new CodexExecutor(options),
    schemaPath = await schema(options);
  const handle = await executor.startAuthorizedOnce(input, schemaPath, permit);
  await handle.cancel();
  expect((await events(handle)).at(-1)).toEqual({
    type: "stopped",
    reason: "cancelled",
    resumeCondition: "reconcile-before-retry",
  });
  await expect(
    executor.startAuthorizedOnce(input, schemaPath, permit),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
});

test.each(["nonempty", "symlink", "empty"])(
  "native global instructions %s are stat-only gated",
  async (kind) => {
    const options = await fakeCodex();
    await fakeRuntime(options);
    const home = path.join(options.workspace, ".codex");
    await mkdir(home);
    const file = path.join(home, "AGENTS.md");
    if (kind === "symlink") {
      const outside = path.join(options.workspace, "other.md");
      await writeFile(outside, "");
      await symlink(outside, file);
    } else
      await writeFile(
        file,
        kind === "empty" ? "" : "unapproved native instructions",
      );
    const inspection = inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    );
    if (kind === "empty") await expect(inspection).resolves.toBeUndefined();
    else
      await expect(inspection).rejects.toMatchObject({ reason: "unsupported" });
    let actual: string[][] = [];
    try {
      actual = await calls(options);
    } catch {
      /* A pre-spawn rejection has no call log. */
    }
    expect(actual.some((args) => args[0] === "exec")).toBe(false);
    if (kind !== "empty") expect(actual).toHaveLength(0);
  },
);

test("official metadata-shaped null defaults and omitted ToolsV2 fields are verified through raw layers", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (config, snapshot) => {
    const layers = snapshot.layers as { config: unknown }[];
    layers[0].config = JSON.parse(JSON.stringify(config));
    config.tools = { web_search: null };
    config.chatgpt_base_url = "https://chatgpt.com/backend-api/";
    const permission = (
      config.permissions as { mimic: Record<string, unknown> }
    ).mimic;
    permission.workspace_roots = null;
    permission.description = null;
    (permission.network as Record<string, unknown>).domains = null;
    (permission.filesystem as Record<string, unknown>).glob_scan_max_depth =
      null;
  });
  await expect(
    inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    ),
  ).resolves.toBeUndefined();
});
test("higher managed layer cannot re-enable a tool omitted by public ToolsV2", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (_config, snapshot) => {
    (snapshot.layers as unknown[]).unshift({
      name: {
        type: "legacyManagedConfigTomlFromFile",
        file: path.join(options.workspace, "managed_config.toml"),
      },
      version: "managed",
      config: { tools: { update_plan: { enabled: true } } },
    });
  });
  await expect(
    inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    ),
  ).rejects.toMatchObject({ reason: "unsupported" });
});
test("abort during official metadata cancels its group before any exec and consumes the permit", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, undefined, { metadataWait: true });
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input),
    executor = new CodexExecutor(options),
    schemaPath = await schema(options),
    controller = new AbortController();
  const startup = executor.startAuthorizedOnce(
    input,
    schemaPath,
    permit,
    controller.signal,
  );
  const rejected = expect(startup).rejects.toMatchObject({
    reason: "cancelled",
  });
  const deadline = Date.now() + 1500;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await readFile(path.join(options.workspace, "preflight.marker"));
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  expect(ready).toBe(true);
  controller.abort();
  await rejected;
  expect(
    (await calls(options)).some((args: string[]) => args[0] === "exec"),
  ).toBe(false);
  await expect(
    executor.startAuthorizedOnce(input, schemaPath, permit),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
});
test("cancelled decision lookup never yields a reusable permit or launches", async () => {
  const options = await fakeCodex(),
    controller = new AbortController();
  let release:
    ((receipt: { decisionId: string; expiresAt: number }) => void) | undefined;
  const port: CodexCreditRiskDecisionPort = {
    consumeUserDecision: vi.fn(async (_scope, signal) => {
      expect(signal).toBe(controller.signal);
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
  };
  const pending = createCodexCreditRiskPermit(
    port,
    request(options.workspace),
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    reason: "cancelled",
  });
  const deadline = Date.now() + 1000;
  while (!release && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(release).toBeDefined();
  controller.abort();
  release!({ decisionId: "cancelled-decision", expiresAt: Date.now() + 60000 });
  await rejected;
  await expect(
    readFile(path.join(options.workspace, "calls.jsonl")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test("spawn failure has a normalized terminal and cannot restore the one-shot permission", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, undefined, { spawnFailure: true });
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input),
    executor = new CodexExecutor(options),
    schemaPath = await schema(options);
  const handle = await executor.startAuthorizedOnce(input, schemaPath, permit);
  const result = await events(handle);
  expect(result).toEqual([
    { type: "started", requestId: input.requestId },
    {
      type: "stopped",
      reason: "unknown-outcome",
      resumeCondition: "reconcile-before-retry",
    },
  ]);
  expect(handle.diagnostics?.()).toMatchObject({
    stage: "generation",
    processKind: "generation",
    backendReach: "unknown",
    process: {
      spawned: false,
      settled: true,
      exitCode: null,
      errorCode: "ENOENT",
      failure: "spawn-error",
    },
  });
  await expect(
    executor.startAuthorizedOnce(input, schemaPath, permit),
  ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
});

test.each([
  {
    wire: "",
    stderr: "private stderr account-token",
    exit: 7,
    failure: "nonzero-exit",
    thread: false,
  },
  {
    wire:
      JSON.stringify({ type: "thread.started", thread_id: "private-thread" }) +
      "\n",
    failure: "missing-terminal",
    thread: true,
  },
])(
  "production diagnostics distinguish local exit/EOF without asserting backend contact: %j",
  async (behavior) => {
    const options = await fakeCodex();
    await fakeRuntime(options, undefined, behavior);
    const input = request(options.workspace);
    const permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const executor = new CodexExecutor(options);
    const handle = await executor.startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    );
    expect((await events(handle)).at(-1)).toMatchObject({
      type: "stopped",
      reason: "unknown-outcome",
    });
    const diagnostic = handle.diagnostics?.();
    expect(diagnostic).toMatchObject({
      backendReach: "unknown",
      process: { spawned: true, settled: true, exitCode: behavior.exit ?? 0 },
      decoder: {
        threadStarted: behavior.thread,
        outputObserved: false,
        terminalObserved: false,
        finished: true,
        failure: behavior.failure,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /private stderr|account-token|private-thread|output_tokens|requestId|workspace/,
    );
    await expect(
      executor.startAuthorizedOnce(input, await schema(options), permit),
    ).rejects.toMatchObject({ reason: "billing-unconfirmed" });
  },
);

test.each([
  { bytes: Buffer.from([0xff]), failure: "utf8" },
  {
    bytes: Buffer.from('{"type":"private-unknown-event"}\n'),
    failure: "protocol",
  },
  { bytes: Buffer.from("{private-malformed}\n"), failure: "json" },
  { bytes: Buffer.from("x".repeat(65)), failure: "output-limit" },
])(
  "decoder keeps the first safe failure category: $failure",
  ({ bytes, failure }) => {
    const decoder = new CodexJsonlDecoder("private-request", 64);
    expect(() => decoder.push(bytes)).toThrow("unknown-outcome");
    decoder.finish(9);
    expect(decoder.diagnostics()).toMatchObject({ failed: true, failure });
    expect(JSON.stringify(decoder.diagnostics())).not.toContain("private");
  },
);

test("profile rejection clears old login-process diagnostics; safety rejection observes its own metadata process", async () => {
  for (const stage of ["generation-profile", "safety-metadata"] as const) {
    const options = await fakeCodex();
    await fakeRuntime(
      options,
      stage === "safety-metadata"
        ? (config) => {
            config.notify = ["private-notify"];
          }
        : undefined,
    );
    const input = request(options.workspace);
    const permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
    const executor = new CodexExecutor(options);
    try {
      await executor.startAuthorizedOnce(
        input,
        stage === "generation-profile"
          ? "missing-schema.json"
          : await schema(options),
        permit,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        reason: "unsupported",
        diagnostics: { stage, backendReach: "unknown" },
      });
      const diagnostic = (error as { diagnostics: Record<string, unknown> })
        .diagnostics;
      if (stage === "generation-profile") {
        expect(diagnostic.process).toBeUndefined();
        expect(diagnostic.processKind).toBeUndefined();
      } else
        expect(diagnostic).toMatchObject({
          processKind: "metadata",
          process: { spawned: true, settled: true, exitCode: 0 },
        });
      expect(JSON.stringify(diagnostic)).not.toContain("private-notify");
    }
    expect(
      (await calls(options)).some((args: string[]) => args[0] === "exec"),
    ).toBe(false);
  }
});

test("observed candidate text without terminal remains withheld and backend contact unknown", () => {
  const decoder = new CodexJsonlDecoder("private-request");
  const incomplete =
    protocol().trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  expect(
    decoder
      .push(Buffer.from(incomplete))
      .some((event) => event.type === "completed"),
  ).toBe(false);
  expect(decoder.finish(0)).toMatchObject([
    { type: "stopped", reason: "unknown-outcome" },
  ]);
  expect(decoder.diagnostics()).toMatchObject({
    threadStarted: true,
    turnStarted: true,
    outputObserved: true,
    terminalObserved: false,
    finished: true,
    failure: "missing-terminal",
  });
  expect(JSON.stringify(decoder.diagnostics())).not.toMatch(
    /private-request|private reasoning|output_tokens/,
  );
});

test("managed requirements override is rejected independently of a safe raw config snapshot", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (_config, snapshot) => {
    snapshot.requirements = {
      modelProvider: "bedrock",
      additionalDeveloperInstructions: "unapproved context",
    };
  });
  const input = request(options.workspace),
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
  await expect(
    new CodexExecutor(options).startAuthorizedOnce(
      input,
      await schema(options),
      permit,
    ),
  ).rejects.toMatchObject({ reason: "unsupported" });
  expect(
    (await calls(options)).some((args: string[]) => args[0] === "exec"),
  ).toBe(false);
});

test("official generated ChatGPT-only requirement is allowed without claiming billing proof", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (_config, snapshot) => {
    snapshot.requirements = {
      modelProvider: null,
      chatgptBaseUrl: null,
      featureRequirements: null,
      allowedLoginMethods: ["chatgpt"],
    };
  });
  await expect(
    inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    ),
  ).resolves.toBeUndefined();
});

test("ignored user MCP cannot mask retained system MCP", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (_config, snapshot) => {
    (snapshot.layers as unknown[]).push({
      name: {
        type: "user",
        file: path.join(options.workspace, "config.toml"),
        profile: null,
      },
      version: "user",
      config: { mcp_servers: { danger: { enabled: false } } },
    });
    (snapshot.layers as unknown[]).push({
      name: { type: "system", file: "/etc/codex/config.toml" },
      version: "system",
      config: {
        mcp_servers: { danger: { command: "forbidden", enabled: true } },
      },
    });
  });
  await expect(
    inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    ),
  ).rejects.toMatchObject({ control: "mcp_servers" });
});
test("stock exec excludes only user layers and disabled project while preserving managed maps", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, (_config, snapshot) => {
    (snapshot.layers as unknown[]).push({
      name: {
        type: "project",
        dotCodexFolder: path.join(options.workspace, ".codex"),
      },
      version: "project",
      disabledReason: "untrusted",
      config: {
        notify: ["forbidden"],
        mcp_servers: { danger: { command: "forbidden" } },
      },
    });
    (snapshot.layers as unknown[]).push({
      name: {
        type: "user",
        file: path.join(options.workspace, "config.toml"),
        profile: null,
      },
      version: "user",
      config: { mcp_servers: { danger: { command: "forbidden" } } },
    });
    (snapshot.layers as unknown[]).push({
      name: { type: "system", file: "/etc/codex/config.toml" },
      version: "system",
      config: {},
    });
  });
  await expect(
    inspectCodexGenerationSafety(
      options,
      request(options.workspace),
      await schema(options),
    ),
  ).resolves.toBeUndefined();
});
test.each(["unknown", "order", "missing-session", "incomplete", "prototype"])(
  "raw layer reconstruction fails closed for %s",
  async (kind) => {
    const options = await fakeCodex();
    await fakeRuntime(options, (_config, snapshot) => {
      const layers = snapshot.layers as unknown[];
      if (kind === "unknown")
        layers.push({ name: { type: "unknown" }, version: "bad", config: {} });
      if (kind === "order")
        layers.push({
          name: { type: "legacyManagedConfigTomlFromMdm" },
          version: "bad",
          config: {},
        });
      if (kind === "missing-session") snapshot.layers = [];
      if (kind === "incomplete")
        layers.push({ name: { type: "system" }, version: "bad", config: {} });
      if (kind === "prototype")
        layers.push({
          name: { type: "system", file: "/etc/codex/config.toml" },
          version: "bad",
          config: JSON.parse('{"__proto__":{"model_provider":"forbidden"}}'),
        });
    });
    await expect(
      inspectCodexGenerationSafety(
        options,
        request(options.workspace),
        await schema(options),
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
  },
);
test("authorized dispatch snapshots original model/prompt before delayed metadata", async () => {
  const options = await fakeCodex();
  await fakeRuntime(options, undefined, { metadataWait: true });
  const input = request(options.workspace),
    expected = { model: input.settings.model, input: input.prompt },
    permit = await createCodexCreditRiskPermit(fakeDecisionPort(), input);
  const startup = new CodexExecutor(options).startAuthorizedOnce(
    input,
    await schema(options),
    permit,
  );
  const deadline = Date.now() + 1500;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await readFile(path.join(options.workspace, "preflight.marker"));
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  expect(ready).toBe(true);
  input.prompt = "different";
  input.settings.model = "different";
  await writeFile(path.join(options.workspace, "preflight.release"), "ready");
  await events(await startup);
  expect(
    JSON.parse(
      await readFile(path.join(options.workspace, "execution.json"), "utf8"),
    ),
  ).toEqual(expected);
});
