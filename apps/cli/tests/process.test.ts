import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  artifactDigest,
  canonicalJson,
  type ArtifactSnapshot,
} from "@mimic/core";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
const task = {
  id: "task_a",
  skillId: "skill.a",
  outputType: "design-system-asset",
  scopeOwnerId: "org_local",
  inputs: { required: [], optional: [], alternatives: [] },
  intent: "create",
  authority: "AUTONOMOUS",
};
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mimic-cli-process-"));
  roots.push(dir);
  return dir;
}
function invoke(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    input: "untrusted stdin; never interpreted",
  });
}
function operatorInvoke(trust: unknown, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/entry.js")).href;
  const source = `import { dispatchCli } from ${JSON.stringify(entry)}; process.exitCode = await dispatchCli(process.argv.slice(1), async () => JSON.parse(process.env.MIMIC_TEST_OPERATOR_PUBLIC_KEYS));`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MIMIC_TEST_OPERATOR_PUBLIC_KEYS: JSON.stringify(trust),
      },
    },
  );
}
function hash(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
beforeAll(() => {
  for (const target of ["@mimic/core", "@mimic/cli"]) {
    const built = spawnSync("pnpm", ["--filter", target, "build"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(built.status, `${target}: ${built.stdout}\n${built.stderr}`).toBe(0);
  }
});
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("built executable uses compact stdout and file-backed detail across processes", () => {
  const dir = root();
  const ready = invoke();
  expect(ready.status).toBe(0);
  expect(JSON.parse(ready.stdout)).toEqual({ name: "mimic", state: "ready" });
  const init = invoke("init", "--root", dir, "--json");
  expect(init.status).toBe(0);
  expect(init.stderr).toBe("");
  const shellText = "$(touch should-not-exist)";
  writeFileSync(
    path.join(dir, "tasks.json"),
    JSON.stringify([
      {
        ...task,
        humanBrief: shellText,
        inputs: {
          required: [{ kind: "human-brief", name: "brief" }],
          optional: [],
          alternatives: [],
        },
      },
    ]),
  );
  const run = invoke(
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_process",
    "--json",
  );
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toBe("");
  const summary = JSON.parse(run.stdout);
  expect(summary).toMatchObject({
    runId: "run_process",
    state: "active",
    actions: [{ taskId: "task_a", action: "GENERATE" }],
  });
  expect(summary).not.toHaveProperty("invocation");
  const detail = JSON.parse(readFileSync(path.join(dir, summary.path), "utf8"));
  expect(detail.actions[0].invocation.humanBrief).toBe(shellText);
  expect(existsSync(path.join(dir, "should-not-exist"))).toBe(false);
  expect(
    JSON.parse(invoke("status", "--root", dir, "--json").stdout).runs,
  ).toEqual([{ id: "run_process", state: "active" }]);
  expect(
    JSON.parse(invoke("next", "run_process", "--root", dir, "--json").stdout)
      .actions[0].action,
  ).toBe("GENERATE");
});

test("built executable rejects malformed plans before state, permits correction, and reports errors on stderr", () => {
  const dir = root();
  expect(invoke("init", "--root", dir).status).toBe(0);
  writeFileSync(
    path.join(dir, "tasks.json"),
    JSON.stringify([{ ...task, skillId: "Bad Skill" }]),
  );
  const args = [
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_retry",
    "--json",
  ];
  const invalid = invoke(...args);
  expect(invalid.status).toBe(3);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toMatch(/^MIMIC_3:/);
  expect(existsSync(path.join(dir, ".mimic/runs/run_retry.json"))).toBe(false);
  expect(existsSync(path.join(dir, ".mimic/workspace.json"))).toBe(false);
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([task]));
  expect(invoke(...args).status).toBe(0);
  expect(invoke(...args).status).toBe(0);
  const unsupported = invoke("preview", "--root", dir, "--json");
  expect(unsupported.status).toBe(4);
  expect(unsupported.stdout).toBe("");
  expect(unsupported.stderr).toMatch(/^MIMIC_4:/);
  const invalidSchema = invoke(
    "validate",
    "--root",
    dir,
    "--file",
    "tasks.json",
    "--json",
  );
  expect(invalidSchema.status).toBe(3);
  expect(JSON.parse(invalidSchema.stdout).path).toMatch(/^\.mimic\/outputs\//);
  expect(invalidSchema.stderr).toMatch(/^MIMIC_3:/);
  writeFileSync(path.join(dir, ".mimic/workspace.json"), "{bad");
  const corrupt = invoke("status", "--root", dir, "--json");
  expect(corrupt.status).toBe(6);
  expect(corrupt.stdout).toBe("");
  expect(corrupt.stderr).toMatch(/^MIMIC_6:/);
});

test("built submit routes file work through the merged Skill harness and leaves a durable decision packet", () => {
  const dir = root();
  expect(invoke("init", "--root", dir, "--json").status).toBe(0);
  cpSync(
    path.join(repo, "fixtures/skill-runtime/demo"),
    path.join(dir, "skill"),
    { recursive: true },
  );
  const routed = {
    id: "task_submit",
    skillId: "mimic.runtime.demo",
    outputType: "product-definition",
    scopeOwnerId: "org_local",
    intent: "create",
    authority: "PROPOSE_ONLY",
    humanBrief: "Create a bounded product definition",
    proposalIds: ["proposal_submit"],
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
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([routed]));
  const run = invoke(
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_submit",
    "--json",
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout).actions[0].action).toBe("GENERATE");
  const fixture = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const candidate: ArtifactSnapshot = {
    ...fixture,
    meta: { ...fixture.meta, id: "art_cli_submit" },
    scope: { level: "organization", ownerId: "org_local" },
    lifecycle: { status: "proposed", freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: routed.skillId,
      runId: "run_submit",
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
        runId: "run_submit",
        taskId: routed.id,
        skillId: routed.skillId,
        inputRefs: [],
        outputRefs: [ref],
        proposal: {
          packetId: "packet_submit",
          reason: "Human review",
          items: [
            {
              id: "proposal_submit",
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
  writeFileSync(path.join(dir, "work.json"), JSON.stringify(work));
  expect(
    invoke(
      "submit",
      "run_submit",
      "--task",
      routed.id,
      "--package",
      path.join(repo, "fixtures/skill-runtime/demo"),
      "--work",
      "work.json",
      "--root",
      dir,
    ).status,
  ).toBe(3);
  expect(
    invoke(
      "submit",
      "run_submit",
      "--task",
      routed.id,
      "--package",
      "skill",
      "--work",
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "--root",
      dir,
    ).status,
  ).toBe(3);
  const submitted = invoke(
    "submit",
    "run_submit",
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    "work.json",
    "--root",
    dir,
    "--json",
  );
  expect(submitted.status, submitted.stderr).toBe(0);
  expect(JSON.parse(submitted.stdout)).toMatchObject({
    runId: "run_submit",
    submissionState: "accepted",
    packetIds: ["packet_submit"],
    actions: [{ action: "REQUEST_DECISION" }],
  });
  const reopened = invoke("next", "run_submit", "--root", dir, "--json");
  expect(reopened.status, reopened.stderr).toBe(0);
  expect(JSON.parse(reopened.stdout).packetIds).toEqual(["packet_submit"]);
  expect(
    JSON.parse(
      invoke("decisions", "run_submit", "--root", dir, "--json").stdout,
    ).packets[0].proposals[0].id,
  ).toBe("proposal_submit");
  const repeated = invoke(
    "submit",
    "run_submit",
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    "work.json",
    "--root",
    dir,
    "--json",
  );
  expect(repeated.status, repeated.stderr).toBe(0);
  writeFileSync(
    path.join(dir, "changed-work.json"),
    JSON.stringify({ ...work, work: { ...work.work, findings: ["changed"] } }),
  );
  const changed = invoke(
    "submit",
    "run_submit",
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    "changed-work.json",
    "--root",
    dir,
  );
  expect(changed.status, changed.stderr).toBe(5);
  const workspaceFile = path.join(dir, ".mimic/workspace.json");
  const acceptedBytes = readFileSync(workspaceFile, "utf8");
  const interrupted = JSON.parse(acceptedBytes);
  const terminal = interrupted.registry.events.pop();
  expect(terminal.action).toBe("set-work");
  interrupted.registry.runs.run_submit =
    interrupted.registry.events.at(-1).runAfter;
  writeFileSync(workspaceFile, JSON.stringify(interrupted));
  const partial = invoke(
    "submit",
    "run_submit",
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    "work.json",
    "--root",
    dir,
  );
  expect(partial.status, partial.stderr).toBe(5);
  expect(partial.stderr).toMatch(/Submission partial/);
  writeFileSync(workspaceFile, acceptedBytes);
  const state = JSON.parse(readFileSync(workspaceFile, "utf8"));
  expect(Object.keys(state.registry.packets)).toEqual(["packet_submit"]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = {
    version: 1,
    keys: [
      {
        id: "test-operator-key",
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
  };
  const at = new Date().toISOString();
  const decision = {
    id: "decision_process",
    packetId: "packet_submit",
    proposalId: "proposal_submit",
    outcome: "deferred",
    actor: { kind: "human", id: "human_process" },
    at,
    rationale: "Review later",
  };
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const payload = {
    version: 1,
    keyId: "test-operator-key",
    action: "decide",
    actorId: "human_process",
    runId: "run_submit",
    scopeOwnerId: "org_local",
    packetId: "packet_submit",
    proposalId: "proposal_submit",
    requestId: "decision_process",
    outcome: "deferred",
    candidate: ref,
    requestDigest: hash(decision),
    nonce: "nonce_process_0001",
    issuedAt,
    expiresAt,
  };
  const receipt = (value: typeof payload) => ({
    payload: value,
    signature: sign(
      null,
      Buffer.from(canonicalJson(value)),
      privateKey,
    ).toString("base64url"),
  });
  writeFileSync(path.join(dir, "decision.json"), JSON.stringify(decision));
  const decideArgs = [
    "decide",
    "--root",
    dir,
    "--file",
    "decision.json",
    "--receipt",
    "receipt.json",
    "--json",
  ];
  const withoutTrust = invoke(...decideArgs);
  expect(withoutTrust.status).toBe(4);
  const tryReceipt = (value: ReturnType<typeof receipt>) => {
    writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(value));
    return operatorInvoke(trust, ...decideArgs);
  };
  const valid = receipt(payload);
  expect(
    tryReceipt({ ...valid, signature: valid.signature.slice(0, -2) + "xx" })
      .status,
  ).toBe(3);
  expect(
    tryReceipt(receipt({ ...payload, scopeOwnerId: "other" })).status,
  ).toBe(3);
  expect(
    tryReceipt(
      receipt({
        ...payload,
        issuedAt: "2020-01-01T00:00:00Z",
        expiresAt: "2020-01-02T00:00:00Z",
      }),
    ).status,
  ).toBe(3);
  const accepted = tryReceipt(valid);
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout).decisionId).toBe("decision_process");
  expect(tryReceipt(valid).status).toBe(0);
  const replayed = { ...decision, id: "decision_replay" };
  writeFileSync(path.join(dir, "decision.json"), JSON.stringify(replayed));
  const replay = tryReceipt(
    receipt({
      ...payload,
      requestId: "decision_replay",
      requestDigest: hash(replayed),
    }),
  );
  expect(replay.status).toBe(5);
  expect(replay.stderr).toMatch(/nonce replayed/);
}, 20_000);

test("built submit retries accepted blockers and recovers a lost response without accepting changed work", () => {
  const dir = root();
  expect(invoke("init", "--root", dir).status).toBe(0);
  cpSync(
    path.join(repo, "fixtures/skill-runtime/demo"),
    path.join(dir, "skill"),
    { recursive: true },
  );
  const routed = {
    id: "task_blocked",
    skillId: "mimic.runtime.demo",
    outputType: "product-definition",
    scopeOwnerId: "org_local",
    intent: "create",
    authority: "PROPOSE_ONLY",
    humanBrief: "A brief",
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
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([routed]));
  const submitArgs = (runId: string, file = "work.json") => [
    "submit",
    runId,
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    file,
    "--root",
    dir,
    "--json",
  ];
  const work = (runId: string, reason = "Need a verified source") => ({
    artifacts: [],
    work: {
      result: {
        runId,
        taskId: routed.id,
        skillId: routed.skillId,
        inputRefs: [],
        outputRefs: [],
        blocked: { reason, affectedTaskIds: [routed.id] },
      },
    },
  });
  expect(
    invoke("run", "--root", dir, "--tasks", "tasks.json", "--id", "run_blocked")
      .status,
  ).toBe(0);
  writeFileSync(
    path.join(dir, "work.json"),
    JSON.stringify(work("run_blocked")),
  );
  const first = invoke(...submitArgs("run_blocked"));
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).actions).toMatchObject([
    { taskId: routed.id, action: "BLOCK" },
  ]);
  expect(JSON.parse(first.stdout).submissionState).toBe("blocked");
  const retry = invoke(...submitArgs("run_blocked"));
  expect(retry.status, retry.stderr).toBe(0);

  expect(
    invoke("run", "--root", dir, "--tasks", "tasks.json", "--id", "run_fault")
      .status,
  ).toBe(0);
  writeFileSync(path.join(dir, "work.json"), JSON.stringify(work("run_fault")));
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/cli.js")).href;
  const fault = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runCli } from ${JSON.stringify(entry)}; process.exitCode = await runCli(process.argv.slice(1), undefined, { afterSkillAccepted() { throw new Error("simulated lost response") } });`,
      ...submitArgs("run_fault"),
    ],
    { encoding: "utf8" },
  );
  expect(fault.status, fault.stderr).toBe(6);
  expect(fault.stderr).toMatch(/simulated lost response/);
  const changed = {
    ...work("run_fault", "Different reason"),
    work: {
      ...work("run_fault", "Different reason").work,
      findings: [{ claim: "Changed", evidenceRefs: [], status: "UNVERIFIED" }],
    },
  };
  writeFileSync(path.join(dir, "changed.json"), JSON.stringify(changed));
  const rejected = invoke(...submitArgs("run_fault", "changed.json"));
  expect(rejected.status, rejected.stderr).toBe(5);
  expect(rejected.stderr).toMatch(/Submission retry changed input/);
  const recovered = invoke(...submitArgs("run_fault"));
  expect(recovered.status, recovered.stderr).toBe(0);
}, 20_000);
