import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  artifactDigest,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
} from "@mimic/core";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
const runId = "run_revision";
const taskId = "request";
const skillId = "mimic.revision.demo";
const at = "2026-10-07T12:00:00Z";
const scopes = [{ level: "organization" as const, ownerId: "org_local" }];
const task = {
  id: taskId,
  skillId,
  outputType: "system-request",
  scopeOwnerId: "org_local",
  intent: "create",
  authority: "AUTONOMOUS",
  inputs: {
    required: [
      {
        name: "source",
        kind: "artifact",
        artifactType: "system-capability",
        schemaVersion: "1.0.0",
      },
    ],
    optional: [],
    alternatives: [],
  },
};
function invoke(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args, "--root", root, "--json"], {
    encoding: "utf8",
  });
}
function seedInvoke(root: string, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/cli.js")).href;
  const script = `import { runCli } from ${JSON.stringify(entry)};
process.exitCode = await runCli(process.argv.slice(1), undefined, {
  seedAuthority: {
    verifyApproval: async (approval) => approval.decisionId === "synthetic_seed" && approval.actorId === "synthetic_human_fixture",
    verifyDecision: async () => false,
  },
});`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, ...args, "--root", root, "--json"],
    { encoding: "utf8" },
  );
}
function interruptedInvoke(root: string, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/cli.js")).href;
  const script = `import { runCli } from ${JSON.stringify(entry)};
process.exitCode = await runCli(process.argv.slice(1), undefined, {
  afterSkillAccepted: () => { throw new Error("simulated lost response"); },
});`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, ...args, "--root", root, "--json"],
    { encoding: "utf8" },
  );
}
interface Parsed {
  path: string;
  actions: { taskId: string; action: string }[];
  submissionState: string;
  revisionRequests: { path: string; count: number; state: string };
  records: {
    runId: string;
    taskId: string;
    skillId: string;
    workDigest: string;
    inputRefs: unknown[];
    outputRefs: unknown[];
    path: string;
    requests: { request: unknown; state: string }[];
  }[];
  requests: unknown[];
  count: number;
}
function parsed(result: ReturnType<typeof invoke>) {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Parsed;
}
function ref(artifact: ArtifactSnapshot) {
  return {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
}
beforeAll(() => {
  for (const target of ["@mimic/core", "@mimic/cli"]) {
    const built = spawnSync("pnpm", ["--filter", target, "build"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
  }
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function setup(approved = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mimic-revision-request-"));
  roots.push(root);
  parsed(invoke(root, "init"));
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, ".mimic/workspace.json")),
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    scopes,
    { verify: async () => false, allowCommit: async () => false },
    {
      verifyApproval: async (approval) =>
        approval.decisionId === "synthetic_seed" &&
        approval.actorId === "synthetic_human_fixture",
      verifyDecision: async () => false,
    },
  );
  const source = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/artifacts/valid/system-capability.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const provisional: ArtifactSnapshot = {
    ...source,
    meta: { ...source.meta, id: "art_revision_source" },
    scope: scopes[0],
    lifecycle: {
      status: approved ? "approved" : "provisional",
      freshness: "valid",
    },
    approval: approved
      ? {
          status: "approved",
          decisionId: "synthetic_seed",
          actorId: "synthetic_human_fixture",
          at,
        }
      : { status: "pending" },
    origin: {
      actorKind: "skill",
      actorId: "mimic.revision.source",
      runId,
      createdAt: at,
    },
  };
  const storedSource: ArtifactSnapshot = approved
    ? {
        ...provisional,
        meta: {
          ...provisional.meta,
          contentDigest: artifactDigest(provisional),
        },
      }
    : provisional;
  await runtime.artifacts.create(storedSource);
  if (approved) await runtime.registry.seedCanonical([ref(storedSource)]);
  await runtime.registry.start({
    id: runId,
    scope: "org_local",
    entryMode: "system-first",
    base: approved ? [ref(storedSource)] : [],
    reused: approved
      ? [{ ref: ref(storedSource), reason: "Approved source" }]
      : [],
    safeActions: [taskId],
    actor: { kind: "agent", id: "test" },
    at,
    reason: "Fixture",
  });
  if (!approved)
    await runtime.registry.produce({
      runId,
      ref: ref(storedSource),
      inputs: [],
      actor: { kind: "skill", id: "mimic.revision.source" },
      at,
      reason: "Fixture source",
    });
  mkdirSync(path.join(root, ".mimic/runs"));
  writeFileSync(
    path.join(root, `.mimic/runs/${runId}.json`),
    JSON.stringify([task]),
  );
  mkdirSync(path.join(root, "skill"));
  writeFileSync(
    path.join(root, "skill/SKILL.md"),
    "# Revision request fixture\n",
  );
  writeFileSync(path.join(root, "skill/example.json"), "{}");
  writeFileSync(path.join(root, "skill/test.json"), "{}");
  writeFileSync(
    path.join(root, "skill/manifest.yaml"),
    JSON.stringify({
      skillId,
      manifestVersion: "1.0.0",
      packageVersion: "0.1.0",
      skillFile: "SKILL.md",
      inputs: task.inputs,
      outputs: ["system-request"],
      forbiddenResponsibilities: ["Do not approve source"],
      humanGates: [],
      supportedArtifactSchemas: [
        { artifactType: "system-capability", schemaVersion: "1.0.0" },
        { artifactType: "system-request", schemaVersion: "1.0.0" },
      ],
      examples: ["example.json"],
      tests: ["test.json"],
    }),
  );
  const call = approved ? seedInvoke : invoke;
  const next = parsed(call(root, "next", runId));
  expect(next.actions).toContainEqual({ taskId, action: "GENERATE" });
  const detail = JSON.parse(
    readFileSync(path.join(root, next.path), "utf8"),
  ) as {
    actions: { taskId: string; invocation: { inputRefs: unknown[] } }[];
  };
  const invocation = detail.actions.find(
    (action) => action.taskId === taskId,
  )!.invocation;
  const requestTemplate = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/artifacts/valid/system-request.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const request: ArtifactSnapshot = {
    ...requestTemplate,
    meta: { ...requestTemplate.meta, id: "art_revision_request" },
    scope: scopes[0],
    origin: { actorKind: "skill", actorId: skillId, runId, createdAt: at },
    dependencies: [{ ...ref(storedSource), onChange: "validate" }],
    provenance: [
      {
        path: "/content",
        kind: "assumption",
        rationale: "Request evidence",
        evidenceRefs: ["evidence://revision"],
      },
    ],
  };
  const revisionRequest = {
    runId,
    source: ref(storedSource),
    request: ref(request),
    affectedLocks: [ref(storedSource)],
    evidenceRefs: ["evidence://revision"],
    reason: "Revise source",
  };
  writeFileSync(
    path.join(root, "work.json"),
    JSON.stringify({
      artifacts: [request],
      work: {
        result: {
          runId,
          taskId,
          skillId,
          inputRefs: invocation.inputRefs,
          outputRefs: [ref(request)],
        },
        revisionRequests: [revisionRequest],
      },
    }),
  );
  return { root, request, revisionRequest, runtime, call };
}

test("built CLI retains a provisional revision request across fresh processes", async () => {
  const { root, revisionRequest } = await setup();
  const submit = parsed(
    invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  expect(submit.submissionState).toBe("accepted");
  expect(submit.revisionRequests).toMatchObject({
    count: 1,
    state: "pending-source-approval",
  });
  const next = parsed(invoke(root, "next", runId));
  expect(next.revisionRequests).toMatchObject({
    count: 1,
    state: "pending-source-approval",
  });
  const readback = parsed(invoke(root, "revision-requests", runId));
  expect(readback.requests).toEqual([revisionRequest]);
  const record = readback.records[0]!;
  expect(record).toMatchObject({
    runId,
    taskId,
    skillId,
    requests: [{ request: revisionRequest, state: "pending-source-approval" }],
  });
  expect(record.workDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(record.inputRefs).toContainEqual(revisionRequest.source);
  expect(record.outputRefs).toContainEqual(revisionRequest.request);
  expect(submit.revisionRequests.path).toBe(record.path);
  expect(next.revisionRequests.path).toBe(record.path);
  expect(
    JSON.parse(readFileSync(path.join(root, record.path), "utf8"))
      .revisionRequests,
  ).toEqual([revisionRequest]);
});

test("approved source routes through Core exact validation and retries without new events", async () => {
  const { root, revisionRequest, runtime, call } = await setup(true);
  const submitted = parsed(
    call(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  expect(submitted.revisionRequests).toMatchObject({
    count: 1,
    state: "routed",
  });
  const initial = await runtime.registry.snapshot();
  expect(initial.runs[runId]!.artifacts).toContainEqual(
    revisionRequest.request,
  );
  const again = parsed(
    call(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  expect(again.revisionRequests).toMatchObject({ count: 1, state: "routed" });
  const retry = await runtime.registry.snapshot();
  expect(retry.events.length).toBe(initial.events.length);
  expect(retry.runs[runId]!.artifacts).toEqual(initial.runs[runId]!.artifacts);
  const readback = parsed(call(root, "revision-requests", runId));
  expect(readback.records[0].requests[0]).toEqual({
    request: revisionRequest,
    state: "routed",
  });
});

test("accepted interruption recovers side-channel without duplicate artifacts", async () => {
  const { root, revisionRequest, runtime } = await setup();
  const interrupted = interruptedInvoke(
    root,
    "submit",
    runId,
    "--task",
    taskId,
    "--package",
    "skill",
    "--work",
    "work.json",
  );
  expect(interrupted.status).toBe(6);
  expect(interrupted.stderr).toContain("simulated lost response");
  const accepted = await runtime.registry.snapshot();
  expect(accepted.runs[runId]!.artifacts).toContainEqual(
    revisionRequest.request,
  );
  const next = parsed(invoke(root, "next", runId));
  expect(next.revisionRequests).toMatchObject({
    count: 1,
    state: "pending-source-approval",
  });
  const recovered = parsed(
    invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  expect(recovered.revisionRequests).toMatchObject({
    count: 1,
    state: "pending-source-approval",
  });
  const after = await runtime.registry.snapshot();
  expect(after.events.length).toBe(accepted.events.length);
  expect(after.runs[runId]!.artifacts).toEqual(accepted.runs[runId]!.artifacts);
});

test("changed work and package conflict with the accepted binding", async () => {
  const { root, runtime } = await setup();
  parsed(
    invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  const before = await runtime.registry.snapshot();
  const original = JSON.parse(
    readFileSync(path.join(root, "work.json"), "utf8"),
  );
  writeFileSync(
    path.join(root, "changed.json"),
    JSON.stringify({
      ...original,
      work: {
        ...original.work,
        findings: [
          { claim: "changed", status: "UNVERIFIED", evidenceRefs: [] },
        ],
      },
    }),
  );
  expect(
    invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "changed.json",
    ).status,
  ).toBe(5);
  writeFileSync(path.join(root, "skill/SKILL.md"), "# Changed package\n");
  expect(
    invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ).status,
  ).toBe(5);
  expect((await runtime.registry.snapshot()).events).toEqual(before.events);
});

test("approved request with false evidence is retained but cannot route", async () => {
  const { root, runtime, call } = await setup(true);
  const original = JSON.parse(
    readFileSync(path.join(root, "work.json"), "utf8"),
  );
  original.work.revisionRequests[0].evidenceRefs = ["evidence://invented"];
  writeFileSync(path.join(root, "work.json"), JSON.stringify(original));
  const result = call(
    root,
    "submit",
    runId,
    "--task",
    taskId,
    "--package",
    "skill",
    "--work",
    "work.json",
  );
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("evidence is absent");
  const readback = parsed(call(root, "revision-requests", runId));
  expect(readback.records[0].requests[0].state).toBe("pending-routing");
  const state = await runtime.registry.snapshot();
  expect(state.runs[runId]!.artifacts).toHaveLength(1);
  expect(Object.keys(state.canonical)).toEqual(["art_revision_source"]);
});

test("malformed and stale side-channel refs cannot create artifacts or events", async () => {
  type MutableWork = {
    work: {
      revisionRequests: {
        evidenceRefs: string[];
        source: { lockDigest: string };
        request: { lockDigest: string };
        affectedLocks: unknown[];
      }[];
    };
  };
  const mutations: Array<(work: MutableWork) => void> = [
    (work) => {
      work.work.revisionRequests[0].evidenceRefs = [];
    },
    (work) => {
      work.work.revisionRequests[0].source.lockDigest =
        "sha256:" + "0".repeat(64);
    },
    (work) => {
      work.work.revisionRequests[0].request.lockDigest =
        "sha256:" + "0".repeat(64);
    },
    (work) => {
      work.work.revisionRequests[0].affectedLocks = [];
    },
  ];
  for (const mutate of mutations) {
    const { root, runtime } = await setup();
    const before = await runtime.registry.snapshot();
    const work = JSON.parse(readFileSync(path.join(root, "work.json"), "utf8"));
    mutate(work);
    writeFileSync(path.join(root, "work.json"), JSON.stringify(work));
    const result = invoke(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    );
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain("Invalid revision request exact bindings");
    const after = await runtime.registry.snapshot();
    expect(after.events).toEqual(before.events);
    expect(after.runs[runId]!.artifacts).toEqual(before.runs[runId]!.artifacts);
    expect(after.canonical).toEqual(before.canonical);
    expect(parsed(invoke(root, "revision-requests", runId)).count).toBe(0);
  }
});

test("approved route receipt can be rebuilt after interrupted persistence", async () => {
  const { root, runtime, call } = await setup(true);
  const first = parsed(
    call(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  const before = await runtime.registry.snapshot();
  const marker = path.join(root, first.revisionRequests.path);
  rmSync(marker.replace(/\.json$/, ".route-0.json"));
  expect(parsed(call(root, "next", runId)).revisionRequests.state).toBe(
    "pending-routing",
  );
  const recovered = parsed(
    call(
      root,
      "submit",
      runId,
      "--task",
      taskId,
      "--package",
      "skill",
      "--work",
      "work.json",
    ),
  );
  expect(recovered.revisionRequests.state).toBe("routed");
  expect((await runtime.registry.snapshot()).events).toEqual(before.events);
});

test("candidate origin mismatch is rejected without canonical effects", async () => {
  const { root, runtime } = await setup();
  const before = await runtime.registry.snapshot();
  const work = JSON.parse(readFileSync(path.join(root, "work.json"), "utf8"));
  work.artifacts[0].origin.actorId = "mimic.revision.other";
  writeFileSync(path.join(root, "work.json"), JSON.stringify(work));
  const result = invoke(
    root,
    "submit",
    runId,
    "--task",
    taskId,
    "--package",
    "skill",
    "--work",
    "work.json",
  );
  expect(result.status).toBe(3);
  expect(result.stderr).toContain(
    "Candidate origin does not match Skill and Run",
  );
  const after = await runtime.registry.snapshot();
  expect(after.events).toEqual(before.events);
  expect(after.canonical).toEqual(before.canonical);
});
