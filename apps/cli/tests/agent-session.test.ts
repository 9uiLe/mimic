import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  symlink,
  realpath,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
  type ExactArtifactRef,
} from "@mimic/core";
import {
  AgentSession,
  FileSessionStore,
  SessionCandidateRejected,
  SessionExecutionPolicyMismatch,
  SessionStaticSubmissionFailure,
  sessionDigest,
  type SessionBinding,
  type SessionPlan,
  type SessionPorts,
  type SessionTask,
} from "../src/agent/session.js";
import { createWorkspaceSessionPorts } from "../src/agent/session-workspace.js";
import { HOST_DERIVED_DIGEST } from "../src/agent/session-cli.js";
import { runCli } from "../src/cli.js";
import {
  runSessionCli,
  runAuthorizedSessionOnce,
  runAuthorizedSessionResume,
} from "../src/agent/session-main.js";
import {
  CodexExecutor,
  CodexJsonlDecoder,
  createCodexGenerationProfile,
} from "../src/agent/codex.js";
import { runHostAuthorizedSessionOnce } from "../src/agent/authorized-host.js";
import { HostCreditAuthorizationStore } from "../src/agent/host-credit-authorization.js";
import {
  createAuthorizedCodexReconciliationDispatch,
  createAuthorizedCodexSessionDispatch,
} from "../src/agent/session-authorized.js";
import {
  type AgentExecutor,
  type ExecutorEvent,
  type ExecutionRequest,
  sanitizeExecutionDiagnostics,
  ExecutorFailure,
  type ExecutionDiagnostics,
} from "../src/agent/executor.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mimic-agent-session-")),
  );
  roots.push(root);
  return root;
}
const digest = sessionDigest("frozen");
const binding: SessionBinding = {
  runId: "run_session",
  planDigest: digest,
  settings: {
    provider: "codex",
    billingMode: "subscription-only",
    model: "fixture-model",
  },
};
const task = (id: string): SessionTask => ({
  binding: {
    taskId: id,
    inputDigest: digest,
    packageDigest: digest,
    packageVersion: "1.0.0",
    contextDigest: digest,
    inputRefs: [],
  },
  prompt: "Private prompt, not a checkpoint diagnostic",
});
const ref: ExactArtifactRef = {
  artifactId: "art_candidate",
  revision: 1,
  lockDigest: `sha256:${digest}`,
};
const limits = { maxGenerations: 8, timeoutMs: 1000, maxOutputBytes: 10000 };
const safeDiagnostic: ExecutionDiagnostics = {
  version: 1,
  stage: "generation",
  backendReach: "unknown",
  processKind: "generation",
  process: {
    spawned: true,
    settled: true,
    exitCode: 7,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 24,
    errorCode: "none",
    failure: "nonzero-exit",
  },
  decoder: {
    threadStarted: false,
    turnStarted: false,
    outputObserved: false,
    terminalObserved: false,
    finished: true,
    failed: false,
    failure: "nonzero-exit",
  },
};
function fake(
  output: string | ((request: ExecutionRequest) => ExecutorEvent[]),
) {
  const cancel = vi.fn(async () => {});
  const executor: AgentExecutor = {
    describe: async () => ({
      provider: "codex",
      runtimeVersion: "test-only",
      capabilities: {
        subscription: true,
        streaming: true,
        cancellation: true,
        nativeResume: false,
        structuredOutput: true,
        toolRestriction: true,
      },
      entitlement: {
        status: "confirmed",
        billingMode: "subscription-only",
        billingEvidence: {
          enforcement: "official-runtime",
          reference: "test-only-not-a-real-account",
        },
        models: ["fixture-model"],
      },
    }),
    start: vi.fn(async (request) => ({
      cancel,
      events: (async function* () {
        for (const event of typeof output === "string"
          ? [
              { type: "started", requestId: request.requestId } as const,
              { type: "completed", output } as const,
            ]
          : output(request))
          yield event;
      })(),
    })),
    resume: vi.fn(async () => {
      throw new Error("Native resume must not be used");
    }),
  };
  return executor;
}
async function harness() {
  const root = await temporary();
  const accepted = new Set<string>();
  let plan: SessionPlan = {
    runnable: [task("first"), task("second")],
    reviewReady: true,
    questionIds: [],
    complete: false,
  };
  let currentBinding = structuredClone(binding);
  const ports: SessionPorts = {
    workspace: root,
    binding: async () => currentBinding,
    next: async () => plan,
    saveWork: vi.fn(async (_task, output) => ({
      path: "saved.json",
      digest: sessionDigest(output),
    })),
    submit: vi.fn(async (item) => {
      accepted.add(item.taskId);
      return [ref];
    }),
    verifyAccepted: vi.fn(async (item) => {
      if (!accepted.has(item.taskId))
        throw new Error("No authoritative acceptance");
    }),
    inspect: vi.fn(async () => ({ readOnly: true })),
  };
  const store = new FileSessionStore(root, "checkpoints");
  return {
    root,
    ports,
    store,
    accepted,
    setPlan: (value: SessionPlan) => {
      plan = value;
    },
    setBinding: (value: SessionBinding) => {
      currentBinding = value;
    },
  };
}
test("a rejected candidate is preserved and only an explicit resume generates again", async () => {
  const h = await harness();
  h.setPlan({
    runnable: [task("first")],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  const accept = h.ports.submit;
  h.ports.submit = vi
    .fn()
    .mockRejectedValueOnce(new SessionCandidateRejected("static-validation"))
    .mockImplementation(accept);
  const executor = fake("generated answer");
  const session = new AgentSession(
    "session_rejection",
    h.store,
    h.ports,
    executor,
    limits,
  );
  const rejected = await session.advance();
  expect(rejected.stop).toBe("candidate-rejected");
  expect(rejected.tasks.first).toMatchObject({
    phase: "rejected",
    rejectionReason: "static-validation",
  });
  expect(rejected.tasks.first.work).toBeDefined();
  expect(h.accepted.size).toBe(0);
  expect((await session.advance()).stop).toBe("candidate-rejected");
  expect(executor.start).toHaveBeenCalledOnce();
  const resumed = await session.advance({ resume: true });
  expect(resumed.status).toBe("complete");
  expect(resumed.tasks.first.phase).toBe("accepted");
  expect(executor.start).toHaveBeenCalledTimes(2);
});
test("runs independent work despite review-ready, then restores accepted work in a fresh process/session instance", async () => {
  const h = await harness(),
    executor = fake("new model answer");
  const first = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(first.stop).toBe("approval");
  expect(first.generationCount).toBe(2);
  expect(h.accepted).toEqual(new Set(["first", "second"]));
  expect(executor.start).toHaveBeenCalledTimes(2);
  h.setPlan({
    runnable: [task("first"), task("second"), task("third")],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  const second = await new AgentSession(
    "session_a",
    new FileSessionStore(h.store.workspace, h.store.relativeDirectory),
    h.ports,
    executor,
    limits,
  ).advance({ resume: true });
  expect(second.status).toBe("complete");
  expect(executor.start).toHaveBeenCalledTimes(3);
  expect(executor.resume).not.toHaveBeenCalled();
  expect(h.ports.verifyAccepted).toHaveBeenCalledTimes(2);
  expect(
    await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
  ).not.toContain("Private prompt");
  expect(
    (await stat(path.join(h.store.directory, "session_a.json"))).mode & 0o777,
  ).toBe(0o600);
});

test("session accepts an exact artifact ID longer than the task ID limit", async () => {
  const h = await harness();
  const candidate = task("first");
  candidate.binding.inputRefs = [
    {
      ...ref,
      artifactId:
        "art_run_mimic_monitor_design_v5_20261009_s09_workspace_monitor_reference_selection",
    },
  ];
  h.setPlan({
    runnable: [candidate],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  const state = await new AgentSession(
    "session_long_artifact_id",
    h.store,
    h.ports,
    fake("model answer"),
    limits,
  ).advance();
  expect(state.tasks.first?.phase).toBe("accepted");
});
test.each(["quota", "authentication", "billing-unconfirmed"] as const)(
  "%s pauses without retries, explicit resume only generates unfinished work",
  async (reason) => {
    const h = await harness();
    let calls = 0;
    const executor = fake((request) => {
      calls++;
      return [
        { type: "started", requestId: request.requestId },
        calls === 2
          ? { type: "stopped", reason, resumeCondition: "explicit-resume" }
          : { type: "completed", output: "new" },
      ];
    });
    const session = new AgentSession(
      "session_a",
      h.store,
      h.ports,
      executor,
      limits,
    );
    expect((await session.advance()).stop).toBe(reason);
    expect((await session.advance()).stop).toBe(reason);
    expect(calls).toBe(2);
    expect((await session.advance({ resume: true })).stop).toBe("approval");
    expect(calls).toBe(3);
    expect(h.ports.submit).toHaveBeenCalledTimes(2);
  },
);
test("unknown outcome requires reconciliation, and changed inputs/model require a new binding", async () => {
  const h = await harness();
  const unknown = fake((request) => [
    { type: "started", requestId: request.requestId },
  ]);
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    unknown,
    limits,
  );
  expect((await session.advance()).stop).toBe("unknown-outcome");
  expect((await session.advance({ resume: true })).stop).toBe(
    "unknown-outcome",
  );
  expect(unknown.start).toHaveBeenCalledOnce();
  h.setPlan({
    runnable: [
      {
        ...task("first"),
        binding: {
          ...task("first").binding,
          inputDigest: sessionDigest("changed"),
        },
      },
    ],
    reviewReady: false,
    questionIds: [],
    complete: false,
  });
  expect(
    (await session.advance({ resume: true, reconciledUnknownOutcome: true }))
      .stop,
  ).toBe("reservation-invalid");
  h.setBinding({
    ...binding,
    settings: { ...binding.settings, model: "different" },
  });
  expect((await session.advance({ resume: true })).stop).toBe(
    "reservation-invalid",
  );
});

test.each(["legacy", "rejected-shape"])(
  "safe %s diagnostics survive separate production resume/inspect without launch or raw data",
  async (kind) => {
    const diagnostic = structuredClone(safeDiagnostic);
    if (kind === "rejected-shape") {
      const decoder = new CodexJsonlDecoder("private-request");
      decoder.push(
        Buffer.from('{"type":"thread.started","thread_id":"private-thread"}\n'),
      );
      expect(() =>
        decoder.push(
          Buffer.from(
            '{"type":"item.completed","item":{"id":"private-id","type":"private-tool","message":"private-token","private-key":"private-value"}}\n',
          ),
        ),
      ).toThrow();
      diagnostic.decoder = decoder.diagnostics();
    }
    const h = await staticHarness();
    const executor = fake((request) => [
      { type: "started", requestId: request.requestId },
      {
        type: "stopped",
        reason: "unknown-outcome",
        resumeCondition: "reconcile-before-retry",
      },
    ]);
    const start = executor.start;
    executor.start = vi.fn(async (request) => ({
      ...(await start(request)),
      diagnostics: () => diagnostic,
    }));
    const state = await new AgentSession(
      "session_a",
      h.store,
      h.ports,
      executor,
      limits,
    ).advance();
    expect(state.stop).toBe("unknown-outcome");
    expect(state.generationCount).toBe(1);
    expect(state.tasks.first.diagnostics).toEqual(diagnostic);
    const before = await readFile(
      path.join(h.store.directory, "session_a.json"),
      "utf8",
    );
    const workspaceBefore = await readFile(
      path.join(h.root, ".mimic/workspace.json"),
      "utf8",
    );
    const configuration = path.join(h.root, "diagnostic-config.json");
    await writeFile(
      configuration,
      JSON.stringify({
        workspace: h.root,
        executable: path.join(h.root, "missing-private-runtime"),
        runId: binding.runId,
        sessionId: "session_a",
        packages: { first: "skill" },
        model: binding.settings.model,
      }),
    );
    for (const command of ["resume", "inspect"]) {
      const child = spawnSync(
        process.execPath,
        [
          path.join(repo, "apps/cli/dist/agent/session-main.js"),
          command,
          "--config",
          configuration,
        ],
        { encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(0);
      const inspected = JSON.parse(child.stdout);
      expect(inspected).toMatchObject({
        stop: "unknown-outcome",
        tasks: [{ phase: "executing", diagnostics: diagnostic }],
      });
      expect(child.stdout).not.toMatch(
        /private-runtime|private-thread|private-request|private-id|private-tool|private-token|private-key|private-value|Private prompt|stderr"|stdout"|output_tokens/,
      );
    }
    expect(executor.start).toHaveBeenCalledOnce();
    expect(
      await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
    ).toBe(before);
    expect(
      await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
    ).toBe(workspaceBefore);
    expect(before).not.toMatch(
      /private-thread|private-request|private-id|private-tool|private-token|private-key|private-value/,
    );
  },
);

test.each([
  "type",
  "item-type",
  "count",
  "negative",
  "nan",
  "flag",
  "extra-key",
  "getter",
])(
  "rejected-shape diagnostic rejects malicious %s metadata before persistence",
  async (kind) => {
    const diagnostic = structuredClone(safeDiagnostic);
    const shape: Record<string, unknown> = {
      eventType: "item.completed",
      itemType: "error",
      hasItem: true,
      hasId: true,
      hasType: true,
      hasText: false,
      hasMessage: true,
      eventUnknownKeys: 0,
      itemUnknownKeys: 0,
    };
    if (kind === "type") shape.eventType = "private-secret";
    if (kind === "item-type") shape.itemType = "private-secret";
    if (kind === "count") shape.itemUnknownKeys = 256;
    if (kind === "negative") shape.eventUnknownKeys = -1;
    if (kind === "nan") shape.eventUnknownKeys = NaN;
    if (kind === "flag") shape.hasMessage = "private-secret";
    if (kind === "extra-key") shape.message = "private-secret";
    if (kind === "getter")
      Object.defineProperty(shape, "eventType", {
        get: () => "private-secret",
        enumerable: true,
      });
    diagnostic.decoder!.rejectedShape = shape as unknown as NonNullable<
      ExecutionDiagnostics["decoder"]
    >["rejectedShape"];
    expect(sanitizeExecutionDiagnostics(diagnostic)).toBeUndefined();
    const h = await harness();
    const state = await new AgentSession(
      "session_a",
      h.store,
      h.ports,
      fake("answer"),
      limits,
    ).advance();
    const before = await readFile(
      path.join(h.store.directory, "session_a.json"),
      "utf8",
    );
    state.tasks.first.diagnostics = diagnostic;
    await expect(h.store.write(state)).rejects.toThrow(
      "Invalid task diagnostics",
    );
    expect(
      await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
    ).toBe(before);
    const projected = await new AgentSession(
      "session_a",
      { ...h.store, read: async () => state } as FileSessionStore,
      h.ports,
      fake("unused"),
      limits,
    ).inspect();
    expect(JSON.stringify(projected)).not.toContain("private-secret");
  },
);

test("rejected-shape descriptor snapshot never reads hostile Proxy get traps", () => {
  const diagnostic = structuredClone(safeDiagnostic);
  const shape = {
    eventType: "item.completed" as const,
    itemType: "error" as const,
    hasItem: true,
    hasId: true,
    hasType: true,
    hasText: false,
    hasMessage: true,
    eventUnknownKeys: 0,
    itemUnknownKeys: 0,
  };
  const trap = vi.fn(() => "private-secret");
  diagnostic.decoder!.rejectedShape = new Proxy(shape, { get: trap });
  expect(
    sanitizeExecutionDiagnostics(diagnostic)?.decoder?.rejectedShape,
  ).toEqual(shape);
  expect(trap).not.toHaveBeenCalled();
});

test.each([
  "extra-key",
  "unknown-stage",
  "unknown-signal",
  "negative",
  "oversized",
  "nan",
  "infinity",
  "raw-decoder",
  "getter",
])(
  "untrusted diagnostic metadata is discarded before checkpoint: %s",
  async (kind) => {
    const diagnostic = structuredClone(safeDiagnostic) as unknown as Record<
      string,
      unknown
    >;
    const process = diagnostic.process as Record<string, unknown>;
    const decoder = diagnostic.decoder as Record<string, unknown>;
    if (kind === "extra-key") diagnostic.stderr = "private-secret";
    if (kind === "unknown-stage") diagnostic.stage = "private-secret";
    if (kind === "unknown-signal") process.signal = "private-secret";
    if (kind === "negative") process.stderrBytes = -1;
    if (kind === "oversized") process.stderrBytes = 16 * 1024 * 1024 + 1;
    if (kind === "nan") process.stderrBytes = NaN;
    if (kind === "infinity") process.stderrBytes = Infinity;
    if (kind === "raw-decoder") decoder.eventType = "private-secret";
    if (kind === "getter")
      Object.defineProperty(diagnostic, "stage", {
        get: () => "private-secret",
        enumerable: true,
      });
    expect(sanitizeExecutionDiagnostics(diagnostic)).toBeUndefined();
    const h = await harness();
    const executor = fake((request) => [
      { type: "started", requestId: request.requestId },
    ]);
    const start = executor.start;
    executor.start = vi.fn(async (request) => ({
      ...(await start(request)),
      diagnostics: () => diagnostic,
    }));
    const state = await new AgentSession(
      "session_a",
      h.store,
      h.ports,
      executor,
      limits,
    ).advance();
    expect(state.stop).toBe("unknown-outcome");
    expect(state.tasks.first.diagnostics).toEqual({
      version: 1,
      stage: "dispatch",
      backendReach: "unknown",
    });
    expect(
      await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
    ).not.toContain("private-secret");
  },
);

test("descriptor snapshots ignore Proxy get traps and checkpoint writes persist only projected values", async () => {
  const payload = structuredClone(safeDiagnostic);
  const trap = vi.fn(() => "private-secret");
  payload.process = new Proxy(payload.process!, { get: trap });
  const projected = sanitizeExecutionDiagnostics(payload)!;
  expect(projected).toEqual(safeDiagnostic);
  expect(trap).not.toHaveBeenCalled();
  const h = await harness();
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    fake("answer"),
    limits,
  ).advance();
  state.tasks.first.diagnostics = payload;
  await h.store.write(state);
  expect((await h.store.read("session_a"))!.tasks.first.diagnostics).toEqual(
    safeDiagnostic,
  );
  expect(
    await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
  ).not.toContain("private-secret");
  expect(trap).not.toHaveBeenCalled();
});

test("checkpoint read/write reject forged diagnostics and custom-store inspect still projects safely", async () => {
  const h = await harness();
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    fake("answer"),
    limits,
  );
  const state = await session.advance();
  const before = await readFile(
    path.join(h.store.directory, "session_a.json"),
    "utf8",
  );
  state.tasks.first.diagnostics = {
    ...safeDiagnostic,
    stderr: "private-secret",
  } as ExecutionDiagnostics;
  await expect(h.store.write(state)).rejects.toThrow(
    "Invalid task diagnostics",
  );
  expect(
    await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
  ).toBe(before);
  await writeFile(
    path.join(h.store.directory, "session_a.json"),
    JSON.stringify({ checkpoint: state, digest: sessionDigest(state) }),
  );
  await expect(h.store.read("session_a")).rejects.toThrow(
    "Invalid task checkpoint",
  );
  vi.spyOn(h.store, "read").mockResolvedValue(state);
  expect(JSON.stringify(await session.inspect())).not.toContain(
    "private-secret",
  );
});

test("static submit failure checkpoint rejects raw CLI text and extra fields", async () => {
  const h = await harness();
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    fake("answer"),
    limits,
  ).advance();
  const file = path.join(h.store.directory, "session_a.json");
  const before = await readFile(file, "utf8");
  state.tasks.first.staticFailure = {
    exitCode: 3,
    candidate: true,
    reason: "candidate-validation",
    stderrSha256: sessionDigest("private CLI text"),
    raw: "private CLI text",
  } as never;
  await expect(h.store.write(state)).rejects.toThrow(
    "Invalid static submission failure",
  );
  expect(await readFile(file, "utf8")).toBe(before);
});

test("pre-handle authorization failure has its own stage and cannot borrow a claimed process diagnostic", async () => {
  const h = await harness();
  const decision = {
    consumeUserDecision: vi.fn(async () => {
      throw new ExecutorFailure("unknown-outcome", safeDiagnostic);
    }),
  };
  const dispatch = createAuthorizedCodexSessionDispatch(
    { executable: process.execPath, workspace: h.root, env: {} },
    "schema.json",
    decision,
  );
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    dispatch.executor,
    { ...limits, maxGenerations: 1 },
    dispatch.dispatch,
  ).advance();
  expect(state.stop).toBe("unknown-outcome");
  expect(state.tasks.first.diagnostics).toEqual({
    version: 1,
    stage: "authorization",
    backendReach: "unknown",
  });
  await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    dispatch.executor,
    { ...limits, maxGenerations: 1 },
    dispatch.dispatch,
  ).advance({ resume: true });
  expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
});

test("startup error diagnostic accessor exceptions remain contained and private", async () => {
  const h = await harness();
  const executor = fake("unused");
  executor.start = vi.fn(async () => {
    const error = new ExecutorFailure("unknown-outcome");
    Object.defineProperty(error, "diagnostics", {
      get: () => {
        throw new Error("private-secret");
      },
    });
    throw error;
  });
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(state.stop).toBe("unknown-outcome");
  expect(state.tasks.first.diagnostics).toEqual({
    version: 1,
    stage: "dispatch",
    backendReach: "unknown",
  });
  expect(
    JSON.stringify(
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).inspect(),
    ),
  ).not.toContain("private-secret");
});
test("human question stays pending; answering through trusted ports allows only unfinished work", async () => {
  const h = await harness(),
    executor = fake("answer");
  h.setPlan({
    runnable: [],
    reviewReady: false,
    questionIds: ["question_one"],
    complete: false,
  });
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  );
  expect((await session.advance()).questionIds).toEqual(["question_one"]);
  expect((await session.advance({ resume: true })).stop).toBe("question");
  expect(executor.start).not.toHaveBeenCalled();
  h.setPlan({
    runnable: [task("first")],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  expect((await session.advance({ resume: true })).status).toBe("complete");
});
test("bounded generations never reset on resume and oversized output is not submitted", async () => {
  const h = await harness(),
    executor = fake("answer");
  const session = new AgentSession("session_a", h.store, h.ports, executor, {
    ...limits,
    maxGenerations: 1,
  });
  expect((await session.advance()).stop).toBe("iteration-limit");
  expect((await session.advance({ resume: true })).stop).toBe(
    "iteration-limit",
  );
  expect(executor.start).toHaveBeenCalledOnce();
  const other = await harness();
  expect(
    (
      await new AgentSession("session_b", other.store, other.ports, executor, {
        ...limits,
        maxOutputBytes: 1,
      }).advance()
    ).stop,
  ).toBe("unknown-outcome");
  expect(other.ports.submit).not.toHaveBeenCalled();
});
test("checkpoint corruption and links fail closed, inspection does not create a checkpoint", async () => {
  const h = await harness(),
    executor = fake("answer");
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  );
  expect(await session.inspect()).toMatchObject({
    readOnly: true,
    status: "not-started",
    core: { readOnly: true },
  });
  expect(await readdir(h.root)).toEqual([]);
  await session.advance();
  const file = path.join(h.store.directory, "session_a.json");
  await writeFile(file, "{broken");
  await expect(session.advance({ resume: true })).rejects.toThrow();
  await rm(file);
  await symlink(path.join(h.root, "external.json"), file);
  await expect(session.advance({ resume: true })).rejects.toThrow();
});

async function call(root: string, ...args: string[]) {
  const values: string[] = [];
  const code = await runCli([...args, "--root", root, "--json"], {
    out: (value) => values.push(value),
    err: () => {},
  });
  expect(code).toBe(0);
  return JSON.parse(values.at(-1)!) as {
    path: string;
    submissionState: string;
  };
}
async function staticHarness(
  authority: "AUTONOMOUS" | "PROPOSE_ONLY" = "AUTONOMOUS",
) {
  const root = await temporary();
  await call(root, "init");
  const source = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  source.meta.id = "art_session_source";
  source.scope = { level: "organization", ownerId: "org_local" };
  source.lifecycle = { status: "provisional", freshness: "valid" };
  source.approval = { status: "pending" };
  source.origin = {
    actorKind: "skill",
    actorId: "mimic.fixture.source",
    runId: binding.runId,
    createdAt: "2026-10-08T00:00:00Z",
  };
  source.dependencies = [];
  const sourceRef = {
    artifactId: source.meta.id,
    revision: source.meta.revision,
    lockDigest: artifactDigest(source),
  };
  const tasks = [
    {
      id: "first",
      skillId: "mimic.session.fixture",
      outputType: "system-capability",
      scopeOwnerId: "org_local",
      inputs: {
        required: [
          { name: "brief", kind: "human-brief" },
          {
            name: "source",
            kind: "artifact",
            artifactType: "product-definition",
            schemaVersion: "1.0.0",
            refs: [sourceRef],
          },
        ],
        optional: [],
        alternatives: [],
      },
      humanBrief: "Read fixture evidence only",
      intent: "create",
      authority,
    },
  ];
  await writeFile(path.join(root, "tasks.json"), JSON.stringify(tasks));
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, ".mimic/workspace.json")),
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    [{ level: "organization", ownerId: "org_local" }],
    { verify: async () => false, allowCommit: async () => false },
  );
  await runtime.registry.start({
    id: binding.runId,
    scope: "org_local",
    entryMode: "hybrid",
    base: [],
    reused: [],
    safeActions: ["first"],
    actor: { kind: "agent", id: "fixture" },
    at: source.origin.createdAt,
    reason: "Fixture source plus downstream task",
  });
  await runtime.artifacts.create(source);
  await runtime.registry.produce({
    runId: binding.runId,
    ref: sourceRef,
    inputs: [],
    actor: { kind: "skill", id: source.origin.actorId },
    at: source.origin.createdAt,
    reason: "Fixture source",
  });
  await call(root, "run", "--tasks", "tasks.json", "--id", binding.runId);
  await mkdir(path.join(root, "skill"));
  await writeFile(
    path.join(root, "skill/SKILL.md"),
    "# Test-only Skill\nRead supplied context. Do not approve.\n",
  );
  await writeFile(path.join(root, "skill/example.json"), "{}");
  await writeFile(path.join(root, "skill/test.json"), "{}");
  await writeFile(
    path.join(root, "skill/manifest.json"),
    JSON.stringify({
      skillId: tasks[0].skillId,
      manifestVersion: "1.0.0",
      packageVersion: "0.1.0",
      skillFile: "SKILL.md",
      inputs: {
        ...tasks[0].inputs,
        required: tasks[0].inputs.required.map((input) =>
          Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== "refs"),
          ),
        ),
      },
      outputs: ["system-capability"],
      forbiddenResponsibilities: ["Do not approve"],
      humanGates:
        authority === "PROPOSE_ONLY"
          ? [{ decision: "system-change", authority }]
          : [],
      supportedArtifactSchemas: [
        { artifactType: "system-capability", schemaVersion: "1.0.0" },
        { artifactType: "product-definition", schemaVersion: "1.0.0" },
      ],
      examples: ["example.json"],
      tests: ["test.json"],
    }),
  );
  const candidate = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/system-capability.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  candidate.meta.id = "art_session_output";
  candidate.scope = { level: "organization", ownerId: "org_local" };
  candidate.lifecycle = { status: "provisional", freshness: "valid" };
  candidate.approval = { status: "pending" };
  candidate.origin = {
    actorKind: "skill",
    actorId: tasks[0].skillId,
    runId: binding.runId,
    createdAt: "2026-10-08T00:00:00Z",
  };
  candidate.dependencies = [{ ...sourceRef, onChange: "invalidate" }];
  const outputRef = {
    artifactId: candidate.meta.id,
    revision: candidate.meta.revision,
    lockDigest: artifactDigest(candidate),
  };
  const output = JSON.stringify({
    artifacts: [candidate],
    work: {
      result: {
        runId: binding.runId,
        taskId: "first",
        skillId: tasks[0].skillId,
        inputRefs: [sourceRef],
        outputRefs: [outputRef],
      },
    },
  });
  const ports = await createWorkspaceSessionPorts({
    workspace: root,
    runId: binding.runId,
    sessionId: "session_a",
    packages: { first: "skill" },
    settings: binding.settings,
  });
  const frozen = (await ports.next()).runnable[0].binding;
  return {
    root,
    runtime,
    ports,
    output,
    frozen,
    store: new FileSessionStore(root),
  };
}
test("real static validation rejects invalid model work before submission reservation", async () => {
  const h = await staticHarness();
  const candidate = JSON.parse(h.output);
  candidate.artifacts[0].dependencies[0].onChange = "freeform explanation";
  candidate.work.result.outputRefs[0].lockDigest = HOST_DERIVED_DIGEST;
  const saved = await h.ports.saveWork(h.frozen, JSON.stringify(candidate));
  await expect(h.ports.submit(h.frozen, saved)).rejects.toMatchObject({
    reason: "static-validation",
  });
  expect(
    await readdir(path.join(h.root, ".mimic", "submissions")).catch(() => []),
  ).toEqual([]);
  const snapshot = await h.runtime.registry.snapshot();
  expect(snapshot.runs[binding.runId].artifacts).toHaveLength(1);
  expect(await readFile(path.join(h.root, saved.path), "utf8")).toContain(
    "freeform explanation",
  );
});
test("generation prompt requires unique provenance pointers", async () => {
  const h = await staticHarness();
  const runnable = (await h.ports.next()).runnable[0];
  expect(runnable.prompt).toContain(
    "Each exact provenance.path may occur only once per artifact",
  );
});
test("proposed output is rejected before marker under AUTONOMOUS authority with a bounded actual CLI reason", async () => {
  const h = await staticHarness();
  const candidate = JSON.parse(h.output);
  candidate.artifacts[0].lifecycle.status = "proposed";
  candidate.work.result.outputRefs[0].lockDigest = HOST_DERIVED_DIGEST;
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    fake(JSON.stringify(candidate)),
    limits,
  ).advance();
  expect(state.stop).toBe("candidate-rejected");
  expect(state.tasks.first).toMatchObject({
    phase: "rejected",
    rejectionReason: "static-validation",
    staticFailure: {
      exitCode: 3,
      candidate: true,
      reason: "proposal-authority-mismatch",
    },
  });
  expect(state.tasks.first.staticFailure?.stderrSha256).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(
    await readdir(path.join(h.root, ".mimic/submissions")).catch(() => []),
  ).toEqual([]);
  expect((await h.runtime.registry.snapshot()).events).toHaveLength(2);
  expect(
    JSON.stringify(
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        fake("unused"),
        limits,
      ).inspect(),
    ),
  ).not.toContain("Proposed output requires");
});
test("PROPOSE_ONLY proposal remains pending and identical static retry does not duplicate Core effects", async () => {
  const h = await staticHarness("PROPOSE_ONLY");
  const candidate = JSON.parse(h.output);
  candidate.artifacts[0].lifecycle.status = "proposed";
  candidate.work.result.outputRefs[0].lockDigest = HOST_DERIVED_DIGEST;
  candidate.work.result.proposal = {
    packetId: "packet_session_output",
    reason: "Human review of a candidate, not adoption",
    items: [
      {
        id: "proposal_session_output",
        ref: { ...candidate.work.result.outputRefs[0] },
        alternatives: ["Keep the existing capability"],
        rationale: "Review the proposed capability boundary",
        evidenceLimits: ["No human adoption recorded"],
        dependents: [],
      },
    ],
  };
  const provisional = structuredClone(candidate.artifacts[0]);
  provisional.meta.id = "art_session_provisional_domain";
  provisional.lifecycle.status = "provisional";
  candidate.artifacts.unshift(provisional);
  candidate.work.result.outputRefs.unshift({
    artifactId: provisional.meta.id,
    revision: provisional.meta.revision,
    lockDigest: HOST_DERIVED_DIGEST,
  });
  const saved = await h.ports.saveWork(h.frozen, JSON.stringify(candidate));
  const first = await h.ports.submit(h.frozen, saved);
  const before = await h.runtime.registry.snapshot();
  expect(before.packets.packet_session_output).toBeDefined();
  expect(
    before.runs[binding.runId].proposals.proposal_session_output.status,
  ).toBe("pending");
  expect(before.canonical).toEqual({});
  expect(await h.ports.submit(h.frozen, saved)).toEqual(first);
  expect(await h.runtime.registry.snapshot()).toEqual(before);
});
test("a proposed output without its review proposal is rejected before marker", async () => {
  const h = await staticHarness("PROPOSE_ONLY");
  const candidate = JSON.parse(h.output);
  candidate.artifacts[0].lifecycle.status = "proposed";
  candidate.work.result.outputRefs[0].lockDigest = HOST_DERIVED_DIGEST;
  const saved = await h.ports.saveWork(h.frozen, JSON.stringify(candidate));
  await expect(h.ports.submit(h.frozen, saved)).rejects.toMatchObject({
    staticFailure: { reason: "proposal-binding-missing", candidate: true },
  });
  expect(
    await readdir(path.join(h.root, ".mimic/submissions")).catch(() => []),
  ).toEqual([]);
});
test.each([
  {},
  { items: [null] },
  { items: [{}] },
  {
    summary: "Review all outputs",
    items: [{ ref: { artifactId: "art_session_output", revision: 1 } }],
  },
])(
  "a malformed review proposal is a candidate error before marker (%j)",
  async (proposal) => {
    const h = await staticHarness("PROPOSE_ONLY");
    const candidate = JSON.parse(h.output);
    candidate.artifacts[0].lifecycle.status = "proposed";
    candidate.work.result.outputRefs[0].lockDigest = artifactDigest(
      candidate.artifacts[0],
    );
    candidate.work.result.proposal = proposal;
    await writeFile(
      path.join(h.root, "malformed.json"),
      JSON.stringify(candidate),
    );
    const errors: string[] = [];
    const code = await runCli(
      [
        "submit",
        binding.runId,
        "--task",
        "first",
        "--package",
        "skill",
        "--work",
        "malformed.json",
        "--root",
        h.root,
        "--json",
      ],
      { out: () => {}, err: (value) => errors.push(value) },
    );
    expect(code).toBe(3);
    expect(errors.join("\n")).toContain("Invalid review proposal packet");
    expect(
      await readdir(path.join(h.root, ".mimic/submissions")).catch(() => []),
    ).toEqual([]);
  },
);
test("post-marker Core durability rejection keeps its generic reason and exact work for safe retry", async () => {
  const h = await staticHarness();
  const candidate = JSON.parse(h.output);
  const unexpected = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  unexpected.meta.id = "art_unexpected_output";
  unexpected.scope = { level: "organization", ownerId: "org_local" };
  unexpected.lifecycle = { status: "provisional", freshness: "valid" };
  unexpected.approval = { status: "pending" };
  unexpected.origin = candidate.artifacts[0].origin;
  unexpected.dependencies = candidate.artifacts[0].dependencies;
  candidate.artifacts = [unexpected];
  candidate.work.result.outputRefs = [
    {
      artifactId: unexpected.meta.id,
      revision: unexpected.meta.revision,
      lockDigest: HOST_DERIVED_DIGEST,
    },
  ];
  const executor = fake(JSON.stringify(candidate));
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  );
  const stopped = await session.advance();
  expect(stopped).toMatchObject({
    stop: "unknown-outcome",
    tasks: {
      first: {
        phase: "prepared",
        staticFailure: {
          candidate: false,
          reason: "output-contract-rejected",
        },
      },
    },
  });
  const markerDirectory = path.join(h.root, ".mimic/submissions");
  const names = await readdir(markerDirectory);
  expect(names).toHaveLength(1);
  const marker = await readFile(path.join(markerDirectory, names[0]!), "utf8");
  const before = await h.runtime.registry.snapshot();
  expect(before.events).toHaveLength(2);
  expect((await session.advance({ resume: true })).stop).toBe(
    "unknown-outcome",
  );
  expect(await readFile(path.join(markerDirectory, names[0]!), "utf8")).toBe(
    marker,
  );
  expect(await h.runtime.registry.snapshot()).toEqual(before);
  expect(executor.start).toHaveBeenCalledOnce();
});
test("workspace configuration failure preserves saved candidate for retry", async () => {
  const h = await staticHarness();
  const saved = await h.ports.saveWork(h.frozen, h.output);
  const file = path.join(h.root, ".mimic/config.json");
  const original = await readFile(file, "utf8");
  await writeFile(file, "{}");
  await expect(h.ports.submit(h.frozen, saved)).rejects.toMatchObject({
    code: 3,
    candidate: false,
  });
  expect(await readFile(path.join(h.root, saved.path), "utf8")).toContain(
    '"artifacts"',
  );
  await writeFile(file, original);
  expect((await h.ports.submit(h.frozen, saved)).length).toBeGreaterThan(0);
});
test("real static CLI reconciles acceptance after a lost response; fresh resume never regenerates or approves", async () => {
  const h = await staticHarness(),
    executor = fake(h.output);
  const submit = h.ports.submit;
  let lost = true;
  h.ports.submit = async (...args) => {
    const refs = await submit(...args);
    if (lost) {
      lost = false;
      throw new SessionStaticSubmissionFailure({
        exitCode: 5,
        candidate: false,
        reason: "unclassified",
        stderrSha256: sessionDigest("private CLI diagnostic"),
      });
    }
    return refs;
  };
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).stop,
  ).toBe("unknown-outcome");
  expect((await h.store.read("session_a"))?.tasks.first.staticFailure).toEqual({
    exitCode: 5,
    candidate: false,
    reason: "unclassified",
    stderrSha256: sessionDigest("private CLI diagnostic"),
  });
  expect(
    JSON.stringify(
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).inspect(),
    ),
  ).not.toContain("private CLI diagnostic");
  const before = await h.runtime.registry.snapshot();
  expect(before.runs[binding.runId].artifacts).toHaveLength(2);
  const resumed = await new AgentSession(
    "session_a",
    new FileSessionStore(h.store.workspace, h.store.relativeDirectory),
    h.ports,
    executor,
    limits,
  ).advance({ resume: true });
  expect(resumed.status).toBe("complete");
  expect(executor.start).toHaveBeenCalledOnce();
  const after = await h.runtime.registry.snapshot();
  expect(after.events).toEqual(before.events);
  expect(after.canonical).toEqual({});
  expect(after.decisions).toEqual({});
  const workspaceBefore = await readFile(
    path.join(h.root, ".mimic/workspace.json"),
    "utf8",
  );
  expect(
    await new AgentSession(
      "session_a",
      h.store,
      h.ports,
      executor,
      limits,
    ).inspect(),
  ).toMatchObject({
    readOnly: true,
    status: "complete",
    core: { core: { readOnly: true, runs: [{ runId: binding.runId }] } },
  });
  expect(
    await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
  ).toBe(workspaceBefore);
});
test("real static submission rejects changed saved work and changed Skill package", async () => {
  const h = await staticHarness();
  const saved = await h.ports.saveWork(h.frozen, h.output);
  await writeFile(path.join(h.root, saved.path), "{}");
  await expect(h.ports.submit(h.frozen, saved)).rejects.toThrow(
    "Saved work changed",
  );
  const another = await staticHarness();
  const work = await another.ports.saveWork(another.frozen, another.output);
  await writeFile(path.join(another.root, "skill/SKILL.md"), "# Changed\n");
  await expect(another.ports.submit(another.frozen, work)).rejects.toThrow(
    "Frozen session binding changed",
  );
});

