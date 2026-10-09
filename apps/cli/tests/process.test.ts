import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
} from "@mimic/core";
import {
  setupSystemFirst,
  syntheticHuman,
} from "../../../fixtures/dogfood/system-first/setup.js";

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
function syntheticSeedHostInvoke(...args: string[]) {
  const entry = pathToFileURL(path.join(repo, "apps/cli/dist/cli.js")).href;
  const source = `import { runCli } from ${JSON.stringify(entry)};
const host = {
  seedAuthority: {
    verifyApproval: async (approval) => approval.decisionId === "synthetic_seed" && approval.actorId === "synthetic_human_fixture",
    verifyDecision: async () => false,
  },
};
process.exitCode = await runCli(process.argv.slice(1), undefined, host);`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...args],
    { encoding: "utf8" },
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

test("built executable classifies malformed preview and release objects as invalid input", () => {
  const dir = root();
  expect(invoke("init", "--root", dir, "--json").status).toBe(0);
  for (const value of [
    null,
    {},
    { kind: "unknown", plan: {} },
    { kind: "standalone", plan: null },
  ]) {
    writeFileSync(path.join(dir, "bad-preview.json"), JSON.stringify(value));
    const result = invoke(
      "preview",
      "--root",
      dir,
      "--file",
      "bad-preview.json",
      "--json",
    );
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toMatch(/^MIMIC_3:/);
  }
  for (const value of [
    null,
    {},
    { quality: null },
    { quality: [null], dependencies: [], files: {} },
    { quality: [], files: {} },
  ]) {
    writeFileSync(path.join(dir, "bad-release.json"), JSON.stringify(value));
    const inspect = invoke(
      "release",
      "inspect",
      "--root",
      dir,
      "--file",
      "bad-release.json",
      "--json",
    );
    expect(inspect.status, inspect.stderr).toBe(3);
    const prepare = invoke(
      "release",
      "prepare",
      "--id",
      "bad",
      "--root",
      dir,
      "--file",
      "bad-release.json",
      "--destination",
      ".mimic",
      "--json",
    );
    expect(prepare.status, prepare.stderr).toBe(3);
  }
}, 20_000);

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
  const incomplete = invoke("preview", "--root", dir, "--json");
  expect(incomplete.status).toBe(2);
  expect(incomplete.stdout).toBe("");
  expect(incomplete.stderr).toMatch(/^MIMIC_2:/);
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

