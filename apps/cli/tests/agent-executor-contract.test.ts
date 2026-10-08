import { expect, test, vi } from "vitest";
import {
  ExecutorFailure,
  parseSubscriptionSettings,
  startExecution,
  stopEvent,
  type AgentExecutor,
  type ExecutionRequest,
  type ExecutorDescription,
  type ExecutorEvent,
  type ProviderId,
} from "../src/agent/index.js";

const request: ExecutionRequest = {
  requestId: "request-1",
  workspace: "/tmp",
  prompt: "Only use supplied evidence",
  settings: {
    provider: "codex",
    billingMode: "subscription-only",
    model: "entitled-model",
  },
};
function fake(
  provider: ProviderId = "codex",
  events: ExecutorEvent[] = [
    { type: "started", requestId: request.requestId },
    { type: "output", text: "partial" },
    { type: "completed", output: "new answer", sessionId: "session-1" },
  ],
) {
  const description: ExecutorDescription = {
    provider,
    runtimeVersion: "fake-contract-only",
    capabilities: {
      subscription: true,
      streaming: true,
      cancellation: true,
      nativeResume: true,
      structuredOutput: false,
      toolRestriction: true,
    },
    entitlement: {
      status: "confirmed",
      billingMode: "subscription-only",
      billingEvidence: {
        enforcement: "official-runtime",
        reference: "fake-only-billing-control",
      },
      models: ["entitled-model"],
    },
  };
  const cancel = vi.fn(async () => {});
  const handle = () => ({
    cancel,
    events: (async function* () {
      for (const event of events) yield event;
    })(),
  });
  const executor = {
    describe: vi.fn(async () => description),
    start: vi.fn(async () => handle()),
    resume: vi.fn(async () => handle()),
  } satisfies AgentExecutor;
  return { executor, description, cancel };
}
async function collect(executor: AgentExecutor, input = request) {
  const events = [];
  for await (const event of (await startExecution(executor, input)).events)
    events.push(event);
  return events;
}

test.each(["codex", "claude", "gemini"] as const)(
  "candidate %s is interchangeable without paid fallback",
  async (provider) => {
    const { executor } = fake(provider);
    const events = await collect(executor, {
      ...request,
      settings: { ...request.settings, provider },
    });
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
    expect(executor.start).toHaveBeenCalledOnce();
  },
);
test.each([
  { provider: "other", billingMode: "subscription-only" },
  { provider: "codex", billingMode: "api" },
  { provider: "codex", billingMode: "subscription-only", apiKey: "secret" },
  { provider: "codex", billingMode: "subscription-only", fallback: "claude" },
  { provider: "codex", billingMode: "subscription-only", extraCredits: true },
  {
    provider: "codex",
    billingMode: "subscription-only",
    auxiliaryModel: "paid",
  },
  { provider: "codex", billingMode: "subscription-only", model: " " },
])("invalid billing/provider settings fail closed", (value) => {
  expect(() => parseSubscriptionSettings(value)).toThrow();
});
test("unconfirmed login and unsupported subscription stop before any start", async () => {
  for (const status of ["unconfirmed", "unsupported"] as const) {
    const { executor, description } = fake();
    description.entitlement = { status };
    expect(await collect(executor)).toEqual([
      stopEvent(status === "unconfirmed" ? "authentication" : "unsupported"),
    ]);
    expect(executor.start).not.toHaveBeenCalled();
  }
});
test("unentitled model, mismatched provider and unavailable capabilities never dispatch", async () => {
  const { executor } = fake();
  expect(
    await collect(executor, {
      ...request,
      settings: { ...request.settings, model: "paid-model" },
    }),
  ).toEqual([stopEvent("unsupported")]);
  expect(
    await collect(executor, {
      ...request,
      settings: { ...request.settings, provider: "gemini" },
    }),
  ).toEqual([stopEvent("unsupported")]);
  expect(
    await collect(executor, {
      ...request,
      requiredCapabilities: ["structuredOutput"],
    }),
  ).toEqual([stopEvent("unsupported")]);
  expect(executor.start).not.toHaveBeenCalled();
});
test("native resume is explicit and capability checked", async () => {
  const { executor, description } = fake();
  const resume = { ...request, sessionId: "session-1" };
  expect((await collect(executor, resume)).at(-1)?.type).toBe("completed");
  expect(executor.resume).toHaveBeenCalledWith(resume);
  description.capabilities.nativeResume = false;
  expect(await collect(executor, resume)).toEqual([stopEvent("unsupported")]);
  expect(executor.resume).toHaveBeenCalledOnce();
});
test.each([
  "quota",
  "authentication",
  "unsupported",
  "timeout",
  "unknown-outcome",
] as const)("%s stops retain explicit resume conditions", async (reason) => {
  const { executor } = fake();
  executor.start.mockRejectedValueOnce(new ExecutorFailure(reason));
  expect(await collect(executor)).toEqual([stopEvent(reason)]);
  expect(executor.start).toHaveBeenCalledOnce();
  expect(executor.resume).not.toHaveBeenCalled();
});
test("raw exceptions are never operational events", async () => {
  const { executor } = fake();
  executor.start.mockRejectedValueOnce(
    new Error("Authorization: Bearer secret-token"),
  );
  expect(JSON.stringify(await collect(executor))).not.toContain("secret-token");
});
test.each([
  [{ type: "output", text: "without start" }],
  [{ type: "started", requestId: "wrong-request" }],
  [
    { type: "started", requestId: "request-1" },
    { type: "started", requestId: "request-1" },
  ],
  [
    { type: "started", requestId: "request-1" },
    { type: "completed", output: "first" },
    { type: "completed", output: "second" },
  ],
  [
    { type: "started", requestId: "request-1" },
    { type: "completed", output: "first" },
    { type: "output", text: "late" },
  ],
  [{ type: "started", requestId: "request-1" }],
] as ExecutorEvent[][])(
  "malformed event sequence never reports completion: %j",
  async (...events) => {
    const { executor } = fake("codex", events);
    const result = await collect(executor);
    expect(result.some((event) => event.type === "completed")).toBe(false);
    expect(result.at(-1)).toEqual(stopEvent("unknown-outcome"));
  },
);
test("stream failures redact diagnostics, cancel backend and retain a terminal stop", async () => {
  const { executor, cancel } = fake();
  executor.start.mockResolvedValueOnce({
    cancel,
    events: (async function* () {
      yield { type: "started" as const, requestId: request.requestId };
      throw new Error("secret credential");
    })(),
  });
  expect(await collect(executor)).toEqual([
    { type: "started", requestId: request.requestId },
    stopEvent("unknown-outcome"),
  ]);
  expect(cancel).toHaveBeenCalledOnce();
});
test("cancelled incomplete run requires reconciliation rather than blind retry", async () => {
  const { executor, cancel } = fake("codex", [
    { type: "started", requestId: request.requestId },
  ]);
  const handle = await startExecution(executor, request);
  await handle.cancel();
  const events = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1)).toEqual(stopEvent("cancelled"));
  expect(cancel).toHaveBeenCalledOnce();
});