test("host-derived candidate locks accept through Core, retain raw provenance and resume without generation", async () => {
  const h = await staticHarness();
  const generated = JSON.parse(h.output);
  generated.work.result.outputRefs[0].lockDigest = HOST_DERIVED_DIGEST;
  const output = JSON.stringify(generated, null, 3);
  const executor = fake(output);
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(state.status).toBe("complete");
  const saved = state.tasks.first.work!;
  const prepared = JSON.parse(
    await readFile(path.join(h.root, saved.path), "utf8"),
  );
  expect(prepared.artifacts).toEqual(generated.artifacts);
  expect(prepared.work.result.inputRefs).toEqual(
    generated.work.result.inputRefs,
  );
  expect(prepared.work.result.outputRefs).toEqual(
    JSON.parse(h.output).work.result.outputRefs,
  );
  expect(saved.digest).toBe(sessionDigest(prepared));
  const rawFile = path.join(
    h.root,
    ".mimic/agent-work",
    `session_a-first-${sessionDigest(output)}.raw.json`,
  );
  expect(JSON.parse(await readFile(rawFile, "utf8"))).toEqual({
    version: 1,
    output,
    outputDigest: sessionDigest(output),
    normalizedDigest: saved.digest,
  });
  expect((await stat(rawFile)).mode & 0o777).toBe(0o600);
  const before = await h.runtime.registry.snapshot();
  const resumed = await new AgentSession(
    "session_a",
    new FileSessionStore(h.root),
    h.ports,
    executor,
    limits,
  ).advance({ resume: true });
  expect(resumed.status).toBe("complete");
  expect(executor.start).toHaveBeenCalledOnce();
  expect(await h.runtime.registry.snapshot()).toEqual(before);
  expect(before.canonical).toEqual({});
  expect(before.decisions).toEqual({});
});