test("built CLI crosses preview, quality, candidate, confirmation and fresh-process package readback", async () => {
  const fixture = await setupSystemFirst();
  try {
    const dir = fixture.root;
    writeFileSync(
      path.join(dir, "scopes.json"),
      JSON.stringify({
        version: 1,
        defaultScope: "product_riverbend",
        scopes: [
          { level: "organization", ownerId: "org_riverbend" },
          {
            level: "product",
            ownerId: "product_riverbend",
            parentId: "org_riverbend",
          },
          {
            level: "domain",
            ownerId: "domain_triage",
            parentId: "product_riverbend",
          },
          {
            level: "domain",
            ownerId: "domain_dispatch",
            parentId: "product_riverbend",
          },
        ],
      }),
    );
    expect(
      invoke("init", "--root", dir, "--scopes", "scopes.json", "--json").status,
    ).toBe(0);
    copyFileSync(
      path.join(dir, "workspace.json"),
      path.join(dir, ".mimic", "workspace.json"),
    );
    writeFileSync(
      path.join(dir, "tasks.json"),
      JSON.stringify([
        {
          id: "process_review",
          skillId: "skill.process-review",
          outputType: "evaluation",
          scopeOwnerId: "product_riverbend",
          inputs: { required: [], optional: [], alternatives: [] },
          intent: "create",
          authority: "AUTONOMOUS",
        },
      ]),
    );
    const run = syntheticSeedHostInvoke(
      "run",
      "--root",
      dir,
      "--tasks",
      "tasks.json",
      "--id",
      "process_review_run",
      "--mode",
      "system-first",
      "--json",
    );
    expect(run.status, run.stderr).toBe(0);
    const status = syntheticSeedHostInvoke("status", "--root", dir, "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).runs).toEqual(
      expect.arrayContaining([{ id: "process_review_run", state: "active" }]),
    );
    const next = syntheticSeedHostInvoke(
      "next",
      "process_review_run",
      "--root",
      dir,
      "--json",
    );
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout).actions).toEqual(
      expect.arrayContaining([
        { taskId: "process_review", action: "GENERATE" },
      ]),
    );
    writeFileSync(
      path.join(dir, "preview.json"),
      JSON.stringify({
        kind: "standalone",
        plan: { ...fixture.modePlan.current, outputPath: "standalone-process" },
        uiContract: fixture.refs.contract,
      }),
    );
    const preview = syntheticSeedHostInvoke(
      "preview",
      "--root",
      dir,
      "--file",
      "preview.json",
      "--json",
    );
    expect(preview.status, preview.stderr).toBe(0);
    const inspected = JSON.parse(preview.stdout) as {
      directories: string[];
      reports: { path: string; findings: { state: string }[] }[];
    };
    expect(
      inspected.reports[0]!.findings.filter((item) => item.state === "FAIL"),
    ).toEqual([]);
    const files: Record<string, string> = {};
    const names = [
      "index.html",
      "prototype.css",
      "prototype.js",
      "plan.json",
      "manifest.json",
    ];
    for (const name of names)
      files[`prototype/${name}`] = path.join(inspected.directories[0]!, name);
    for (const name of ["quality/limits.txt", "decisions.txt", "guide.md"]) {
      const local = name.replaceAll("/", "_");
      writeFileSync(path.join(dir, local), "Synthetic process review\n");
      files[name] = local;
    }
    const included = (
      artifacts: readonly unknown[] = [],
      ownedFiles: string[] = [],
    ) => ({
      status: "included",
      artifacts,
      files: ownedFiles,
      dependencies: [],
    });
    const refs = fixture.refs;
    const plan = {
      ref: { packageId: "product/riverbend-process", version: "0.1.0" },
      mode: "reference",
      scope: {
        level: "product",
        ownerId: "product_riverbend",
        parentId: "org_riverbend",
      },
      schemaVersion: "1.0.0",
      approval: {
        decisionId: "synthetic_process_release",
        actorId: syntheticHuman.id,
        at: new Date().toISOString(),
      },
      inventory: {
        "product-foundation": included([
          refs.product,
          refs.users,
          refs.current,
        ]),
        "experience-structure": included([
          ...refs.domains,
          refs.journey,
          refs.profile,
          refs.references,
          refs.directionA,
        ]),
        "design-system": included(refs.assets),
        "interface-system-boundary": included([refs.contract]),
        prototype: included(
          [],
          names.map((name) => `prototype/${name}`),
        ),
        scenarios: included([refs.scenario]),
        quality: included([], ["quality/limits.txt"]),
        decisions: included([], ["decisions.txt"]),
        handoff: included([], ["guide.md"]),
      },
      files,
      dependencies: [],
      quality: [
        { report: inspected.reports[0]!.path, artifacts: [refs.scenario] },
      ],
    };
    writeFileSync(path.join(dir, "release-plan.json"), JSON.stringify(plan));
    mkdirSync(path.join(dir, "packages"));
    const inspection = invoke(
      "release",
      "inspect",
      "--root",
      dir,
      "--file",
      "release-plan.json",
      "--json",
    );
    expect(inspection.status, inspection.stderr).toBe(0);
    const matrix = JSON.parse(inspection.stdout) as {
      planDigest: string;
      reports: {
        reportDigest: string;
        findings: { criterion: string; state: string; severity: string }[];
      }[];
    };
    writeFileSync(
      path.join(dir, "local-policy.json"),
      JSON.stringify({
        version: 1,
        action: "release-policy",
        hostId: "synthetic-process-host",
        confirmedAt: new Date().toISOString(),
        planDigest: matrix.planDigest,
        decisions: matrix.reports.flatMap(({ reportDigest, findings }) =>
          findings.map((finding) => ({
            reportDigest,
            ...finding,
            blockRelease: finding.state === "FAIL",
            reason: `Synthetic process policy for ${finding.criterion}`,
          })),
        ),
      }),
    );
    const prepared = syntheticSeedHostInvoke(
      "release",
      "prepare",
      "--id",
      "candidate",
      "--root",
      dir,
      "--file",
      "release-plan.json",
      "--destination",
      "packages",
      "--policy-confirmation",
      "local-policy.json",
      "--json",
    );
    expect(prepared.status, prepared.stderr).toBe(0);
    const reviewPath = (JSON.parse(prepared.stdout) as { reviewPath: string })
      .reviewPath;
    const review = JSON.parse(
      readFileSync(path.join(dir, reviewPath), "utf8"),
    ) as {
      request: {
        ref: { packageId: string; version: string };
        mode: string;
        digest: string;
      };
      destination: string;
      requestDigest: string;
    };
    writeFileSync(
      path.join(dir, "confirmation.json"),
      JSON.stringify({
        version: 1,
        action: "release",
        hostId: "synthetic-process-host",
        humanActorId: syntheticHuman.id,
        confirmedAt: new Date().toISOString(),
        requestId: "synthetic_process_release",
        requestDigest: review.requestDigest,
        packageId: review.request.ref.packageId,
        packageVersion: review.request.ref.version,
        mode: review.request.mode,
        digest: review.request.digest,
        destination: review.destination,
      }),
    );
    const published = syntheticSeedHostInvoke(
      "release",
      "publish",
      "candidate",
      "--root",
      dir,
      "--confirmation",
      "confirmation.json",
      "--json",
    );
    expect(published.status, published.stderr).toBe(0);
    const readback = syntheticSeedHostInvoke(
      "release",
      "publish",
      "candidate",
      "--root",
      dir,
      "--confirmation",
      "confirmation.json",
      "--json",
    );
    expect(readback.status, readback.stderr).toBe(0);
    expect(JSON.parse(readback.stdout).status).toBe("recovered");
  } finally {
    await fixture.close();
  }
}, 30_000);

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
    JSON.stringify({
      ...work,
      work: {
        ...work.work,
        findings: [
          { claim: "changed", evidenceRefs: [], status: "UNVERIFIED" },
        ],
      },
    }),
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