test("cancellation exceptions never expose credentials or produce success", async () => {
  const { executor, cancel } = fake();
  cancel.mockRejectedValueOnce(new Error("private credential"));
  const handle = await startExecution(executor, request);
  await expect(handle.cancel()).resolves.toBeUndefined();
  const events = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1)).toEqual(stopEvent("unknown-outcome"));
  expect(events.some((event) => event.type === "completed")).toBe(false);
});

test("default model is chosen only from confirmed account entitlements", async () => {
  const { executor, description } = fake();
  const input = {
    ...request,
    settings: {
      provider: "codex" as const,
      billingMode: "subscription-only" as const,
    },
  };
  await collect(executor, input);
  expect(executor.start).toHaveBeenCalledWith(request);
  description.entitlement = {
    status: "confirmed",
    billingMode: "subscription-only",
    billingEvidence: {
      enforcement: "official-runtime",
      reference: "fake-only-billing-control",
    },
    models: [],
  };
  expect(await collect(executor, input)).toEqual([stopEvent("unsupported")]);
  expect(executor.start).toHaveBeenCalledOnce();
});

test("login confirmation without included-only billing enforcement cannot start", async () => {
  const { executor, description } = fake();
  description.entitlement = { status: "unconfirmed", reason: "billing" };
  expect(await collect(executor)).toEqual([stopEvent("billing-unconfirmed")]);
  expect(executor.start).not.toHaveBeenCalled();
});
test("incomplete stream cancels backend before reporting unknown outcome", async () => {
  const { executor, cancel } = fake("codex", [
    { type: "started", requestId: request.requestId },
  ]);
  expect((await collect(executor)).at(-1)).toEqual(
    stopEvent("unknown-outcome"),
  );
  expect(cancel).toHaveBeenCalledOnce();
});
test("abandoning output iteration cancels the still-running backend", async () => {
  const { executor, cancel } = fake();
  const handle = await startExecution(executor, request);
  for await (const event of handle.events) {
    expect(event.type).toBe("started");
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
});

test("concurrent cancels wait for the same in-flight backend cleanup", async () => {
  const { executor, cancel } = fake();
  const deferred = Promise.withResolvers<void>();
  cancel.mockImplementationOnce(() => deferred.promise);
  const handle = await startExecution(executor, request);
  const first = handle.cancel();
  const second = handle.cancel();
  expect(second).toBe(first);
  let finished = false;
  void second.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  deferred.reject(new Error("private backend error"));
  await Promise.all([first, second]);
  const events = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1)).toEqual(stopEvent("unknown-outcome"));
  expect(cancel).toHaveBeenCalledOnce();
});