test.each(["missing", "marker", "correct"])(
  "fresh proposal/request hashes are derived narrowly (%s)",
  async (mode) => {
    const h = await staticHarness();
    const generated = JSON.parse(h.output);
    const fresh = generated.work.result.outputRefs[0];
    if (mode === "missing") delete fresh.lockDigest;
    if (mode === "marker") fresh.lockDigest = HOST_DERIVED_DIGEST;
    generated.work.result.proposal = {
      items: [
        {
          id: "proposal_output",
          ref: { ...fresh },
          rationale: "Candidate requires human review",
        },
      ],
    };
    generated.work.revisionRequests = [
      {
        runId: binding.runId,
        source: { ...h.frozen.inputRefs[0] },
        request: { ...fresh },
        affectedLocks: [{ ...h.frozen.inputRefs[0] }],
        reason: "Explicit upstream question",
        evidenceRefs: ["evidence://fixture"],
      },
    ];
    const originalArtifacts = structuredClone(generated.artifacts);
    const saved = await h.ports.saveWork(h.frozen, JSON.stringify(generated));
    const prepared = JSON.parse(
      await readFile(path.join(h.root, saved.path), "utf8"),
    );
    const expected = JSON.parse(h.output).work.result.outputRefs[0];
    expect(prepared.work.result.outputRefs).toEqual([expected]);
    expect(prepared.work.result.proposal.items[0].ref).toEqual(expected);
    expect(prepared.work.revisionRequests[0].request).toEqual(expected);
    expect(prepared.artifacts).toEqual(originalArtifacts);
    expect(prepared.work.result.inputRefs).toEqual(
      generated.work.result.inputRefs,
    );
    expect(prepared.work.revisionRequests[0].source).toEqual(
      generated.work.revisionRequests[0].source,
    );
    expect(prepared.work.revisionRequests[0].affectedLocks).toEqual(
      generated.work.revisionRequests[0].affectedLocks,
    );
  },
);