async function approvedReuseFixture(unboundOutput = false) {
  const dir = root();
  expect(invoke("init", "--root", dir, "--json").status).toBe(0);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(dir, ".mimic/workspace.json")),
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    [{ level: "organization", ownerId: "org_local" }],
    { verify: async () => false, allowCommit: async () => false },
    {
      verifyApproval: async (approval) =>
        approval.decisionId === "synthetic_seed" &&
        approval.actorId === "synthetic_human_fixture",
      verifyDecision: async () => false,
    },
  );
  const fixture = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const approved: ArtifactSnapshot = {
    ...fixture,
    scope: { level: "organization", ownerId: "org_local" },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "synthetic_seed",
      actorId: "synthetic_human_fixture",
      at: "2026-10-08T00:00:00Z",
    },
  };
  const ref = {
    artifactId: approved.meta.id,
    revision: approved.meta.revision,
    lockDigest: artifactDigest(approved),
  };
  approved.meta.contentDigest = ref.lockDigest;
  await runtime.artifacts.create(approved);
  const other: ArtifactSnapshot = {
    ...approved,
    meta: { ...approved.meta, id: "art_other_approved" },
  };
  const otherRef = {
    artifactId: other.meta.id,
    revision: other.meta.revision,
    lockDigest: artifactDigest(other),
  };
  if (unboundOutput) {
    other.meta.contentDigest = otherRef.lockDigest;
    await runtime.artifacts.create(other);
  }
  await runtime.registry.seedCanonical(unboundOutput ? [ref, otherRef] : [ref]);
  cpSync(
    path.join(repo, "fixtures/skill-runtime/demo"),
    path.join(dir, "skill"),
    { recursive: true },
  );
  const routed = {
    id: "reuse",
    skillId: "mimic.runtime.demo",
    outputType: "product-definition",
    scopeOwnerId: "org_local",
    intent: "revise",
    targetArtifactId: ref.artifactId,
    authority: "AUTONOMOUS",
    humanBrief: "Reassess the approved definition without inventing a change",
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
              refs: [ref],
            },
            { name: "context-brief", kind: "human-brief" },
          ],
        },
      ],
    },
  };
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([routed]));
  const started = syntheticSeedHostInvoke(
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_reuse",
    "--json",
  );
  expect(started.status, started.stderr).toBe(0);
  expect(JSON.parse(started.stdout).actions).toEqual([
    {
      taskId: routed.id,
      action: "UPDATE",
      ref: `${ref.artifactId}@${ref.revision}`,
    },
  ]);
  const work = {
    artifacts: [],
    work: {
      result: {
        runId: "run_reuse",
        taskId: routed.id,
        skillId: routed.skillId,
        inputRefs: [ref],
        outputRefs: [ref],
      },
    },
  };
  writeFileSync(path.join(dir, "work.json"), JSON.stringify(work));
  const args = [
    "submit",
    "run_reuse",
    "--task",
    routed.id,
    "--package",
    "skill",
    "--work",
    "work.json",
    "--root",
    dir,
    "--json",
  ];
  return { dir, ref, otherRef, work, args };
}

