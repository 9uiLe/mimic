import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  canonicalJson,
  type ArtifactSnapshot,
  type ExactArtifactRef,
} from "@mimic/core";
import {
  localPacketDigest,
  localProposalDigest,
} from "../src/local-confirmation-authority.js";
import { setupApprovedPrototypeFixture } from "../../../fixtures/prototypes/approved.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
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
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function invoke(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args, "--root", root, "--json"], {
    encoding: "utf8",
  });
}
function put(root: string, name: string, value: unknown) {
  writeFileSync(path.join(root, name), JSON.stringify(value));
}
function state(root: string) {
  return JSON.parse(
    readFileSync(path.join(root, ".mimic/workspace.json"), "utf8"),
  ) as {
    registry: {
      packets: Record<string, Parameters<typeof localPacketDigest>[0]>;
      runs: Record<
        string,
        { proposals: Record<string, Parameters<typeof localProposalDigest>[0]> }
      >;
    };
  };
}
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
function staticPackage(root: string, name: string, outputType: string) {
  const dir = path.join(root, name);
  cpSync(path.join(repo, "fixtures/skill-runtime/demo"), dir, {
    recursive: true,
  });
  const manifest = path.join(dir, "manifest.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8")
      .replaceAll("product-definition", outputType)
      .replace(`decision: ${outputType}`, "decision: product-definition"),
  );
  return name;
}
function task(id: string, outputType: string, proposalIds: string[]) {
  return {
    id,
    skillId: "mimic.runtime.demo",
    outputType,
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "PROPOSE_ONLY",
    proposalIds,
    humanBrief: "Explicit synthetic local review",
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }],
      optional: [{ name: "research", kind: "evidence-file" }],
      alternatives: [
        {
          oneOf: [
            {
              name: "existing-definition",
              kind: "artifact",
              artifactType: outputType,
              schemaVersion: "1.0.0",
            },
            { name: "context-brief", kind: "human-brief" },
          ],
        },
      ],
    },
  };
}
function provisional(
  source: ArtifactSnapshot,
  runId: string,
): ArtifactSnapshot {
  const { contentDigest: _old, ...meta } = source.meta;
  void _old;
  return {
    ...source,
    meta,
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    origin: {
      actorKind: "skill",
      actorId: "mimic.runtime.demo",
      runId,
      createdAt: new Date().toISOString(),
    },
    dependencies: [],
    provenance: [
      {
        path: "/content",
        kind: "assumption",
        rationale: "Synthetic authored test input",
      },
    ],
  };
}
function approved(
  candidate: ArtifactSnapshot,
  decisionId: string,
  at: string,
  dependencies: ArtifactSnapshot["dependencies"] = [],
  provenance: ArtifactSnapshot["provenance"] = candidate.provenance,
): ArtifactSnapshot {
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId,
      actorId: "synthetic_human_main",
      at,
    },
    dependencies,
    provenance,
  };
  return {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
}
function exact(artifact: ArtifactSnapshot): ExactArtifactRef {
  return {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
}
function submitAndCommit(
  root: string,
  runId: string,
  outputType: string,
  sources: ArtifactSnapshot[],
  final: (
    candidate: ArtifactSnapshot,
    index: number,
    at: string,
  ) => ArtifactSnapshot,
): ExactArtifactRef[] {
  const taskId = `task_${runId}`;
  const proposalIds = sources.map((_, index) => `proposal_${runId}_${index}`);
  const packetId = `packet_${runId}`;
  const packageDir = staticPackage(root, `skill_${runId}`, outputType);
  put(root, `tasks_${runId}.json`, [task(taskId, outputType, proposalIds)]);
  const started = invoke(
    root,
    "run",
    "--tasks",
    `tasks_${runId}.json`,
    "--id",
    runId,
    "--mode",
    "system-first",
  );
  expect(started.status, started.stderr).toBe(0);
  expect(invoke(root, "next", runId).status).toBe(0);
  const candidates = sources.map((source) => provisional(source, runId));
  const refs = candidates.map(exact);
  put(root, `work_${runId}.json`, {
    artifacts: candidates,
    work: {
      result: {
        runId,
        taskId,
        skillId: "mimic.runtime.demo",
        inputRefs: [],
        outputRefs: refs,
        proposal: {
          packetId,
          reason: "Synthetic human review",
          items: refs.map((ref, index) => ({
            id: proposalIds[index],
            ref,
            alternatives: ["approve", "reject"],
            rationale: "Review exact authored candidate",
            evidenceLimits: [],
            dependents: [],
          })),
        },
      },
    },
  });
  const submitted = invoke(
    root,
    "submit",
    runId,
    "--task",
    taskId,
    "--package",
    packageDir,
    "--work",
    `work_${runId}.json`,
  );
  expect(submitted.status, submitted.stderr).toBe(0);
  const approvedRefs: ExactArtifactRef[] = [];
  const decisionNames: string[] = [];
  const confirmations: string[] = [];
  const at = new Date(Date.now() + 1000).toISOString();
  const confirmedAt = new Date(Date.now() - 1000).toISOString();
  for (let index = 0; index < candidates.length; index++) {
    const decisionId = `decision_${runId}_${index}`;
    const artifact = final(candidates[index]!, index, at);
    const output = exact(artifact);
    approvedRefs.push(output);
    const decision = {
      id: decisionId,
      packetId,
      proposalId: proposalIds[index],
      outcome: "approved",
      actor: { kind: "human", id: "synthetic_human_main" },
      at,
      rationale: "Explicit synthetic human approval",
      output: { ref: output, artifact },
    };
    const current = state(root).registry;
    const confirmation = {
      version: 1,
      action: "decide",
      hostId: "synthetic-main-host",
      humanActorId: "synthetic_human_main",
      confirmedAt,
      runId,
      scopeOwnerId: "product_mimic",
      packetId,
      packetDigest: localPacketDigest(current.packets[packetId]!),
      requestId: decisionId,
      requestDigest: hash(decision),
      proposalId: proposalIds[index],
      proposalDigest: localProposalDigest(
        current.runs[runId]!.proposals[proposalIds[index]!]!,
      ),
      outcome: "approved",
      candidate: refs[index],
      output,
    };
    const decisionName = `decision_${runId}_${index}.json`;
    const confirmationName = `confirm_${runId}_${index}.json`;
    put(root, decisionName, decision);
    put(root, confirmationName, confirmation);
    decisionNames.push(decisionName);
    confirmations.push(confirmationName);
    const decided = invoke(
      root,
      "decide",
      "--file",
      decisionName,
      "--confirmation",
      confirmationName,
    );
    expect(decided.status, decided.stderr).toBe(0);
  }
  const commit = {
    id: `commit_${runId}`,
    packetId,
    approvals: proposalIds.map((proposalId, index) => ({
      proposalId,
      decisionId: `decision_${runId}_${index}`,
    })),
    actor: { kind: "human", id: "synthetic_human_main" },
    at,
    reason: "Publish exact approved synthetic revisions",
  };
  const packet = state(root).registry.packets[packetId]!;
  const commitConfirmation = {
    version: 1,
    action: "commit",
    hostId: "synthetic-main-host",
    humanActorId: "synthetic_human_main",
    confirmedAt,
    runId,
    scopeOwnerId: "product_mimic",
    packetId,
    packetDigest: localPacketDigest(packet),
    requestId: commit.id,
    requestDigest: hash(commit),
    approvals: commit.approvals,
  };
  put(root, `commit_${runId}.json`, commit);
  put(root, `commit_confirm_${runId}.json`, commitConfirmation);
  const committed = invoke(
    root,
    "decide",
    "--file",
    decisionNames[0]!,
    "--confirmation",
    confirmations[0]!,
    "--commit",
    `commit_${runId}.json`,
    "--commit-confirmation",
    `commit_confirm_${runId}.json`,
  );
  expect(committed.status, committed.stderr).toBe(0);
  return approvedRefs;
}

test("main executable authors, locally approves, previews, and publishes an exact synthetic package", async () => {
  const fixture = await setupApprovedPrototypeFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "mimic-main-e2e-"));
  roots.push(root, fixture.root);
  put(root, "scopes.json", {
    version: 1,
    defaultScope: "product_mimic",
    scopes: [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ],
  });
  expect(invoke(root, "init", "--scopes", "scopes.json").status).toBe(0);
  const sourceRefs = [
    fixture.refs.pattern,
    fixture.refs.layout,
    fixture.refs.component,
    fixture.refs.responsiveRule,
    fixture.refs.accessibilityRule,
    fixture.refs.token,
  ];
  const assets = await Promise.all(
    sourceRefs.map(
      async (ref) =>
        (await fixture.store.read(ref.artifactId, ref.revision)).artifact,
    ),
  );
  const assetRefs = submitAndCommit(
    root,
    "run_assets",
    "design-system-asset",
    assets,
    (candidate, index, at) =>
      approved(candidate, `decision_run_assets_${index}`, at),
  );
  const scenarioSource = (
    await fixture.store.read(fixture.refs.scenario.artifactId, 1)
  ).artifact;
  const [scenarioRef] = submitAndCommit(
    root,
    "run_scenario",
    "scenario",
    [scenarioSource],
    (candidate, _index, at) =>
      approved(
        candidate,
        "decision_run_scenario_0",
        at,
        assetRefs.map((ref) => ({ ...ref, onChange: "validate" as const })),
        [
          {
            path: "/content/steps",
            kind: "derived",
            inputRefs: assetRefs
              .slice(0, 3)
              .map(
                (ref) => `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`,
              ),
            rationale:
              "Task → pattern → layout → components: explicit synthetic local review",
          },
        ],
      ),
  );
  const input = {
    ...fixture.input,
    scenario: scenarioRef!,
    selection: {
      pattern: assetRefs[0]!,
      layout: assetRefs[1]!,
      components: [assetRefs[2]!],
      responsiveRule: assetRefs[3]!,
      accessibilityRule: assetRefs[4]!,
    },
    tokenSources: [assetRefs[5]!],
    outputPath: "main-e2e-preview",
  };
  put(root, "preview.json", { kind: "standalone", plan: input });
  const status = invoke(root, "status");
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).canonical).toHaveLength(7);
  const preview = invoke(root, "preview", "--file", "preview.json");
  expect(preview.status, preview.stderr).toBe(0);
  const inspected = JSON.parse(preview.stdout) as {
    directories: string[];
    reports: {
      path: string;
      findings: { criterion: string; state: string }[];
    }[];
  };
  expect(
    inspected.reports[0]!.findings.find(
      (item) => item.criterion === "source-locks",
    )?.state,
  ).toBe("PASS");
  const names = [
    "index.html",
    "prototype.css",
    "prototype.js",
    "plan.json",
    "manifest.json",
  ];
  const files: Record<string, string> = Object.fromEntries(
    names.map((name) => [
      `prototype/${name}`,
      path.join(inspected.directories[0]!, name),
    ]),
  );
  for (const name of [
    "foundation.txt",
    "quality/limits.txt",
    "decisions.txt",
    "guide.md",
  ]) {
    const local = name.replaceAll("/", "_");
    writeFileSync(path.join(root, local), "Explicit synthetic local review\n");
    files[name] = local;
  }
  const included = (
    artifacts: readonly ExactArtifactRef[] = [],
    ownedFiles: string[] = [],
  ) => ({ status: "included", artifacts, files: ownedFiles, dependencies: [] });
  const releasePlan = {
    ref: { packageId: "product/main-e2e", version: "0.1.0" },
    mode: "reference",
    scope: {
      level: "product",
      ownerId: "product_mimic",
      parentId: "org_9uile",
    },
    schemaVersion: "1.0.0",
    approval: {
      decisionId: "synthetic_main_release",
      actorId: "synthetic_human_main",
      at: new Date().toISOString(),
    },
    inventory: {
      "product-foundation": included([], ["foundation.txt"]),
      "experience-structure": {
        status: "absent",
        reason: "No cross-domain structure in this synthetic fixture",
      },
      "design-system": included(assetRefs),
      "interface-system-boundary": {
        status: "absent",
        reason: "No system boundary in this synthetic fixture",
      },
      prototype: included(
        [],
        names.map((name) => `prototype/${name}`),
      ),
      scenarios: included([scenarioRef!]),
      quality: included([], ["quality/limits.txt"]),
      decisions: included([], ["decisions.txt"]),
      handoff: included([], ["guide.md"]),
    },
    files,
    dependencies: [],
    quality: [{ report: inspected.reports[0]!.path, artifacts: [scenarioRef] }],
  };
  put(root, "release-plan.json", releasePlan);
  mkdirSync(path.join(root, "packages"));
  const inspection = invoke(
    root,
    "release",
    "inspect",
    "--file",
    "release-plan.json",
  );
  expect(inspection.status, inspection.stderr).toBe(0);
  const matrix = JSON.parse(inspection.stdout) as {
    planDigest: string;
    reports: {
      reportDigest: string;
      findings: {
        findingIndex: number;
        findingDigest: string;
        criterion: string;
        state: string;
      }[];
    }[];
  };
  const localPolicy = {
    version: 1,
    action: "release-policy",
    hostId: "synthetic-main-host",
    confirmedAt: new Date().toISOString(),
    planDigest: matrix.planDigest,
    decisions: matrix.reports.flatMap(({ reportDigest, findings }) =>
      findings.map((finding) => ({
        reportDigest,
        ...finding,
        blockRelease: finding.state === "FAIL",
        reason: "Synthetic exact finding review",
      })),
    ),
  };
  put(root, "local-policy.json", localPolicy);
  const prepared = invoke(
    root,
    "release",
    "prepare",
    "--id",
    "main_candidate",
    "--file",
    "release-plan.json",
    "--destination",
    "packages",
    "--policy-confirmation",
    "local-policy.json",
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const review = JSON.parse(
    readFileSync(
      path.join(root, JSON.parse(prepared.stdout).reviewPath),
      "utf8",
    ),
  ) as {
    request: {
      ref: { packageId: string; version: string };
      mode: string;
      digest: string;
    };
    destination: string;
    requestDigest: string;
  };
  put(root, "release-confirmation.json", {
    version: 1,
    action: "release",
    hostId: "synthetic-main-host",
    humanActorId: "synthetic_human_main",
    confirmedAt: new Date().toISOString(),
    requestId: "synthetic_main_release",
    requestDigest: review.requestDigest,
    packageId: review.request.ref.packageId,
    packageVersion: review.request.ref.version,
    mode: review.request.mode,
    digest: review.request.digest,
    destination: review.destination,
  });
  const publish = () =>
    invoke(
      root,
      "release",
      "publish",
      "main_candidate",
      "--confirmation",
      "release-confirmation.json",
    );
  const published = publish();
  expect(published.status, published.stderr).toBe(0);
  const retry = publish();
  expect(retry.status, retry.stderr).toBe(0);
  expect(JSON.parse(retry.stdout).status).toBe("recovered");
  for (const [index, category, field, value] of [
    [0, "design-system", "artifacts", undefined],
    [1, "design-system", "artifacts", {}],
    [2, "design-system", "files", undefined],
    [3, "design-system", "files", {}],
    [4, "design-system", "dependencies", undefined],
    [5, "design-system", "dependencies", {}],
    [6, "experience-structure", "reason", undefined],
    [7, "experience-structure", "reason", {}],
  ] as const) {
    const changed = structuredClone(releasePlan) as unknown as {
      inventory: Record<string, Record<string, unknown>>;
    };
    const entry = changed.inventory[category]!;
    if (value === undefined) delete entry[field];
    else entry[field] = value;
    const planFile = `invalid-inventory-${index}.json`;
    const policyFile = `invalid-policy-${index}.json`;
    put(root, planFile, changed);
    const inspection = invoke(root, "release", "inspect", "--file", planFile);
    expect(inspection.status, inspection.stderr).toBe(0);
    put(root, policyFile, {
      ...localPolicy,
      planDigest: JSON.parse(inspection.stdout).planDigest,
    });
    const rejected = invoke(
      root,
      "release",
      "prepare",
      "--id",
      `invalid_${index}`,
      "--file",
      planFile,
      "--destination",
      "packages",
      "--policy-confirmation",
      policyFile,
    );
    expect(rejected.status, rejected.stderr).toBe(3);
  }
  writeFileSync(path.join(root, "bad-report.json"), "{broken JSON");
  const badReportPlan = structuredClone(releasePlan);
  badReportPlan.quality[0]!.report = "bad-report.json";
  put(root, "bad-report-plan.json", badReportPlan);
  const malformedReport = invoke(
    root,
    "release",
    "prepare",
    "--id",
    "invalid_report",
    "--file",
    "bad-report-plan.json",
    "--destination",
    "packages",
    "--policy-confirmation",
    "local-policy.json",
  );
  expect(malformedReport.status, malformedReport.stderr).toBe(3);
  badReportPlan.quality[0]!.report = "missing-report.json";
  put(root, "missing-report-plan.json", badReportPlan);
  const missingReport = invoke(
    root,
    "release",
    "prepare",
    "--id",
    "missing_report",
    "--file",
    "missing-report-plan.json",
    "--destination",
    "packages",
    "--policy-confirmation",
    "local-policy.json",
  );
  expect(missingReport.status, missingReport.stderr).toBe(6);
}, 45_000);