test("raw provenance is immutable and a damaged existing receipt prevents saving", async () => {
  const h = await staticHarness();
  const saved = await h.ports.saveWork(h.frozen, h.output);
  expect(await h.ports.saveWork(h.frozen, h.output)).toEqual(saved);
  const raw = path.join(
    h.root,
    ".mimic/agent-work",
    `session_a-first-${sessionDigest(h.output)}.raw.json`,
  );
  await writeFile(raw, "{}");
  await expect(h.ports.saveWork(h.frozen, h.output)).rejects.toThrow(
    "Saved work changed",
  );
  expect(await h.runtime.registry.snapshot()).toMatchObject({
    canonical: {},
    decisions: {},
  });
});

test.each(["output", "proposal", "request", "content"])(
  "wrong concrete %s digest fails before any immutable work reservation",
  async (where) => {
    const h = await staticHarness();
    const generated = JSON.parse(h.output);
    const wrong = {
      ...generated.work.result.outputRefs[0],
      lockDigest: `sha256:${"0".repeat(64)}`,
    };
    if (where === "output") generated.work.result.outputRefs = [wrong];
    if (where === "proposal")
      generated.work.result.proposal = { items: [{ ref: wrong }] };
    if (where === "request")
      generated.work.revisionRequests = [{ request: wrong }];
    if (where === "content")
      generated.artifacts[0].meta.contentDigest = wrong.lockDigest;
    const before = await h.runtime.registry.snapshot();
    await expect(
      h.ports.saveWork(h.frozen, JSON.stringify(generated)),
    ).rejects.toMatchObject({ reason: "preparation" });
    expect(await readdir(path.join(h.root, ".mimic/agent-work"))).toEqual([
      expect.stringMatching(/\.rejected\.raw\.json$/),
    ]);
    expect(await h.runtime.registry.snapshot()).toEqual(before);
  },
);

