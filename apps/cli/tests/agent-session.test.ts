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
} from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
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
  sessionDigest,
  type SessionBinding,
  type SessionPlan,
  type SessionPorts,
  type SessionTask,
} from "../src/agent/session.js";
import { createWorkspaceSessionPorts } from "../src/agent/session-workspace.js";
import { runCli } from "../src/cli.js";
import {
  type AgentExecutor,
  type ExecutorEvent,
  type ExecutionRequest,
} from "../src/agent/executor.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
afterEach(async () => {
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
async function staticHarness() {
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
      authority: "AUTONOMOUS",
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
      humanGates: [],
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
test("real static CLI reconciles acceptance after a lost response; fresh resume never regenerates or approves", async () => {
  const h = await staticHarness(),
    executor = fake(h.output);
  const submit = h.ports.submit;
  let lost = true;
  h.ports.submit = async (...args) => {
    const refs = await submit(...args);
    if (lost) {
      lost = false;
      throw new Error("Lost response after Core accepted");
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
