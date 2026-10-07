import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
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

  const baseDependency = {
    ref: review.request.ref,
    digest: review.request.digest,
    source: "packages",
    license: "Synthetic-Reviewed-License",
  };
  const consumer = (
    id: string,
    mode: "reference" | "portable",
    source: string,
  ) => ({
    ...releasePlan,
    ref: { packageId: `product/${id}`, version: "0.1.0" },
    mode,
    approval: {
      decisionId: `synthetic_${id}_release`,
      actorId: "synthetic_human_main",
      at: new Date().toISOString(),
    },
    inventory: {
      ...releasePlan.inventory,
      "product-foundation": {
        status: "included",
        artifacts: [],
        files: ["foundation.txt"],
        dependencies: [baseDependency.ref],
      },
    },
    dependencies: [{ ...baseDependency, source }],
  });
  put(
    root,
    "escaped-dependency.json",
    consumer("escaped", "reference", "../outside-workspace"),
  );
  expect(
    invoke(root, "release", "inspect", "--file", "escaped-dependency.json")
      .status,
  ).toBe(3);
  const dependentRelease = (
    id: string,
    mode: "reference" | "portable",
    source: string,
    kind: "local-publication" | "imported-acceptance",
    extras: (typeof baseDependency)[] = [],
  ) => {
    const planFile = `${id}-plan.json`;
    const policyFile = `${id}-policy.json`;
    const dependencyFile = `${id}-dependencies.json`;
    const confirmationFile = `${id}-release.json`;
    const authored = consumer(id, mode, source);
    authored.dependencies.push(...extras);
    authored.inventory["product-foundation"].dependencies.push(
      ...extras.map((item) => item.ref),
    );
    put(root, planFile, authored);
    const inspected = invoke(root, "release", "inspect", "--file", planFile);
    expect(inspected.status, inspected.stderr).toBe(0);
    const matrix = JSON.parse(inspected.stdout) as {
      planDigest: string;
      dependencyContextDigest: string;
      dependencyContext: {
        consumer: { ref: { packageId: string; version: string }; mode: string };
        nodes: {
          ref: { packageId: string; version: string };
          digest: string;
        }[];
        edges: unknown[];
      };
    };
    const policy = {
      ...localPolicy,
      planDigest: matrix.planDigest,
      confirmedAt: new Date().toISOString(),
    };
    put(root, policyFile, policy);
    const dependencyDecision = {
      version: 1,
      action: "release-dependencies",
      hostId: "synthetic-main-host",
      humanActorId: "synthetic_human_main",
      confirmedAt: new Date().toISOString(),
      contextDigest: matrix.dependencyContextDigest,
      consumer: matrix.dependencyContext.consumer,
      destination: "packages",
      packages: matrix.dependencyContext.nodes.map((node) => ({
        ref: node.ref,
        digest: node.digest,
        kind,
        allowed: true,
        evidence: "Explicit synthetic per-consumer exact package review",
      })),
      licenses: matrix.dependencyContext.edges.map((edge) => ({
        edge,
        allowed: true,
        evidence: "Explicit synthetic exact edge license review",
      })),
      redistribution:
        mode === "portable"
          ? matrix.dependencyContext.nodes.map((node) => ({
              ref: node.ref,
              digest: node.digest,
              allowed: true,
              evidence: "Explicit synthetic exact redistribution grant",
            }))
          : [],
    };
    put(root, dependencyFile, dependencyDecision);
    const prepareArgs = [
      "release",
      "prepare",
      "--id",
      id,
      "--file",
      planFile,
      "--destination",
      "packages",
      "--policy-confirmation",
      policyFile,
      "--dependency-confirmation",
      dependencyFile,
    ];
    return {
      authored,
      matrix,
      dependencyDecision,
      prepareArgs,
      publish: () =>
        invoke(
          root,
          "release",
          "publish",
          id,
          "--confirmation",
          confirmationFile,
        ),
      confirm: () => {
        const prepared = invoke(root, ...prepareArgs);
        expect(prepared.status, prepared.stderr).toBe(0);
        const envelope = JSON.parse(
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
          dependencyContext: unknown;
          dependencyConfirmation: unknown;
        };
        expect(envelope.dependencyContext).toBeDefined();
        expect(envelope.dependencyConfirmation).toEqual(
          JSON.parse(readFileSync(path.join(root, dependencyFile), "utf8")),
        );
        put(root, confirmationFile, {
          version: 1,
          action: "release",
          hostId: "synthetic-main-host",
          humanActorId: "synthetic_human_main",
          confirmedAt: new Date().toISOString(),
          requestId: authored.approval.decisionId,
          requestDigest: envelope.requestDigest,
          packageId: envelope.request.ref.packageId,
          packageVersion: envelope.request.ref.version,
          mode: envelope.request.mode,
          digest: envelope.request.digest,
          destination: envelope.destination,
        });
        const published = invoke(
          root,
          "release",
          "publish",
          id,
          "--confirmation",
          confirmationFile,
        );
        expect(published.status, published.stderr).toBe(0);
        return published;
      },
    };
  };
  const reference = dependentRelease(
    "main_reference",
    "reference",
    "packages",
    "local-publication",
  );
  expect(
    invoke(
      root,
      ...reference.prepareArgs.filter(
        (item, index, all) =>
          item !== "--dependency-confirmation" &&
          all[index - 1] !== "--dependency-confirmation",
      ),
    ).status,
  ).toBe(4);
  const referencePublished = JSON.parse(reference.confirm().stdout) as {
    digest: string;
  };
  expect(JSON.parse(reference.publish().stdout).status).toBe("recovered");
  const portable = dependentRelease(
    "main_portable",
    "portable",
    "packages",
    "local-publication",
  );
  portable.confirm();
  expect(JSON.parse(portable.publish().stdout).status).toBe("recovered");

  const preparedOnly = dependentRelease(
    "main_prepared_only",
    "reference",
    "packages",
    "local-publication",
  );
  const pending = invoke(root, ...preparedOnly.prepareArgs);
  expect(pending.status, pending.stderr).toBe(0);
  const pendingReview = JSON.parse(
    readFileSync(
      path.join(root, JSON.parse(pending.stdout).reviewPath),
      "utf8",
    ),
  ) as { request: { ref: typeof baseDependency.ref; digest: string } };
  const consumingPrepared = consumer(
    "main_uses_prepared",
    "reference",
    "packages",
  );
  consumingPrepared.dependencies[0] = {
    ref: pendingReview.request.ref,
    digest: pendingReview.request.digest,
    source: "packages",
    license: baseDependency.license,
  };
  consumingPrepared.inventory["product-foundation"].dependencies[0] =
    pendingReview.request.ref;
  put(root, "uses-prepared.json", consumingPrepared);
  expect(
    invoke(root, "release", "inspect", "--file", "uses-prepared.json").status,
  ).toBe(4);
  expect(
    existsSync(
      path.join(
        root,
        ".mimic",
        "releases",
        "main_prepared_only.completed.json",
      ),
    ),
  ).toBe(false);

  const changedAfterPrepare = dependentRelease(
    "main_changed_after_prepare",
    "reference",
    "packages",
    "local-publication",
  );
  const pendingPublish = invoke(root, ...changedAfterPrepare.prepareArgs);
  expect(pendingPublish.status, pendingPublish.stderr).toBe(0);
  const frozenEnvelope = JSON.parse(
    readFileSync(
      path.join(root, JSON.parse(pendingPublish.stdout).reviewPath),
      "utf8",
    ),
  ) as {
    request: { ref: typeof baseDependency.ref; mode: string; digest: string };
    destination: string;
    requestDigest: string;
  };
  put(root, "main_changed_after_prepare-release.json", {
    version: 1,
    action: "release",
    hostId: "synthetic-main-host",
    humanActorId: "synthetic_human_main",
    confirmedAt: new Date().toISOString(),
    requestId: changedAfterPrepare.authored.approval.decisionId,
    requestDigest: frozenEnvelope.requestDigest,
    packageId: frozenEnvelope.request.ref.packageId,
    packageVersion: frozenEnvelope.request.ref.version,
    mode: frozenEnvelope.request.mode,
    digest: frozenEnvelope.request.digest,
    destination: frozenEnvelope.destination,
  });
  const baseFile = path.join(
    root,
    "packages",
    "product",
    "main-e2e",
    "0.1.0",
    "foundation.txt",
  );
  const baseBytes = readFileSync(baseFile);
  writeFileSync(baseFile, "Changed after candidate review");
  expect(changedAfterPrepare.publish().status).toBe(3);
  writeFileSync(baseFile, baseBytes);
  expect(
    existsSync(
      path.join(
        root,
        "packages",
        "product",
        "main_changed_after_prepare",
        "0.1.0",
      ),
    ),
  ).toBe(false);

  mkdirSync(path.join(root, "imports", "product", "main-e2e"), {
    recursive: true,
  });
  cpSync(
    path.join(root, "packages", "product", "main-e2e", "0.1.0"),
    path.join(root, "imports", "product", "main-e2e", "0.1.0"),
    { recursive: true },
  );
  const copied = dependentRelease(
    "main_imported",
    "reference",
    "imports",
    "local-publication",
  );
  expect(invoke(root, ...copied.prepareArgs).status).toBe(4);
  const accepted = {
    ...copied.dependencyDecision,
    packages: copied.dependencyDecision.packages.map((item) => ({
      ...item,
      kind: "imported-acceptance",
      evidence:
        "Synthetic host accepts these imported exact bytes for this consumer only",
    })),
  };
  put(root, "main_imported-dependencies.json", accepted);
  copied.confirm();

  const referenceDependency = {
    ref: reference.authored.ref,
    digest: referencePublished.digest,
    source: "packages",
    license: baseDependency.license,
  };
  const transitive = dependentRelease(
    "main_transitive",
    "reference",
    "packages",
    "local-publication",
    [referenceDependency],
  );
  expect(transitive.matrix.dependencyContext.nodes).toHaveLength(2);
  expect(transitive.matrix.dependencyContext.edges).toHaveLength(3);
  expect(
    new Set(
      transitive.matrix.dependencyContext.edges.map(
        (edge) => (edge as { license: string }).license,
      ),
    ).size,
  ).toBe(1);
  const transitiveFile = "main_transitive-dependencies.json";
  for (const [changed, exit] of [
    {
      ...transitive.dependencyDecision,
      licenses: transitive.dependencyDecision.licenses.slice(1),
    },
    {
      ...transitive.dependencyDecision,
      licenses: transitive.dependencyDecision.licenses.map((item, index) => ({
        ...item,
        allowed: index !== 1,
      })),
    },
    {
      ...transitive.dependencyDecision,
      packages: transitive.dependencyDecision.packages.slice(1),
    },
  ].map((changed, index) => [changed, index === 1 ? 4 : 3] as const)) {
    put(root, transitiveFile, changed);
    expect(invoke(root, ...transitive.prepareArgs).status).toBe(exit);
  }
  put(root, transitiveFile, transitive.dependencyDecision);
  transitive.confirm();
  const badPortable = dependentRelease(
    "main_bad_portable",
    "portable",
    "packages",
    "local-publication",
    [referenceDependency],
  );
  expect(invoke(root, ...badPortable.prepareArgs).status).toBe(3);
  const missingGrant = {
    ...badPortable.dependencyDecision,
    redistribution: badPortable.dependencyDecision.redistribution.slice(1),
  };
  put(root, "main_bad_portable-dependencies.json", missingGrant);
  expect(invoke(root, ...badPortable.prepareArgs).status).toBe(3);

  const sourceChanged = structuredClone(reference.authored);
  sourceChanged.ref.packageId = "product/main_changed_consumer";
  put(root, "main_reference-plan.json", sourceChanged);
  const changedInspection = invoke(
    root,
    "release",
    "inspect",
    "--file",
    "main_reference-plan.json",
  );
  expect(changedInspection.status, changedInspection.stderr).toBe(0);
  put(root, "main_reference-policy.json", {
    ...localPolicy,
    planDigest: JSON.parse(changedInspection.stdout).planDigest,
    confirmedAt: new Date().toISOString(),
  });
  expect(invoke(root, ...reference.prepareArgs).status).toBe(3);
  sourceChanged.ref.packageId = reference.authored.ref.packageId;
  sourceChanged.dependencies[0]!.source = "imports";
  put(root, "main_reference-plan.json", sourceChanged);
  const sourceInspection = invoke(
    root,
    "release",
    "inspect",
    "--file",
    "main_reference-plan.json",
  );
  expect(sourceInspection.status, sourceInspection.stderr).toBe(0);
  put(root, "main_reference-policy.json", {
    ...localPolicy,
    planDigest: JSON.parse(sourceInspection.stdout).planDigest,
    confirmedAt: new Date().toISOString(),
  });
  expect(invoke(root, ...reference.prepareArgs).status).toBe(3);
  put(root, "main_reference-plan.json", reference.authored);
  put(root, "main_reference-policy.json", {
    ...localPolicy,
    planDigest: reference.matrix.planDigest,
    confirmedAt: new Date().toISOString(),
  });
  mkdirSync(path.join(root, "other-packages"));
  const destinationChanged = reference.prepareArgs.map((item) =>
    item === "packages" ? "other-packages" : item,
  );
  expect(invoke(root, ...destinationChanged).status).toBe(3);
  const packageFile = path.join(
    root,
    "packages",
    "product",
    "main-e2e",
    "0.1.0",
    "foundation.txt",
  );
  const originalBytes = readFileSync(packageFile);
  writeFileSync(packageFile, "Changed source bytes");
  expect(
    invoke(root, "release", "inspect", "--file", "main_reference-plan.json")
      .status,
  ).toBe(3);
  writeFileSync(packageFile, originalBytes);

  const intentFile = path.join(
    root,
    ".mimic",
    "releases",
    "main_candidate.intent.json",
  );
  const completedFile = path.join(
    root,
    ".mimic",
    "releases",
    "main_candidate.completed.json",
  );
  const originalIntent = readFileSync(intentFile, "utf8");
  const originalCompleted = readFileSync(completedFile, "utf8");
  const tamperedIntent = JSON.parse(originalIntent) as {
    confirmation: { requestDigest: string };
  };
  tamperedIntent.confirmation.requestDigest = `sha256:${"0".repeat(64)}`;
  writeFileSync(intentFile, JSON.stringify(tamperedIntent));
  const tampered = dependentRelease(
    "main_tampered",
    "reference",
    "packages",
    "local-publication",
  );
  expect(invoke(root, ...tampered.prepareArgs).status).toBe(4);
  writeFileSync(intentFile, originalIntent);
  const completion = JSON.parse(originalCompleted) as { digest: string };
  const legacyIntent = JSON.parse(originalIntent) as {
    preparedDigest: string;
    confirmationDigest: string;
  };
  writeFileSync(completedFile, "{}");
  const incomplete = dependentRelease(
    "main_incomplete",
    "reference",
    "packages",
    "local-publication",
  );
  expect(invoke(root, ...incomplete.prepareArgs).status).toBe(4);
  writeFileSync(
    intentFile,
    JSON.stringify({
      preparedDigest: legacyIntent.preparedDigest,
      confirmationDigest: legacyIntent.confirmationDigest,
    }),
  );
  writeFileSync(
    completedFile,
    JSON.stringify({
      preparedDigest: legacyIntent.preparedDigest,
      confirmationDigest: legacyIntent.confirmationDigest,
      digest: completion.digest,
    }),
  );
  const legacy = dependentRelease(
    "main_legacy",
    "reference",
    "packages",
    "local-publication",
  );
  expect(invoke(root, ...legacy.prepareArgs).status).toBe(4);
  put(root, "main_legacy-dependencies.json", {
    ...legacy.dependencyDecision,
    packages: legacy.dependencyDecision.packages.map((item) => ({
      ...item,
      publicationConfirmation: JSON.parse(
        readFileSync(path.join(root, "release-confirmation.json"), "utf8"),
      ),
    })),
  });
  expect(invoke(root, ...legacy.prepareArgs).status).toBe(0);
  writeFileSync(intentFile, originalIntent);
  writeFileSync(completedFile, originalCompleted);
  expect(
    existsSync(
      path.join(root, ".mimic", "releases", "main_bad_portable.prepared.json"),
    ),
  ).toBe(false);
}, 120_000);