test.each([
  "artifacts",
  "outputs",
  "proposals",
  "requests",
  "input-replacement",
  "unemitted",
  "unknown-handoff",
])(
  "ambiguous or unauthorized generated refs are rejected (%s)",
  async (kind) => {
    const h = await staticHarness();
    const generated = JSON.parse(h.output);
    const fresh = generated.work.result.outputRefs[0];
    fresh.lockDigest = HOST_DERIVED_DIGEST;
    if (kind === "artifacts")
      generated.artifacts.push(structuredClone(generated.artifacts[0]));
    if (kind === "outputs") generated.work.result.outputRefs.push({ ...fresh });
    if (kind === "proposals")
      generated.work.result.proposal = {
        items: [{ ref: { ...fresh } }, { ref: { ...fresh } }],
      };
    if (kind === "requests")
      generated.work.revisionRequests = [
        { request: { ...fresh } },
        { request: { ...fresh } },
      ];
    if (kind === "input-replacement") {
      generated.artifacts[0].meta.id = h.frozen.inputRefs[0].artifactId;
      generated.artifacts[0].meta.revision = h.frozen.inputRefs[0].revision;
    }
    if (kind === "unemitted") generated.artifacts = [];
    if (kind === "unknown-handoff")
      generated.work.revisionRequests = [
        { request: { ...fresh, artifactId: "art_not_emitted" } },
      ];
    await expect(
      h.ports.saveWork(h.frozen, JSON.stringify(generated)),
    ).rejects.toThrow();
    expect(await readdir(path.join(h.root, ".mimic/agent-work"))).toEqual([
      expect.stringMatching(/\.rejected\.raw\.json$/),
    ]);
  },
);

test("legal inherited-property task IDs run and remain accepted after reload", async () => {
  const h = await harness(),
    executor = fake("answer");
  h.setPlan({
    runnable: [task("constructor"), task("toString")],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).status,
  ).toBe("complete");
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).status,
  ).toBe("complete");
  expect(executor.start).toHaveBeenCalledTimes(2);
});
test("completed checkpoints still validate accepted authority on reopen", async () => {
  const h = await harness(),
    executor = fake("answer");
  h.setPlan({
    runnable: [task("first")],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).status,
  ).toBe("complete");
  h.accepted.clear();
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance({ resume: true })
    ).stop,
  ).toBe("unknown-outcome");
  expect(executor.start).toHaveBeenCalledOnce();
});
test("deadline includes executor startup; unresolved process keeps its live lease, even explicit reconcile cannot retry", async () => {
  const h = await harness(),
    executor = fake("answer");
  executor.describe = () => new Promise(() => {});
  const session = new AgentSession("session_a", h.store, h.ports, executor, {
    ...limits,
    timeoutMs: 20,
  });
  expect((await session.advance()).stop).toBe("timeout");
  await expect(
    new AgentSession("session_a", h.store, h.ports, executor, limits).advance({
      resume: true,
      reconciledUnknownOutcome: true,
    }),
  ).rejects.toThrow();
  await expect(h.store.recoverAbandonedLock("session_a")).rejects.toThrow(
    "still alive",
  );
  expect(executor.start).not.toHaveBeenCalled();
});
test("explicit abandoned-lock recovery requires a dead owner and preserves checkpoint", async () => {
  const h = await harness();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await mkdir(h.store.directory);
  const lock = path.join(h.store.directory, "session_a.lock");
  await mkdir(lock);
  await writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid, host: os.hostname(), nonce: "dead-owner-fixture" }),
  );
  await h.store.recoverAbandonedLock("session_a");
  await expect(
    h.store.exclusive("session_a", async () => "recovered"),
  ).resolves.toBe("recovered");
  await h.store.exclusive("session_a", async () => {
    await expect(h.store.recoverAbandonedLock("session_a")).rejects.toThrow(
      "still alive",
    );
  });
});
test("rejects linked checkpoint ancestors before writing anything outside workspace", async () => {
  const root = await temporary(),
    external = await temporary();
  await writeFile(path.join(external, "marker"), "unchanged");
  await symlink(external, path.join(root, ".mimic"));
  const store = new FileSessionStore(root);
  await expect(store.exclusive("session_a", async () => {})).rejects.toThrow(
    "link",
  );
  expect(await readdir(external)).toEqual(["marker"]);
  expect(await readFile(path.join(external, "marker"), "utf8")).toBe(
    "unchanged",
  );
});
test("a human answer changing frozen context requires a new Core Run, not retry of accepted old input", async () => {
  const h = await harness(),
    executor = fake("answer");
  h.setPlan({
    runnable: [task("first")],
    reviewReady: false,
    questionIds: ["question_one"],
    complete: false,
  });
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).stop,
  ).toBe("question");
  h.setPlan({
    runnable: [
      {
        ...task("first"),
        binding: {
          ...task("first").binding,
          contextDigest: sessionDigest("human answer"),
        },
      },
    ],
    reviewReady: false,
    questionIds: [],
    complete: true,
  });
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance({ resume: true })
    ).stop,
  ).toBe("reservation-invalid");
  expect(executor.start).toHaveBeenCalledOnce();
});