for (const interrupted of [false, true]) {
  test(`built submit acknowledges unchanged approved base output${interrupted ? " after a lost response" : ""} and preserves exact retries`, async () => {
    const { dir, ref, args, work } = await approvedReuseFixture();
    const workspaceFile = path.join(dir, ".mimic/workspace.json");
    const before = JSON.parse(readFileSync(workspaceFile, "utf8"));
    if (interrupted) {
      const entry = pathToFileURL(path.join(repo, "apps/cli/dist/cli.js")).href;
      const fault = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runCli } from ${JSON.stringify(entry)};
process.exitCode = await runCli(process.argv.slice(1), undefined, {
  seedAuthority: {
    verifyApproval: async (approval) => approval.decisionId === "synthetic_seed" && approval.actorId === "synthetic_human_fixture",
    verifyDecision: async () => false,
  },
  afterSkillAccepted() { throw new Error("simulated lost response"); },
});`,
          ...args,
        ],
        { encoding: "utf8" },
      );
      expect(fault.status, fault.stderr).toBe(6);
      expect(fault.stderr).toMatch(/simulated lost response/);
    }
    const first = syntheticSeedHostInvoke(...args);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      submissionState: "accepted",
      actions: [{ taskId: "reuse", action: "IGNORE" }],
    });
    const after = readFileSync(workspaceFile, "utf8");
    const state = JSON.parse(after);
    expect(state.snapshots).toEqual(before.snapshots);
    expect(state.registry.canonical).toEqual(before.registry.canonical);
    expect(state.registry.decisions).toEqual(before.registry.decisions);
    expect(state.registry.commits).toEqual(before.registry.commits);
    expect(state.registry.runs.run_reuse.artifacts).toEqual([]);
    expect(
      state.registry.events.slice(before.registry.events.length),
    ).toMatchObject([
      {
        action: "set-work",
        reason: 'Skill task "reuse" completed with verified exact outputs',
        runAfter: { base: [ref], artifacts: [], safeActions: [] },
      },
      { action: "close-run" },
    ]);
    const retry = syntheticSeedHostInvoke(...args);
    expect(retry.status, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout).submissionState).toBe("accepted");
    expect(readFileSync(workspaceFile, "utf8")).toBe(after);
    const changed = {
      ...work,
      work: {
        ...work.work,
        findings: [
          { claim: "Changed retry", evidenceRefs: [], status: "UNVERIFIED" },
        ],
      },
    };
    writeFileSync(path.join(dir, "changed.json"), JSON.stringify(changed));
    const rejected = syntheticSeedHostInvoke(
      ...args.map((arg) => (arg === "work.json" ? "changed.json" : arg)),
    );
    expect(rejected.status, rejected.stderr).toBe(5);
    expect(rejected.stderr).toMatch(/Submission retry changed input/);
    expect(readFileSync(workspaceFile, "utf8")).toBe(after);
  }, 20_000);
}

test("built submit rejects an approved base output outside the exact invocation inputs", async () => {
  const { dir, otherRef, work, args } = await approvedReuseFixture(true);
  const bad = structuredClone(work);
  bad.work.result.outputRefs = [otherRef];
  writeFileSync(path.join(dir, "bad.json"), JSON.stringify(bad));
  const workspaceFile = path.join(dir, ".mimic/workspace.json");
  const before = readFileSync(workspaceFile, "utf8");
  const state = JSON.parse(before);
  expect(state.registry.runs.run_reuse.base).toContainEqual(otherRef);
  const rejected = syntheticSeedHostInvoke(
    ...args.map((arg) => (arg === "work.json" ? "bad.json" : arg)),
  );
  expect(rejected.status, rejected.stderr).toBe(6);
  expect(rejected.stderr).toMatch(
    /Unchanged output is not verified approved Run context/,
  );
  expect(readFileSync(workspaceFile, "utf8")).toBe(before);
}, 20_000);
