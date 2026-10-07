import { afterEach, beforeAll, expect, test } from "vitest";
import { performance } from "node:perf_hooks";
import {
  ArtifactStore,
  CANONICALIZATION_VERSION,
  FileWorkspaceStorage,
  RegistryAuthorityVerifier,
  loadSchemaDirectory,
  type SnapshotStorage,
} from "@mimic/core";
import { LocalConfirmationAuthority } from "../src/local-confirmation-authority.js";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
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
import {
  localPacketDigest,
  localProposalDigest,
} from "../src/local-confirmation-authority.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
function invoke(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args, "--root", dir, "--json"], {
    encoding: "utf8",
  });
}
function invokeWithBrokenTrust(dir: string, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/entry.js")).href;
  const source = `import { dispatchCli } from ${JSON.stringify(entry)}; process.exitCode = await dispatchCli(process.argv.slice(1), async () => { throw new Error("invalid optional trust"); });`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...args, "--root", dir, "--json"],
    { encoding: "utf8" },
  );
}
function invokeWithClockForward(dir: string, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/entry.js")).href;
  const source = `import { dispatchCli } from ${JSON.stringify(entry)}; const now = Date.now(); Date.now = () => now + 10 * 365 * 24 * 60 * 60 * 1000; process.exitCode = await dispatchCli(process.argv.slice(1));`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...args, "--root", dir, "--json"],
    { encoding: "utf8" },
  );
}
function invokeWithTrust(dir: string, trust: unknown, ...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/entry.js")).href;
  const source = `import { dispatchCli } from ${JSON.stringify(entry)}; process.exitCode = await dispatchCli(process.argv.slice(1), async () => JSON.parse(process.env.MIMIC_TEST_TRUST));`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...args, "--root", dir, "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, MIMIC_TEST_TRUST: JSON.stringify(trust) },
    },
  );
}
function hash(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function put(dir: string, file: string, value: unknown) {
  writeFileSync(path.join(dir, file), JSON.stringify(value));
}
function state(dir: string) {
  return JSON.parse(
    readFileSync(path.join(dir, ".mimic/workspace.json"), "utf8"),
  );
}
function setup(withSibling = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mimic-local-confirmation-"));
  roots.push(dir);
  expect(invoke(dir, "init").status).toBe(0);
  cpSync(
    path.join(repo, "fixtures/skill-runtime/demo"),
    path.join(dir, "skill"),
    {
      recursive: true,
    },
  );
  const task = {
    id: "task_local",
    skillId: "mimic.runtime.demo",
    outputType: "product-definition",
    scopeOwnerId: "org_local",
    intent: "create",
    authority: "PROPOSE_ONLY",
    humanBrief: "A local decision",
    proposalIds: withSibling
      ? ["proposal_local", "proposal_sibling"]
      : ["proposal_local"],
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
  put(dir, "tasks.json", [task]);
  const run = invoke(dir, "run", "--tasks", "tasks.json", "--id", "run_local");
  expect(run.status, run.stderr).toBe(0);
  const fixture = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const candidate: ArtifactSnapshot = {
    ...fixture,
    meta: { ...fixture.meta, id: "art_local" },
    scope: { level: "organization", ownerId: "org_local" },
    lifecycle: { status: "proposed", freshness: "valid" },
    origin: {
      actorKind: "skill",
      actorId: task.skillId,
      runId: "run_local",
      createdAt: "2026-10-06T12:00:00Z",
    },
  };
  const ref = {
    artifactId: candidate.meta.id,
    revision: candidate.meta.revision,
    lockDigest: artifactDigest(candidate),
  };
  const sibling: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, id: "art_sibling" },
  };
  const siblingRef = {
    artifactId: sibling.meta.id,
    revision: sibling.meta.revision,
    lockDigest: artifactDigest(sibling),
  };
  put(dir, "work.json", {
    artifacts: withSibling ? [candidate, sibling] : [candidate],
    work: {
      result: {
        runId: "run_local",
        taskId: task.id,
        skillId: task.skillId,
        inputRefs: [],
        outputRefs: withSibling ? [ref, siblingRef] : [ref],
        proposal: {
          packetId: "packet_local",
          reason: "Human review",
          items: [
            {
              id: "proposal_local",
              ref,
              alternatives: ["approve", "reject"],
              rationale: "Review exact candidate",
              evidenceLimits: [],
              dependents: [],
            },
            ...(withSibling
              ? [
                  {
                    id: "proposal_sibling",
                    ref: siblingRef,
                    alternatives: ["approve", "reject"],
                    rationale: "Review sibling candidate",
                    evidenceLimits: [],
                    dependents: [],
                  },
                ]
              : []),
          ],
        },
      },
    },
  });
  const submit = invoke(
    dir,
    "submit",
    "run_local",
    "--task",
    task.id,
    "--package",
    "skill",
    "--work",
    "work.json",
  );
  expect(submit.status, submit.stderr).toBe(0);
  return { dir, candidate, ref, siblingRef };
}
function stageSecondRun(dir: string) {
  const originalTask = JSON.parse(
    readFileSync(path.join(dir, "tasks.json"), "utf8"),
  )[0];
  const task = {
    ...originalTask,
    id: "task_signed",
    proposalIds: ["proposal_signed"],
  };
  put(dir, "tasks-signed.json", [task]);
  const run = invoke(
    dir,
    "run",
    "--tasks",
    "tasks-signed.json",
    "--id",
    "run_signed",
  );
  expect(run.status, run.stderr).toBe(0);
  const originalWork = JSON.parse(
    readFileSync(path.join(dir, "work.json"), "utf8"),
  );
  const originalCandidate = originalWork.artifacts[0] as ArtifactSnapshot;
  const candidate: ArtifactSnapshot = {
    ...originalCandidate,
    meta: { ...originalCandidate.meta, id: "art_signed" },
    origin: { ...originalCandidate.origin, runId: "run_signed" },
  };
  const ref = {
    artifactId: candidate.meta.id,
    revision: candidate.meta.revision,
    lockDigest: artifactDigest(candidate),
  };
  const result = originalWork.work.result;
  put(dir, "work-signed.json", {
    artifacts: [candidate],
    work: {
      result: {
        ...result,
        runId: "run_signed",
        taskId: task.id,
        outputRefs: [ref],
        proposal: {
          ...result.proposal,
          packetId: "packet_signed",
          items: [{ ...result.proposal.items[0], id: "proposal_signed", ref }],
        },
      },
    },
  });
  const submitted = invoke(
    dir,
    "submit",
    "run_signed",
    "--task",
    task.id,
    "--package",
    "skill",
    "--work",
    "work-signed.json",
  );
  expect(submitted.status, submitted.stderr).toBe(0);
  return { candidate, ref };
}
function approval(
  dir: string,
  candidate: ArtifactSnapshot,
  ref: { artifactId: string; revision: number; lockDigest: string },
) {
  const at = new Date(Date.now() + 1000).toISOString();
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_local",
      actorId: "human_local",
      at,
    },
  };
  const artifact: ArtifactSnapshot = {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
  const output = {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
  const decision = {
    id: "decision_local",
    packetId: "packet_local",
    proposalId: "proposal_local",
    outcome: "approved",
    actor: { kind: "human", id: "human_local" },
    at,
    rationale: "Approve exact revision",
    output: { ref: output, artifact },
  };
  const commit = {
    id: "commit_local",
    packetId: "packet_local",
    approvals: [{ proposalId: "proposal_local", decisionId: "decision_local" }],
    actor: decision.actor,
    at,
    reason: "Publish exact approved revision",
  };
  const confirmedAt = new Date(Date.now() - 1000).toISOString();
  const base = {
    version: 1,
    hostId: "cooperative-host",
    humanActorId: "human_local",
    confirmedAt,
    runId: "run_local",
    scopeOwnerId: "org_local",
    packetId: "packet_local",
    packetDigest: localPacketDigest(state(dir).registry.packets.packet_local),
  };
  const confirmation = {
    ...base,
    action: "decide",
    requestId: decision.id,
    requestDigest: hash(decision),
    proposalId: decision.proposalId,
    proposalDigest: localProposalDigest(
      state(dir).registry.runs.run_local.proposals.proposal_local,
    ),
    outcome: decision.outcome,
    candidate: ref,
    output,
  };
  const commitConfirmation = {
    ...base,
    action: "commit",
    requestId: commit.id,
    requestDigest: hash(commit),
    approvals: commit.approvals,
  };
  return { decision, commit, confirmation, commitConfirmation, output };
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

test("built local flow binds distinct decision and commit, survives retry and supports new Run reuse", () => {
  const { dir, candidate, ref } = setup();
  const { decision, commit, confirmation, commitConfirmation, output } =
    approval(dir, candidate, ref);
  put(dir, "decision.json", decision);
  put(dir, "confirmation.json", confirmation);
  put(dir, "commit.json", commit);
  put(dir, "commit-confirmation.json", commitConfirmation);
  const decide = (...more: string[]) =>
    invoke(
      dir,
      "decide",
      "--file",
      "decision.json",
      "--confirmation",
      "confirmation.json",
      ...more,
    );
  expect(invoke(dir, "decisions", "run_local").stdout).toContain(
    "local-confirmation",
  );
  expect(invokeWithBrokenTrust(dir, "status").status).toBe(0);
  expect(invoke(dir, "decide", "--file", "decision.json").status).toBe(2);
  const actorOnly = invoke(
    dir,
    "decide",
    "--file",
    "decision.json",
    "--commit",
    "commit.json",
  );
  expect(actorOnly.status).toBe(2);
  put(dir, "confirmation.json", {
    ...confirmation,
    candidate: { ...ref, revision: 9 },
  });
  expect(decide().status).toBe(3);
  put(dir, "confirmation.json", confirmation);
  expect(
    invokeWithBrokenTrust(
      dir,
      "decide",
      "--file",
      "decision.json",
      "--confirmation",
      "confirmation.json",
    ).status,
  ).toBe(0);
  expect(state(dir).registry.canonical.art_local).toBeUndefined();
  expect(decide("--commit", "commit.json").status).toBe(2);
  const committed = decide(
    "--commit",
    "commit.json",
    "--commit-confirmation",
    "commit-confirmation.json",
  );
  expect(committed.status, committed.stderr).toBe(0);
  expect(state(dir).registry.canonical.art_local.ref).toEqual(output);
  const eventCount = state(dir).registry.events.length;
  expect(
    decide(
      "--commit",
      "commit.json",
      "--commit-confirmation",
      "commit-confirmation.json",
    ).status,
  ).toBe(0);
  expect(state(dir).registry.events).toHaveLength(eventCount);
  expect(invoke(dir, "status").status).toBe(0);
  put(dir, "reuse.json", [
    {
      id: "task_reuse",
      skillId: "skill.reuse",
      outputType: "product-definition",
      scopeOwnerId: "org_local",
      targetArtifactId: "art_local",
      intent: "use",
      authority: "AUTONOMOUS",
      inputs: { required: [], optional: [], alternatives: [] },
    },
  ]);
  const reuse = invoke(
    dir,
    "run",
    "--tasks",
    "reuse.json",
    "--id",
    "run_reuse",
  );
  expect(reuse.status, reuse.stderr).toBe(0);
  expect(JSON.parse(reuse.stdout).actions[0].action).toBe("USE");
  const future = invokeWithClockForward(
    dir,
    "run",
    "--tasks",
    "reuse.json",
    "--id",
    "run_future",
  );
  expect(future.status, future.stderr).toBe(0);
  expect(JSON.parse(future.stdout).actions[0].action).toBe("USE");
  put(dir, "decision.json", { ...decision, rationale: "Changed with same ID" });
  expect(decide().status).toBe(3);
  put(dir, "decision.json", decision);
  put(dir, "commit-confirmation.json", {
    ...commitConfirmation,
    approvals: [],
  });
  expect(
    decide(
      "--commit",
      "commit.json",
      "--commit-confirmation",
      "commit-confirmation.json",
    ).status,
  ).toBe(3);
  put(dir, "commit-confirmation.json", commitConfirmation);
  put(dir, "decision.json", { ...decision, rationale: "Changed with same ID" });
  put(dir, "confirmation.json", {
    ...confirmation,
    requestDigest: hash({ ...decision, rationale: "Changed with same ID" }),
  });
  expect(decide().status).toBe(5);
  const marker = state(dir).registry.decisions.decision_local
    .externalRefs[0] as string;
  unlinkSync(
    path.join(
      dir,
      ".mimic/confirmations",
      marker.slice("mimic-local-confirmation:sha256:".length) + ".json",
    ),
  );
  const missing = invoke(
    dir,
    "run",
    "--tasks",
    "reuse.json",
    "--id",
    "run_missing_evidence",
  );
  expect(missing.status, missing.stderr).toBe(6);
  expect(missing.stderr).toContain("Human approval is not verified");
}, 20_000);

test("rejection is durable without canonical publication and cannot be committed", () => {
  const { dir, candidate, ref } = setup();
  const base = approval(dir, candidate, ref);
  const at = base.decision.at;
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "rejected", freshness: "valid" },
    approval: {
      status: "rejected",
      decisionId: "decision_rejected",
      actorId: "human_local",
      at,
    },
  };
  const artifact: ArtifactSnapshot = {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
  const output = {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
  const decision = {
    ...base.decision,
    id: "decision_rejected",
    outcome: "rejected",
    output: { ref: output, artifact },
  };
  const confirmation = {
    ...base.confirmation,
    requestId: decision.id,
    requestDigest: hash(decision),
    outcome: decision.outcome,
    output,
  };
  put(dir, "decision.json", decision);
  put(dir, "confirmation.json", confirmation);
  const rejected = invoke(
    dir,
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
  );
  expect(rejected.status, rejected.stderr).toBe(0);
  expect(state(dir).registry.canonical.art_local).toBeUndefined();
  expect(
    state(dir).registry.runs.run_local.proposals.proposal_local.status,
  ).toBe("rejected");
  expect(
    invoke(
      dir,
      "decide",
      "--file",
      "decision.json",
      "--confirmation",
      "confirmation.json",
    ).status,
  ).toBe(0);
  const invalidCommit = {
    ...base.commit,
    approvals: [{ proposalId: "proposal_local", decisionId: decision.id }],
  };
  put(dir, "commit.json", invalidCommit);
  put(dir, "commit-confirmation.json", {
    ...base.commitConfirmation,
    approvals: invalidCommit.approvals,
    requestDigest: hash(invalidCommit),
  });
  expect(
    invoke(
      dir,
      "decide",
      "--file",
      "decision.json",
      "--confirmation",
      "confirmation.json",
      "--commit",
      "commit.json",
      "--commit-confirmation",
      "commit-confirmation.json",
    ).status,
  ).toBe(5);
});

test("explicit empty external refs keep the exact request digest and reject agent or Skill actors", () => {
  const { dir, candidate, ref } = setup();
  const base = approval(dir, candidate, ref);
  for (const kind of ["agent", "skill"]) {
    const decision = { ...base.decision, actor: { kind, id: "human_local" } };
    put(dir, "decision.json", decision);
    put(dir, "confirmation.json", {
      ...base.confirmation,
      requestDigest: hash(decision),
    });
    expect(
      invoke(
        dir,
        "decide",
        "--file",
        "decision.json",
        "--confirmation",
        "confirmation.json",
      ).status,
    ).toBe(3);
  }
  const decision = { ...base.decision, externalRefs: [] };
  put(dir, "decision.json", decision);
  put(dir, "confirmation.json", {
    ...base.confirmation,
    requestDigest: hash(decision),
  });
  const args = [
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
  ];
  const accepted = invoke(dir, ...args);
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(invoke(dir, ...args).status).toBe(0);
  const refs = state(dir).registry.decisions.decision_local
    .externalRefs as string[];
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatch(/^mimic-local-confirmation:sha256:/);
  const stored = JSON.parse(
    readFileSync(
      path.join(
        dir,
        ".mimic/confirmations",
        refs[0]!.slice("mimic-local-confirmation:sha256:".length) + ".json",
      ),
      "utf8",
    ),
  );
  expect(stored.externalRefsPresent).toBe(true);
  expect(stored.requestDigest).toBe(hash(decision));
});

test("a named local commit publishes no unnamed sibling in the same packet", () => {
  const { dir, candidate, ref, siblingRef } = setup(true);
  const { decision, commit, confirmation, commitConfirmation, output } =
    approval(dir, candidate, ref);
  put(dir, "decision.json", decision);
  put(dir, "confirmation.json", confirmation);
  put(dir, "commit.json", commit);
  put(dir, "commit-confirmation.json", commitConfirmation);
  const committed = invoke(
    dir,
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
    "--commit",
    "commit.json",
    "--commit-confirmation",
    "commit-confirmation.json",
  );
  expect(committed.status, committed.stderr).toBe(0);
  const registry = state(dir).registry;
  expect(registry.canonical.art_local.ref).toEqual(output);
  expect(registry.canonical.art_sibling).toBeUndefined();
  expect(registry.runs.run_local.proposals.proposal_sibling.ref).toEqual(
    siblingRef,
  );
  expect(registry.runs.run_local.proposals.proposal_sibling.status).toBe(
    "pending",
  );
});

test("signed and local history coexist without downgrading a signed approval", () => {
  const { dir, candidate: localCandidate, ref: localRef } = setup();
  const { candidate, ref } = stageSecondRun(dir);
  const local = approval(dir, localCandidate, localRef);
  put(dir, "decision.json", local.decision);
  put(dir, "confirmation.json", local.confirmation);
  put(dir, "commit.json", local.commit);
  put(dir, "commit-confirmation.json", local.commitConfirmation);
  const localCommit = invoke(
    dir,
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
    "--commit",
    "commit.json",
    "--commit-confirmation",
    "commit-confirmation.json",
  );
  expect(localCommit.status, localCommit.stderr).toBe(0);
  expect(state(dir).registry.canonical.art_signed).toBeUndefined();
  expect(
    state(dir).registry.runs.run_signed.proposals.proposal_signed.status,
  ).toBe("pending");
  const at = new Date(Date.now() + 1000).toISOString();
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_signed",
      actorId: "human_signed",
      at,
    },
  };
  const artifact: ArtifactSnapshot = {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
  const output = {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
  const decision = {
    id: "decision_signed",
    packetId: "packet_signed",
    proposalId: "proposal_signed",
    outcome: "approved",
    actor: { kind: "human", id: "human_signed" },
    at,
    rationale: "Signed exact approval",
    output: { ref: output, artifact },
  };
  const commit = {
    id: "commit_signed",
    packetId: "packet_signed",
    approvals: [{ proposalId: "proposal_signed", decisionId: decision.id }],
    actor: decision.actor,
    at,
    reason: "Publish signed approval",
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = {
    version: 1,
    keys: [
      {
        id: "signed-operator",
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
  };
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const base = {
    version: 1,
    keyId: "signed-operator",
    actorId: "human_signed",
    runId: "run_signed",
    scopeOwnerId: "org_local",
    packetId: "packet_signed",
    issuedAt,
    expiresAt,
  };
  const receipt = (payload: object) => ({
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64url"),
  });
  put(dir, "signed-decision.json", decision);
  put(dir, "signed-commit.json", commit);
  put(
    dir,
    "decision-receipt.json",
    receipt({
      ...base,
      action: "decide",
      requestId: decision.id,
      requestDigest: hash(decision),
      nonce: "nonce_signed_decision",
      proposalId: decision.proposalId,
      outcome: decision.outcome,
      candidate: ref,
      output,
    }),
  );
  put(
    dir,
    "commit-receipt.json",
    receipt({
      ...base,
      action: "commit",
      requestId: commit.id,
      requestDigest: hash(commit),
      nonce: "nonce_signed_commit",
      approvals: commit.approvals,
    }),
  );
  const signedArgs = [
    "decide",
    "--file",
    "signed-decision.json",
    "--receipt",
    "decision-receipt.json",
    "--commit",
    "signed-commit.json",
    "--commit-receipt",
    "commit-receipt.json",
  ];
  expect(invoke(dir, ...signedArgs).status).toBe(4);
  const signedCommit = invokeWithTrust(dir, trust, ...signedArgs);
  expect(signedCommit.status, signedCommit.stderr).toBe(0);
  expect(state(dir).registry.canonical.art_local.ref).toEqual(local.output);
  expect(state(dir).registry.canonical.art_signed.ref).toEqual(output);
  expect(state(dir).registry.decisions.decision_local.externalRefs[0]).toMatch(
    /^mimic-local-confirmation:/,
  );
  expect(state(dir).registry.decisions.decision_signed.externalRefs[0]).toMatch(
    /^mimic-receipt:/,
  );
  const reuse = (id: string, targetArtifactId: string) => {
    put(dir, `${id}.json`, [
      {
        id: `task_${id}`,
        skillId: "skill.reuse",
        outputType: "product-definition",
        scopeOwnerId: "org_local",
        targetArtifactId,
        intent: "use",
        authority: "AUTONOMOUS",
        inputs: { required: [], optional: [], alternatives: [] },
      },
    ]);
    return ["run", "--tasks", `${id}.json`, "--id", `run_${id}`];
  };
  const localReuse = invoke(dir, ...reuse("local_reuse", "art_local"));
  expect(localReuse.status).toBe(6);
  expect(localReuse.stderr).toContain("Human approval is not verified");
  const localVerified = invokeWithTrust(
    dir,
    trust,
    ...reuse("local_verified", "art_local"),
  );
  expect(localVerified.status, localVerified.stderr).toBe(0);
  expect(JSON.parse(localVerified.stdout).actions[0].action).toBe("USE");
  const unsignedSignedReuse = invoke(
    dir,
    ...reuse("signed_reuse", "art_signed"),
  );
  expect(unsignedSignedReuse.status).toBe(6);
  expect(unsignedSignedReuse.stderr).toContain(
    "Human approval is not verified",
  );
  const signedReuse = invokeWithTrust(
    dir,
    trust,
    ...reuse("signed_verified", "art_signed"),
  );
  expect(signedReuse.status, signedReuse.stderr).toBe(0);
  expect(JSON.parse(signedReuse.stdout).actions[0].action).toBe("USE");
}, 30_000);

test("reserved and mixed markers, missing evidence, and missing signed trust fail closed", () => {
  const { dir, candidate, ref } = setup();
  const base = approval(dir, candidate, ref);
  put(dir, "confirmation.json", base.confirmation);
  const args = [
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
  ];
  put(dir, "decision.json", {
    ...base.decision,
    externalRefs: ["mimic-receipt:sha256:" + "0".repeat(64)],
  });
  expect(invoke(dir, ...args).status).toBe(3);
  put(dir, "decision.json", base.decision);
  expect(invoke(dir, ...args, "--receipt", "confirmation.json").status).toBe(2);
  expect(
    invoke(
      dir,
      "decide",
      "--file",
      "decision.json",
      "--receipt",
      "confirmation.json",
    ).status,
  ).toBe(4);
  expect(invoke(dir, ...args).status).toBe(0);
  const marker = state(dir).registry.decisions.decision_local
    .externalRefs[0] as string;
  const file = path.join(
    dir,
    ".mimic/confirmations",
    marker.slice("mimic-local-confirmation:sha256:".length) + ".json",
  );
  writeFileSync(file, "{corrupt");
  put(dir, "commit.json", base.commit);
  put(dir, "commit-confirmation.json", base.commitConfirmation);
  const commit = invoke(
    dir,
    ...args,
    "--commit",
    "commit.json",
    "--commit-confirmation",
    "commit-confirmation.json",
  );
  expect(commit.status).toBe(3);
  expect(state(dir).registry.canonical.art_local).toBeUndefined();
});

test("9UI-153 persisted confirmation diamond profile", async () => {
  const { dir, candidate, ref } = setup();
  const { decision, commit, confirmation, commitConfirmation } = approval(
    dir,
    candidate,
    ref,
  );
  put(dir, "decision.json", decision);
  put(dir, "confirmation.json", confirmation);
  put(dir, "commit.json", commit);
  put(dir, "commit-confirmation.json", commitConfirmation);
  const confirmed = invoke(
    dir,
    "decide",
    "--file",
    "decision.json",
    "--confirmation",
    "confirmation.json",
    "--commit",
    "commit.json",
    "--commit-confirmation",
    "commit-confirmation.json",
  );
  expect(confirmed.status, confirmed.stderr).toBe(0);
  const file = path.join(dir, ".mimic", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const approved = JSON.parse(data.snapshots["art_local@2"])
    .artifact as ArtifactSnapshot;
  let previous: ArtifactSnapshot[] = [];
  let edges = 0;
  for (let layer = 10; layer >= 0; layer--) {
    const current: ArtifactSnapshot[] = [];
    for (let side = 0; side < (layer === 0 ? 1 : 2); side++) {
      if (layer === 10 && side === 0) {
        current.push(approved);
        continue;
      }
      const deps = previous.map((child) => ({
        artifactId: child.meta.id,
        revision: child.meta.revision,
        lockDigest: artifactDigest(child),
        onChange: "validate",
      }));
      edges += deps.length;
      const artifact: ArtifactSnapshot = {
        ...candidate,
        meta: { ...candidate.meta, id: `art_profile_${layer}_${side}` },
        scope: { level: "organization", ownerId: "org_local" },
        lifecycle: { status: "provisional", freshness: "valid" },
        approval: { status: "pending" },
        dependencies: deps,
        content: {
          ...(candidate.content as object),
          summary: `Layer ${layer} side ${side}`,
        },
      };
      data.snapshots[`${artifact.meta.id}@1`] = canonicalJson({
        canonicalization: CANONICALIZATION_VERSION,
        digest: artifactDigest(artifact),
        artifact,
      });
      current.push(artifact);
    }
    previous = current;
  }
  writeFileSync(file, JSON.stringify(data));
  const workspace = new FileWorkspaceStorage(file);
  let loads = 0;
  const instrumented = workspace as unknown as {
    readSource: () => Promise<unknown>;
  };
  const load = instrumented.readSource.bind(workspace);
  instrumented.readSource = async () => {
    loads++;
    return load();
  };
  const local = new LocalConfirmationAuthority(workspace, dir);
  let confirmations = 0;
  const localVerify = local.verify.bind(local);
  local.verify = async (record, proposal) => {
    confirmations++;
    return localVerify(record, proposal);
  };
  const authority = new RegistryAuthorityVerifier(workspace, {
    verify: (record, proposal) => local.verify(record, proposal),
  });
  let reads = 0;
  const storage: SnapshotStorage = {
    read: async (id, revision) => {
      reads++;
      return workspace.snapshots.read(id, revision);
    },
    revisions: workspace.snapshots.revisions,
    writeIfAbsent: workspace.snapshots.writeIfAbsent,
    withReadSession: workspace.snapshots.withReadSession,
  };
  const schemas = await loadSchemaDirectory(
    path.join(repo, "schemas/artifacts"),
  );
  let validates = 0;
  const validate = schemas.validate.bind(schemas);
  schemas.validate = (artifact) => {
    validates++;
    return validate(artifact);
  };
  const store = new ArtifactStore(
    storage,
    schemas,
    [{ level: "organization", ownerId: "org_local" }],
    authority,
  );
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  await store.read(previous[0]!.meta.id, 1);
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  expect({ nodes: 21, edges, reads, validates, workspaceLoads: loads }).toEqual(
    { nodes: 21, edges: 38, reads: 21, validates: 21, workspaceLoads: 2 },
  );
  expect(confirmations).toBeGreaterThan(0);
  expect(confirmations).toBeLessThanOrEqual(21);
  console.log(
    JSON.stringify({
      nodes: 21,
      edges,
      reads,
      validates,
      confirmations,
      workspaceLoads: loads,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
    }),
  );
}, 60000);