test("binding changes during generation stop before saving/submitting model work", async () => {
  const h = await harness();
  const executor = fake((request) => {
    h.setBinding({ ...binding, runId: "different_run" });
    return [
      { type: "started", requestId: request.requestId },
      { type: "completed", output: "answer" },
    ];
  });
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance()
    ).stop,
  ).toBe("reservation-invalid");
  expect(h.ports.saveWork).not.toHaveBeenCalled();
  expect(h.ports.submit).not.toHaveBeenCalled();
});
test("unsettled stream cancellation preserves a live lease and refuses all retry acknowledgments", async () => {
  const h = await harness(),
    executor = fake("answer");
  executor.start = vi.fn(async (request) => ({
    cancel: () => new Promise(() => {}),
    events: (async function* () {
      yield { type: "started", requestId: request.requestId } as const;
      await new Promise(() => {});
    })(),
  }));
  const session = new AgentSession("session_a", h.store, h.ports, executor, {
    ...limits,
    timeoutMs: 20,
  });
  expect((await session.advance()).stop).toBe("timeout");
  await expect(
    new AgentSession("session_a", h.store, h.ports, executor, limits).advance({
      resume: true,
      reconciledUnknownOutcome: true,
    }),
  ).rejects.toThrow();
  expect(executor.start).toHaveBeenCalledOnce();
  expect(h.ports.submit).not.toHaveBeenCalled();
});
test("explicit cancel settles a live generation; accepted work remains intact on fresh resume", async () => {
  const h = await harness(),
    executor = fake("answer");
  let release: (() => void) | undefined;
  let starts = 0;
  const ordinary = executor.start;
  executor.start = vi.fn(async (request) => {
    starts++;
    if (starts !== 2) return ordinary(request);
    return {
      cancel: async () => release?.(),
      events: (async function* () {
        yield { type: "started", requestId: request.requestId } as const;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
    };
  });
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  );
  const running = session.advance();
  await vi.waitFor(() => expect(release).toBeDefined());
  await session.cancel();
  expect((await running).stop).toBe("cancelled");
  expect(h.accepted).toEqual(new Set(["first"]));
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance({ resume: true, reconciledUnknownOutcome: true })
    ).stop,
  ).toBe("approval");
  expect(starts).toBe(3);
});
test("credential-shaped evidence names are refused before prompt generation", async () => {
  for (const name of [".env", ".env.local", ".env.production"]) {
    const h = await staticHarness();
    const tasks = JSON.parse(
      await readFile(path.join(h.root, ".mimic/runs/run_session.json"), "utf8"),
    );
    tasks[0].evidenceFiles = [name];
    tasks[0].inputs.required.push({ name: "evidence", kind: "evidence-file" });
    await writeFile(
      path.join(h.root, ".mimic/runs/run_session.json"),
      JSON.stringify(tasks),
    );
    await writeFile(
      path.join(h.root, name),
      "EXAMPLE_SECRET=must-not-be-prompted",
    );
    const ports = await createWorkspaceSessionPorts({
      workspace: h.root,
      runId: binding.runId,
      sessionId: "session_other",
      packages: { first: "skill" },
      settings: binding.settings,
    });
    await expect(ports.next()).rejects.toThrow("credential/runtime metadata");
  }
});
test("actual Core blocked Skill question survives exact reconciliation; human answer creates a new Run and fresh session", async () => {
  const h = await staticHarness();
  const question =
    "Is the selected item guaranteed fresh? An unspecified answer is acceptable.";
  const blocked = JSON.stringify({
    artifacts: [],
    work: {
      result: {
        runId: binding.runId,
        taskId: "first",
        skillId: "mimic.session.fixture",
        inputRefs: h.frozen.inputRefs,
        outputRefs: [],
        blocked: { reason: question, affectedTaskIds: ["first"] },
      },
      unknowns: [{ question, affectedTaskIds: ["first"] }],
    },
  });
  const executor = fake(blocked);
  const first = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(first.stop).toBe("question");
  expect(first.tasks.first.phase).toBe("blocked");
  const checkpointBefore = await readFile(
    path.join(h.store.directory, "session_a.json"),
    "utf8",
  );
  const workspaceBefore = await readFile(
    path.join(h.root, ".mimic/workspace.json"),
    "utf8",
  );
  const inspected = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).inspect();
  expect(inspected).toMatchObject({
    readOnly: true,
    stop: "question",
    questionIds: ["first"],
    core: {
      questions: [
        {
          taskId: "first",
          questions: [{ question }],
          requiresHumanAnswer: true,
          changesRequireNewRun: true,
        },
      ],
    },
  });
  expect(
    await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
  ).toBe(checkpointBefore);
  expect(
    await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
  ).toBe(workspaceBefore);
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance({ resume: true })
    ).stop,
  ).toBe("question");
  expect(executor.start).toHaveBeenCalledOnce();
  expect(
    await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
  ).toBe(workspaceBefore);
  const tasks = JSON.parse(
    await readFile(path.join(h.root, ".mimic/runs/run_session.json"), "utf8"),
  );
  tasks[0].inputs = {
    required: [{ name: "brief", kind: "human-brief" }],
    optional: [],
    alternatives: [],
  };
  tasks[0].humanBrief =
    "Authoritative human answer: freshness is unspecified; do not invent a guarantee.";
  await writeFile(
    path.join(h.root, "answer-tasks.json"),
    JSON.stringify(tasks),
  );
  await call(
    h.root,
    "run",
    "--tasks",
    "answer-tasks.json",
    "--id",
    "run_answered",
  );
  await mkdir(path.join(h.root, "answer-skill"));
  for (const file of ["SKILL.md", "example.json", "test.json"])
    await writeFile(
      path.join(h.root, "answer-skill", file),
      await readFile(path.join(h.root, "skill", file)),
    );
  const manifest = JSON.parse(
    await readFile(path.join(h.root, "skill/manifest.json"), "utf8"),
  );
  manifest.inputs = tasks[0].inputs;
  manifest.packageVersion = "0.2.0";
  await writeFile(
    path.join(h.root, "answer-skill/manifest.json"),
    JSON.stringify(manifest),
  );
  const answeredPorts = await createWorkspaceSessionPorts({
    workspace: h.root,
    runId: "run_answered",
    sessionId: "session_answered",
    packages: { first: "answer-skill" },
    settings: binding.settings,
  });
  const runnable = (await answeredPorts.next()).runnable[0];
  expect(runnable.prompt).toContain(tasks[0].humanBrief);
  const envelope = JSON.parse(h.output);
  envelope.artifacts[0].meta.id = "art_answered_output";
  envelope.artifacts[0].origin.runId = "run_answered";
  envelope.artifacts[0].dependencies = [];
  envelope.artifacts[0].content.summary =
    "Human confirmed freshness is unspecified.";
  envelope.work.result.runId = "run_answered";
  envelope.work.result.inputRefs = [];
  envelope.work.result.outputRefs = [
    {
      artifactId: "art_answered_output",
      revision: 1,
      lockDigest: artifactDigest(envelope.artifacts[0]),
    },
  ];
  const answered = await new AgentSession(
    "session_answered",
    h.store,
    answeredPorts,
    fake(JSON.stringify(envelope)),
    limits,
  ).advance();
  expect(answered.status).toBe("complete");
  const state = await h.runtime.registry.snapshot();
  expect(state.runs.run_session.blockers.first).toBe(question);
  expect(state.runs.run_answered.artifacts).toHaveLength(1);
  expect(state.canonical).toEqual({});
  expect(state.decisions).toEqual({});
});

test("late startup handles are cancelled and cannot escape the retained owner lease", async () => {
  const h = await harness(),
    executor = fake("answer");
  let resolveStart:
    ((handle: Awaited<ReturnType<AgentExecutor["start"]>>) => void) | undefined;
  const cancelled = vi.fn(async () => {});
  executor.start = vi.fn(
    async () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  );
  expect(
    (
      await new AgentSession("session_a", h.store, h.ports, executor, {
        ...limits,
        timeoutMs: 20,
      }).advance()
    ).stop,
  ).toBe("timeout");
  resolveStart!({ cancel: cancelled, events: (async function* () {})() });
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  await expect(
    new AgentSession("session_a", h.store, h.ports, executor, limits).advance({
      resume: true,
      reconciledUnknownOutcome: true,
    }),
  ).rejects.toThrow();
});
test("foreign lock owners and ownerless lock records are not removed", async () => {
  const h = await harness();
  await mkdir(h.store.directory);
  const lock = path.join(h.store.directory, "session_a.lock");
  await mkdir(lock);
  await writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      host: "different-machine",
      nonce: "foreign-owner",
    }),
  );
  await expect(h.store.recoverAbandonedLock("session_a")).rejects.toThrow(
    "Unknown session lock owner",
  );
  await rm(path.join(lock, "owner.json"));
  await expect(h.store.recoverAbandonedLock("session_a")).rejects.toThrow();
  expect(await stat(lock)).toBeDefined();
});
test("malformed saved task IDs fail before context/work files can be created", async () => {
  const h = await staticHarness();
  const file = path.join(h.root, ".mimic/runs/run_session.json");
  const tasks = JSON.parse(await readFile(file, "utf8"));
  tasks[0].id = "first/../../outside";
  await writeFile(file, JSON.stringify(tasks));
  const before = await readdir(path.join(h.root, ".mimic/agent-context"));
  await expect(
    createWorkspaceSessionPorts({
      workspace: h.root,
      runId: binding.runId,
      sessionId: "session_other",
      packages: { [tasks[0].id]: "skill" },
      settings: binding.settings,
    }),
  ).rejects.toThrow("Invalid session task IDs");
  expect(await readdir(path.join(h.root, ".mimic/agent-context"))).toEqual(
    before,
  );
});

test("actual workspace changes while model runs persist reservation-invalid before Core effects", async () => {
  const h = await staticHarness(),
    executor = fake(h.output);
  const original = executor.start;
  executor.start = async (request) => {
    const file = path.join(h.root, ".mimic/runs/run_session.json");
    const tasks = JSON.parse(await readFile(file, "utf8"));
    tasks[0].humanBrief = "Changed while running";
    await writeFile(file, JSON.stringify(tasks));
    return original(request);
  };
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(state.stop).toBe("reservation-invalid");
  expect(
    (await h.runtime.registry.snapshot()).runs.run_session.artifacts,
  ).toHaveLength(1);
  expect(state.tasks.first.work).toBeUndefined();
  expect(
    (
      await new AgentSession(
        "session_a",
        h.store,
        h.ports,
        executor,
        limits,
      ).advance({ resume: true })
    ).stop,
  ).toBe("reservation-invalid");
});

test("runnable entry inspects without a checkpoint or launch, and fixed official-adapter start/resume stay billing-gated", async () => {
  const h = await staticHarness();
  const executable = path.join(h.root, "fake-metadata-only-cli");
  const log = path.join(h.root, "metadata-calls.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(new URL('./metadata-calls.jsonl', import.meta.url), JSON.stringify({args,hasApiKey:Object.hasOwn(process.env,'OPENAI_API_KEY'),hasEndpoint:Object.hasOwn(process.env,'OPENAI_BASE_URL'),hasNodeInjection:Object.hasOwn(process.env,'NODE_OPTIONS')})+'\\n');\nif(args.join(' ')==='--version') console.log('codex-cli 0.160.0');\nelse if(args.join(' ')==='login status') console.error('Logged in using ChatGPT');\nelse process.exitCode=99;\n`,
  );
  await chmod(executable, 0o700);
  const configuration = path.join(h.root, "session-config.json");
  await writeFile(
    configuration,
    JSON.stringify({
      workspace: h.root,
      runId: binding.runId,
      sessionId: "session_a",
      packages: { first: "skill" },
      model: "fixture-model",
      executable,
      timeoutMs: 1000,
    }),
  );
  const output: string[] = [],
    errors: string[] = [];
  const io = {
    out: (value: string) => output.push(value),
    err: (value: string) => errors.push(value),
  };
  expect(await runSessionCli(["inspect", "--config", configuration], io)).toBe(
    0,
  );
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    readOnly: true,
    status: "not-started",
  });
  await expect(stat(h.store.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
  vi.stubEnv("OPENAI_API_KEY", "fake-secret-never-copied");
  vi.stubEnv("OPENAI_BASE_URL", "https://invalid.example/never-used");
  vi.stubEnv("NODE_OPTIONS", "--invalid-never-inherited");
  expect(await runSessionCli(["start", "--config", configuration], io)).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    status: "stopped",
    stop: "billing-unconfirmed",
  });
  const first = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(first).toEqual([
    {
      args: ["--version"],
      hasApiKey: false,
      hasEndpoint: false,
      hasNodeInjection: false,
    },
    {
      args: ["login", "status"],
      hasApiKey: false,
      hasEndpoint: false,
      hasNodeInjection: false,
    },
  ]);
  expect(await runSessionCli(["resume", "--config", configuration], io)).toBe(
    0,
  );
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    status: "stopped",
    stop: "billing-unconfirmed",
  });
  expect(errors).toEqual([]);
  expect(output.join("\n")).not.toContain("fake-secret");
  expect(
    (await h.runtime.registry.snapshot()).runs.run_session.artifacts,
  ).toHaveLength(1);
  const invalid = JSON.parse(await readFile(configuration, "utf8"));
  invalid.billingMode = "api";
  await writeFile(configuration, JSON.stringify(invalid));
  expect(await runSessionCli(["start", "--config", configuration], io)).toBe(2);
});

test("a separate production Node process resumes and inspects a durable accepted checkpoint without launching any official command", async () => {
  const h = await staticHarness();
  const executor = fake(h.output);
  const accepted = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    executor,
    limits,
  ).advance();
  expect(accepted.status).toBe("complete");
  expect(executor.start).toHaveBeenCalledOnce();
  const expectedRefs = accepted.tasks.first.outputRefs!;
  const before = await h.runtime.registry.snapshot();
  const checkpointBefore = await readFile(
    path.join(h.store.directory, "session_a.json"),
    "utf8",
  );
  const workspaceBefore = await readFile(
    path.join(h.root, ".mimic/workspace.json"),
    "utf8",
  );
  const executable = path.join(h.root, "forbidden-runtime-fixture");
  const runtimeLog = path.join(h.root, "forbidden-runtime-calls");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(new URL('./forbidden-runtime-calls', import.meta.url), 'unexpected command\\n');\nprocess.exitCode=99;\n`,
  );
  await chmod(executable, 0o700);
  const configuration = path.join(h.root, "separate-process-config.json");
  await writeFile(
    configuration,
    JSON.stringify({
      workspace: h.root,
      runId: binding.runId,
      sessionId: "session_a",
      packages: { first: "skill" },
      model: "fixture-model",
      executable,
    }),
  );
  const entry = path.join(repo, "apps/cli/dist/agent/session-main.js");
  for (const command of ["resume", "inspect"]) {
    const child = spawnSync(
      process.execPath,
      [entry, command, "--config", configuration],
      { cwd: repo, encoding: "utf8", timeout: 10000 },
    );
    expect(child.status, child.stderr).toBe(0);
    const readback = JSON.parse(child.stdout);
    expect(readback).toMatchObject({
      readOnly: true,
      sessionId: "session_a",
      status: "complete",
      tasks: [
        {
          taskId: "first",
          phase: "accepted",
          inputRefs: h.frozen.inputRefs,
          outputRefs: expectedRefs,
        },
      ],
    });
    expect(readback.core.core.runs[0].runId).toBe(binding.runId);
    expect(
      await readFile(path.join(h.store.directory, "session_a.json"), "utf8"),
    ).toBe(checkpointBefore);
    expect(
      await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
    ).toBe(workspaceBefore);
  }
  await expect(stat(runtimeLog)).rejects.toMatchObject({ code: "ENOENT" });
  const after = await h.runtime.registry.snapshot();
  expect(after.events).toEqual(before.events);
  expect(after.runs.run_session.artifacts).toEqual(
    before.runs.run_session.artifacts,
  );
  expect(after.canonical).toEqual({});
  expect(after.decisions).toEqual({});
  for (const ref of expectedRefs)
    expect(
      (await h.runtime.artifacts.read(ref.artifactId, ref.revision)).digest,
    ).toBe(ref.lockDigest);
});

test("trusted one-call dispatch keeps Core acceptance durable and cannot become subscription-only entitlement", async () => {
  const h = await staticHarness();
  const decision = {
    consumeUserDecision: vi.fn(async () => ({
      decisionId: "test-only-actual-host-decision",
      expiresAt: Date.now() + 60_000,
    })),
  };
  const options = { executable: process.execPath, workspace: h.root, env: {} };
  const first = createAuthorizedCodexSessionDispatch(
    options,
    "schema.json",
    decision,
  );
  const launch = vi
    .spyOn(CodexExecutor.prototype, "startAuthorizedOnce")
    .mockImplementation(async (request) => fake(h.output).start(request));
  const ordinary = vi.spyOn(CodexExecutor.prototype, "start");
  const state = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    first.executor,
    { ...limits, maxGenerations: 1 },
    first.dispatch,
  ).advance();
  expect(state.executionPolicy).toBe("authorized-existing-credit-risk-once");
  expect(state.tasks.first.phase).toBe("accepted");
  expect(state.generationCount).toBe(1);
  expect(launch).toHaveBeenCalledOnce();
  expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
  expect(ordinary).not.toHaveBeenCalled();
  const before = await readFile(
    path.join(h.root, ".mimic/workspace.json"),
    "utf8",
  );
  const fresh = createAuthorizedCodexSessionDispatch(
    options,
    "schema.json",
    decision,
  );
  await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    fresh.executor,
    { ...limits, maxGenerations: 1 },
    fresh.dispatch,
  ).advance({ resume: true });
  expect(
    await readFile(path.join(h.root, ".mimic/workspace.json"), "utf8"),
  ).toBe(before);
  expect(launch).toHaveBeenCalledOnce();
  expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
  await expect(
    new AgentSession(
      "session_a",
      h.store,
      h.ports,
      first.executor,
      limits,
    ).advance({ resume: true }),
  ).rejects.toBeInstanceOf(SessionExecutionPolicyMismatch);
  expect(ordinary).not.toHaveBeenCalled();
  expect(
    () =>
      new AgentSession(
        "session_other",
        h.store,
        h.ports,
        first.executor,
        limits,
        first.dispatch,
      ),
  ).toThrow("Invalid session limits");
  expect(
    () =>
      new AgentSession(
        "session_other",
        h.store,
        h.ports,
        first.executor,
        { ...limits, maxGenerations: 1 },
        { policy: "authorized-existing-credit-risk-once", start: launch },
      ),
  ).toThrow("Invalid session limits");
});

test("production trusted one-call entry uses static Core and exposes no JSON or CLI authorization override", async () => {
  const h = await staticHarness();
  const configPath = path.join(h.root, "authorized-session.json");
  const configuration = {
    workspace: h.root,
    executable: "/untrusted-workspace-codex",
    runId: binding.runId,
    sessionId: "session_a",
    packages: { first: "skill" },
    model: binding.settings.model,
    maxGenerations: 20,
    timeoutMs: 600_000,
  };
  await writeFile(configPath, JSON.stringify(configuration));
  const generationBounds: number[] = [];
  const selectedExecutables: string[] = [];
  const launch = vi
    .spyOn(CodexExecutor.prototype, "startAuthorizedOnce")
    .mockImplementation(async function (this: CodexExecutor, request) {
      // Observe the adapter actually used by the fixed entry, without replacing
      // its constructor or authorizing any real official subprocess.
      generationBounds.push(
        (this as unknown as { options: { timeoutMs: number } }).options
          .timeoutMs,
      );
      selectedExecutables.push(
        (this as unknown as { options: { executable: string } }).options
          .executable,
      );
      return fake(h.output).start(request);
    });
  const decision = {
    consumeUserDecision: vi.fn(async () => ({
      decisionId: "test-only-host-entry-decision",
      expiresAt: Date.now() + 60_000,
    })),
  };
  const out: string[] = [],
    err: string[] = [];
  const io = {
    out: (value: string) => out.push(value),
    err: (value: string) => err.push(value),
  };
  await writeFile(
    configPath,
    JSON.stringify({ ...configuration, timeoutMs: 600_001 }),
  );
  expect(await runSessionCli(["inspect", "--config", configPath], io)).toBe(2);
  expect(launch).not.toHaveBeenCalled();
  err.length = 0;
  await writeFile(configPath, JSON.stringify(configuration));
  expect(
    await runAuthorizedSessionOnce(
      configPath,
      "schema.json",
      decision,
      io,
      process.execPath,
    ),
  ).toBe(0);
  expect(JSON.parse(out.at(-1)!).executionPolicy).toBe(
    "authorized-existing-credit-risk-once",
  );
  expect((await h.store.read("session_a"))?.generationCount).toBe(1);
  expect(launch).toHaveBeenCalledOnce();
  expect(generationBounds).toEqual([600_000]);
  expect(selectedExecutables).toEqual([process.execPath]);
  expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
  expect(err).toEqual([]);
  expect(
    await runSessionCli(
      ["start", "--config", configPath, "--allow-existing-credit-risk"],
      io,
    ),
  ).toBe(2);
  await writeFile(
    configPath,
    JSON.stringify({ ...configuration, creditRiskConfirmed: true }),
  );
  expect(await runSessionCli(["start", "--config", configPath], io)).toBe(2);
  expect(launch).toHaveBeenCalledOnce();
});

test("host entry uses the installed output schema and an executable absent from workspace config", async () => {
  const h = await staticHarness();
  const privateRoot = await temporary();
  const authorization = new HostCreditAuthorizationStore(
    path.join(privateRoot, "credit"),
  );
  const configPath = path.join(h.root, "host-session.json");
  await writeFile(
    configPath,
    JSON.stringify({
      workspace: h.root,
      runId: binding.runId,
      sessionId: "session_host",
      packages: { first: "skill" },
      model: binding.settings.model,
      timeoutMs: 60_000,
    }),
  );
  const grantId = await authorization.record(
    {
      workspace: h.root,
      runId: binding.runId,
      model: binding.settings.model,
      executable: process.execPath,
      packages: { first: "skill" },
      maxCalls: 1,
      expiresAt: Date.now() + 60_000,
    },
    {
      requestDecision: async () => ({
        decisionId: "9999-test-host-event",
        actorId: "person@example.com",
        approvedAt: Date.now(),
      }),
    },
  );
  const launch = vi
    .spyOn(CodexExecutor.prototype, "startAuthorizedOnce")
    .mockImplementation(async (request) => fake(h.output).start(request));
  const out: string[] = [];
  const err: string[] = [];
  expect(
    await runHostAuthorizedSessionOnce(
      configPath,
      process.execPath,
      grantId,
      authorization,
      { out: (value) => out.push(value), err: (value) => err.push(value) },
    ),
  ).toBe(0);
  expect(launch).toHaveBeenCalledOnce();
  expect(err).toEqual([]);
  const stagedNames = (
    await readdir(path.join(h.root, ".mimic/agent-schema"))
  ).filter((name) => name.startsWith("codex-submission-output-"));
  expect(stagedNames).toHaveLength(1);
  expect(stagedNames[0]).toMatch(
    /^codex-submission-output-[a-f0-9]{64}\.schema\.json$/,
  );
  const schemaPath = path.join(h.root, ".mimic/agent-schema", stagedNames[0]!);
  expect((await stat(schemaPath)).isFile()).toBe(true);
  await expect(
    createCodexGenerationProfile(
      { executable: process.execPath, env: {}, workspace: h.root },
      {
        requestId: "schema-contract",
        workspace: h.root,
        prompt: "schema containment",
        settings: binding.settings,
      },
      schemaPath,
    ),
  ).resolves.toBeDefined();
  expect(
    (await new FileSessionStore(h.root).read("session_host"))?.generationCount,
  ).toBe(1);
  await runAuthorizedSessionResume(
    configPath,
    "a".repeat(64),
    { out: () => {}, err: (value) => err.push(value) },
    process.execPath,
  );
  expect(err.join("\n")).not.toMatch(/Invalid configuration/);
  const linkedWorkspace = path.join(privateRoot, "linked-workspace");
  await symlink(h.root, linkedWorkspace);
  await writeFile(
    configPath,
    JSON.stringify({
      workspace: linkedWorkspace,
      runId: binding.runId,
      sessionId: "session_linked",
      packages: { first: "skill" },
      model: binding.settings.model,
    }),
  );
  await expect(
    runHostAuthorizedSessionOnce(
      configPath,
      process.execPath,
      grantId,
      authorization,
    ),
  ).rejects.toThrow(/canonical path/);
  expect(launch).toHaveBeenCalledOnce();
});

test.each(["legacy-policy-stop", "prepared-before-stop"] as const)(
  "trusted resume reconciles only the exact prepared authorized work from %s",
  async (recoveryState) => {
    const h = await staticHarness();
    const decision = {
      consumeUserDecision: vi.fn(async () => ({
        decisionId: "test-only-resume-origin",
        expiresAt: Date.now() + 60_000,
      })),
    };
    const options = {
      executable: process.execPath,
      workspace: h.root,
      env: {},
    };
    const originalSubmit = h.ports.submit;
    h.ports.submit = async (...args) => {
      await originalSubmit(...args);
      throw new Error("Response lost after static Core acceptance");
    };
    const launch = vi
      .spyOn(CodexExecutor.prototype, "startAuthorizedOnce")
      .mockImplementation(async (request) => fake(h.output).start(request));
    const first = createAuthorizedCodexSessionDispatch(
      options,
      "schema.json",
      decision,
    );
    const stopped = await new AgentSession(
      "session_a",
      h.store,
      h.ports,
      first.executor,
      { ...limits, maxGenerations: 1 },
      first.dispatch,
    ).advance();
    expect(stopped.stop).toBe("unknown-outcome");
    expect(stopped.tasks.first.phase).toBe("prepared");
    const saved = stopped.tasks.first.work!;
    const beforeCore = await h.runtime.registry.snapshot();
    const markerDirectory = path.join(h.root, ".mimic/submissions");
    const markerNames = await readdir(markerDirectory);
    const markerBytes = await Promise.all(
      markerNames.map((name) =>
        readFile(path.join(markerDirectory, name), "utf8"),
      ),
    );
    const configPath = path.join(h.root, "authorized-resume.json");
    const configuration = {
      workspace: h.root,
      executable: process.execPath,
      runId: binding.runId,
      sessionId: "session_a",
      packages: { first: "skill" },
      model: binding.settings.model,
    };
    await writeFile(configPath, JSON.stringify(configuration));
    const output: string[] = [],
      errors: string[] = [];
    const io = {
      out: (value: string) => output.push(value),
      err: (value: string) => errors.push(value),
    };
    const checkpoint = path.join(h.store.directory, "session_a.json");
    const checkpointBefore = await readFile(checkpoint, "utf8");
    expect(await runSessionCli(["resume", "--config", configPath], io)).toBe(2);
    expect(errors.at(-1)).toContain("checkpoint unchanged");
    expect(await readFile(checkpoint, "utf8")).toBe(checkpointBefore);

    expect(
      await runAuthorizedSessionResume(configPath, "0".repeat(64), io),
    ).toBe(2);
    expect(await readFile(checkpoint, "utf8")).toBe(checkpointBefore);
    await writeFile(
      path.join(h.root, "other-session.json"),
      JSON.stringify({ ...configuration, sessionId: "session_other" }),
    );
    expect(
      await runAuthorizedSessionResume(
        path.join(h.root, "other-session.json"),
        saved.digest,
        io,
      ),
    ).toBe(2);
    expect(await readFile(checkpoint, "utf8")).toBe(checkpointBefore);

    // Simulate either the terminal stop written by an older public CLI or a
    // process crash just after persisting prepared work. No candidate or marker
    // is changed by the test setup.
    if (recoveryState === "legacy-policy-stop")
      stopped.stop = "reservation-invalid";
    else {
      stopped.status = "ready";
      delete stopped.stop;
    }
    await h.store.write(stopped);
    if (recoveryState === "legacy-policy-stop") {
      const legacyBytes = await readFile(checkpoint, "utf8");
      expect(await runSessionCli(["resume", "--config", configPath], io)).toBe(
        2,
      );
      expect(await readFile(checkpoint, "utf8")).toBe(legacyBytes);
    }
    expect(await runAuthorizedSessionResume(configPath, saved.digest, io)).toBe(
      0,
    );
    const resumed = await h.store.read("session_a");
    expect(resumed?.tasks.first.phase).toBe("accepted");
    expect(resumed?.tasks.first.work).toEqual(saved);
    expect(resumed?.generationCount).toBe(1);
    expect((await h.runtime.registry.snapshot()).events).toEqual(
      beforeCore.events,
    );
    expect(await readdir(markerDirectory)).toEqual(markerNames);
    expect(
      await Promise.all(
        markerNames.map((name) =>
          readFile(path.join(markerDirectory, name), "utf8"),
        ),
      ),
    ).toEqual(markerBytes);
    expect(launch).toHaveBeenCalledOnce();
    expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
    expect(await runAuthorizedSessionResume(configPath, saved.digest, io)).toBe(
      2,
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(recoveryState === "legacy-policy-stop" ? 5 : 4);
  },
);

test("trusted resume refuses changed binding and saved candidate without launching a model", async () => {
  const h = await staticHarness();
  const decision = {
    consumeUserDecision: vi.fn(async () => ({
      decisionId: "test-only-resume-tamper",
      expiresAt: Date.now() + 60_000,
    })),
  };
  const launch = vi
    .spyOn(CodexExecutor.prototype, "startAuthorizedOnce")
    .mockImplementation(async (request) => fake(h.output).start(request));
  const first = createAuthorizedCodexSessionDispatch(
    { executable: process.execPath, workspace: h.root, env: {} },
    "schema.json",
    decision,
  );
  const originalSubmit = h.ports.submit;
  h.ports.submit = async (...args) => {
    await originalSubmit(...args);
    throw new Error("Response lost after static Core acceptance");
  };
  const stopped = await new AgentSession(
    "session_a",
    h.store,
    h.ports,
    first.executor,
    { ...limits, maxGenerations: 1 },
    first.dispatch,
  ).advance();
  const saved = stopped.tasks.first.work!;
  const beforeCore = await h.runtime.registry.snapshot();
  const configPath = path.join(h.root, "authorized-resume.json");
  const configuration = {
    workspace: h.root,
    executable: process.execPath,
    runId: binding.runId,
    sessionId: "session_a",
    packages: { first: "skill" },
    model: "different-model",
  };
  await writeFile(configPath, JSON.stringify(configuration));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await runAuthorizedSessionResume(configPath, saved.digest, io)).toBe(
    0,
  );
  expect(JSON.parse(io.out.mock.lastCall![0]).stop).toBe("reservation-invalid");
  expect((await h.store.read("session_a"))?.tasks.first.phase).toBe("prepared");
  expect((await h.runtime.registry.snapshot()).events).toEqual(
    beforeCore.events,
  );

  await writeFile(
    configPath,
    JSON.stringify({ ...configuration, model: binding.settings.model }),
  );
  const workFile = path.join(h.root, saved.path);
  const originalWork = await readFile(workFile, "utf8");
  await writeFile(workFile, "tampered candidate");
  expect(await runAuthorizedSessionResume(configPath, saved.digest, io)).toBe(
    0,
  );
  expect((await h.store.read("session_a"))?.tasks.first.phase).toBe("prepared");
  expect((await h.runtime.registry.snapshot()).events).toEqual(
    beforeCore.events,
  );

  await writeFile(workFile, originalWork);
  const markerDirectory = path.join(h.root, ".mimic/submissions");
  const marker = (await readdir(markerDirectory))[0];
  await writeFile(path.join(markerDirectory, marker), "tampered marker");
  expect(await runAuthorizedSessionResume(configPath, saved.digest, io)).toBe(
    2,
  );
  expect((await h.store.read("session_a"))?.tasks.first.phase).toBe("prepared");
  expect((await h.runtime.registry.snapshot()).events).toEqual(
    beforeCore.events,
  );
  expect(launch).toHaveBeenCalledOnce();
  expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
});

test("reconciliation-only dispatch refuses omitted digest or start before creating a checkpoint", async () => {
  const h = await staticHarness();
  const oneShot = createAuthorizedCodexReconciliationDispatch({
    executable: process.execPath,
    workspace: h.root,
    env: {},
  });
  const session = new AgentSession(
    "session_a",
    h.store,
    h.ports,
    oneShot.executor,
    { ...limits, maxGenerations: 1 },
    oneShot.dispatch,
  );
  await expect(session.advance()).rejects.toThrow("digest");
  await expect(session.advance({ resume: true })).rejects.toThrow("digest");
  await expect(
    session.advance({ resume: true, reconcilePreparedWorkDigest: "wrong" }),
  ).rejects.toThrow("digest");
  await expect(
    session.advance({ resume: true, reconcilePreparedWorkDigest: digest }),
  ).rejects.toThrow("No saved authorized session");
  expect(await h.store.read("session_a")).toBeUndefined();
  expect(
    (await h.runtime.registry.snapshot()).runs[binding.runId].artifacts,
  ).toHaveLength(1);
});

test.each(["cancel", "deadline"] as const)(
  "one-call %s during host authorization aborts startup before any official launch",
  async (kind) => {
    const h = await harness();
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const decision = {
      consumeUserDecision: vi.fn(
        async (_scope: unknown, abort?: AbortSignal) => {
          signal = abort;
          entered();
          await waiting;
          return {
            decisionId: "test-only-cancelled-decision",
            expiresAt: Date.now() + 60_000,
          };
        },
      ),
    };
    const pair = createAuthorizedCodexSessionDispatch(
      { executable: process.execPath, workspace: h.root, env: {} },
      "schema.json",
      decision,
    );
    const launch = vi.spyOn(pair.executor, "startAuthorizedOnce");
    const session = new AgentSession(
      "session_a",
      h.store,
      h.ports,
      pair.executor,
      {
        ...limits,
        maxGenerations: 1,
        timeoutMs: kind === "deadline" ? 20 : 1000,
      },
      pair.dispatch,
    );
    const advancing = session.advance();
    await entering;
    if (kind === "cancel") await session.cancel();
    else expect((await advancing).stop).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    release();
    if (kind === "cancel") expect((await advancing).stop).toBe("cancelled");
    expect((await h.store.read("session_a"))!.tasks.first.diagnostics).toEqual({
      version: 1,
      stage: "authorization",
      backendReach: "unknown",
    });
    const request = {
      requestId: "another",
      workspace: h.root,
      prompt: "data",
      settings: binding.settings,
    };
    const repeated = [];
    for await (const event of (await pair.dispatch.start(request)).events)
      repeated.push(event);
    expect(repeated.at(-1)).toMatchObject({
      type: "stopped",
      reason: "billing-unconfirmed",
    });
    expect(decision.consumeUserDecision).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(h.ports.saveWork).not.toHaveBeenCalled();
    expect(h.ports.submit).not.toHaveBeenCalled();
  },
);
