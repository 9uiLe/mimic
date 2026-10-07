import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  canonicalJson,
  FilePackageSource,
  packageDigest,
  parseDesignLock,
  parseManifest,
  serializePackageDocument,
  sha256,
  type ArtifactSnapshot,
  type ExactArtifactRef,
  type PackageManifest,
} from "@mimic/core";
import {
  localPacketDigest,
  localProposalDigest,
} from "../src/local-confirmation-authority.js";
import { setupSystemFirst } from "../../../fixtures/dogfood/system-first/setup.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
const decisionAt = "2026-10-07T07:00:00Z";
const confirmedAt = "2026-10-07T06:59:59Z";
const actorId = "synthetic_human_riverbend_cli";
const hostId = "synthetic-riverbend-cli-host";
const historicalDirection =
  "sha256:26261a036aa99034b98bfb90ebe32f0c0ae2099353d62b3a3e5a9826e16ce63c";
const fiveFiles = [
  "index.html",
  "prototype.css",
  "prototype.js",
  "plan.json",
  "manifest.json",
];

beforeAll(() => {
  for (const target of ["@mimic/core", "@mimic/cli"]) {
    const built = spawnSync("pnpm", ["--filter", target, "build"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 180_000,
      killSignal: "SIGTERM",
    });
    expect(
      built.status,
      target +
        ": " +
        built.stdout +
        "\n" +
        built.stderr +
        "\nerror=" +
        (built.error?.message ?? "none") +
        " signal=" +
        (built.signal ?? "none"),
    ).toBe(0);
  }
}, 180_000);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function invoke(root: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [bin, ...args, "--root", root, "--json"],
    {
      encoding: "utf8",
      timeout: 180_000,
      killSignal: "SIGTERM",
    },
  );
  if (result.error || result.signal)
    throw new Error(
      `${args.join(" ")}: ${result.error?.message ?? "process signaled"}; signal=${result.signal ?? "none"}\n${result.stdout}\n${result.stderr}`,
    );
  return result;
}
function accepted(root: string, ...args: string[]) {
  const result = invoke(root, ...args);
  expect(
    result.status,
    args.join(" ") + ": " + result.stdout + "\n" + result.stderr,
  ).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function put(root: string, name: string, value: unknown) {
  writeFileSync(path.join(root, name), JSON.stringify(value));
  return name;
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
function hash(value: unknown) {
  return (
    "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex")
  );
}
function exact(artifact: ArtifactSnapshot): ExactArtifactRef {
  return {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
}
function linked(ref: ExactArtifactRef) {
  return ref.artifactId + "@" + ref.revision + "#" + ref.lockDigest;
}
function preparedSkill(
  root: string,
  id: string,
  outputType: string,
  inputs: {
    name: string;
    kind: "artifact";
    artifactType: string;
    schemaVersion: string;
  }[],
) {
  const directory = "skill_" + id;
  const folder = path.join(root, directory);
  cpSync(path.join(repo, "fixtures/skill-runtime/demo"), folder, {
    recursive: true,
  });
  unlinkSync(path.join(folder, "manifest.yaml"));
  const types = [
    ...new Set([outputType, ...inputs.map((item) => item.artifactType)]),
  ];
  put(folder, "manifest.json", {
    skillId: "mimic.riverbend.cli-replay",
    manifestVersion: "1.0.0",
    packageVersion: "0.1.0",
    skillFile: "SKILL.md",
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }, ...inputs],
      optional: [],
      alternatives: [],
    },
    outputs: [outputType],
    forbiddenResponsibilities: ["Approve Riverbend direction or release"],
    humanGates:
      outputType === "design-direction"
        ? [{ decision: "selected-direction", authority: "PROPOSE_ONLY" }]
        : [],
    supportedArtifactSchemas: types.map((artifactType) => ({
      artifactType,
      schemaVersion: "1.0.0",
    })),
    examples: ["examples/intent.json"],
    tests: ["tests/contract-case.json"],
  });
  return directory;
}
function nextInvocation(root: string, id: string, taskId: string) {
  const summary = accepted(root, "next", id);
  const plan = JSON.parse(
    readFileSync(path.join(root, summary.path as string), "utf8"),
  ) as {
    actions: {
      taskId: string;
      action: string;
      invocation?: {
        inputRefs: ExactArtifactRef[];
        inputBindings: { name: string; refs: ExactArtifactRef[] }[];
        scopeOwnerId: string;
      };
    }[];
  };
  const action = plan.actions.find((entry) => entry.taskId === taskId);
  expect(action?.action, JSON.stringify(plan.actions)).toBe("GENERATE");
  expect(action?.invocation).toBeDefined();
  return action!.invocation!;
}
function submitAndCommit(
  root: string,
  source: ArtifactSnapshot,
  dependencies: ExactArtifactRef[],
  typeById: Map<string, string>,
  options: { selected?: boolean; rejectBeforeAccept?: boolean } = {},
) {
  const id = source.meta.id;
  const runId = "run_" + id;
  const taskId = "task_" + id;
  const packetId = "packet_" + id;
  const proposalId = "proposal_" + id;
  const decisionId = "decision_" + id;
  const kinds = new Map<string, ExactArtifactRef[]>();
  for (const dependency of source.dependencies) {
    const ref = dependencies.find(
      (item) => item.artifactId === dependency.artifactId,
    );
    expect(
      ref,
      id + " missing replay dependency " + dependency.artifactId,
    ).toBeDefined();
  }
  for (const ref of dependencies) {
    const type = typeById.get(ref.artifactId);
    expect(type, "missing source type for " + linked(ref)).toBeDefined();
    const group = kinds.get(type!) ?? [];
    group.push(ref);
    kinds.set(type!, group);
  }
  const inputs = [...kinds].map(([artifactType, refs], index) => ({
    name: "source-" + index,
    kind: "artifact" as const,
    artifactType,
    schemaVersion: "1.0.0",
    refs,
  }));
  const task = {
    id: taskId,
    skillId: "mimic.riverbend.cli-replay",
    outputType: source.meta.type,
    scopeOwnerId: source.scope.ownerId,
    intent: "create",
    authority: "PROPOSE_ONLY",
    proposalIds: [proposalId],
    humanBrief:
      "Synthetic Riverbend replay of authored content; no live AI or real human approval",
    inputs: {
      required: [{ name: "brief", kind: "human-brief" }, ...inputs],
      optional: [],
      alternatives: [],
    },
  };
  const packageDir = preparedSkill(
    root,
    id,
    source.meta.type,
    inputs.map((item) => ({
      name: item.name,
      kind: item.kind,
      artifactType: item.artifactType,
      schemaVersion: item.schemaVersion,
    })),
  );
  put(root, "tasks_" + id + ".json", [task]);
  const started = accepted(
    root,
    "run",
    "--tasks",
    "tasks_" + id + ".json",
    "--id",
    runId,
    "--scope",
    source.scope.ownerId,
    "--mode",
    "system-first",
  );
  expect(started.runId).toBe(runId);
  const invocation = nextInvocation(root, runId, taskId);
  expect(invocation.scopeOwnerId).toBe(source.scope.ownerId);
  expect(new Set(invocation.inputRefs.map(linked))).toEqual(
    new Set(dependencies.map(linked)),
  );
  for (const binding of invocation.inputBindings)
    expect(binding.refs).toEqual(
      inputs.find((item) => item.name === binding.name)?.refs,
    );
  const { contentDigest: _digest, ...meta } = source.meta;
  void _digest;
  const candidate: ArtifactSnapshot = {
    ...source,
    meta: { ...meta, revision: 1 },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    origin: {
      actorKind: "skill",
      actorId: task.skillId,
      runId,
      createdAt: "2026-10-07T06:00:00Z",
    },
    dependencies: dependencies.map((ref) => ({ ...ref, onChange: "validate" })),
    provenance: source.provenance.map((entry) => ({
      ...entry,
      ...(entry.inputRefs
        ? {
            inputRefs: [
              ...entry.inputRefs.map((input) => {
                const replay = dependencies.find((ref) =>
                  input.startsWith(ref.artifactId + "@"),
                );
                expect(
                  replay,
                  "unmapped provenance input " + input,
                ).toBeDefined();
                return linked(replay!);
              }),
              ...(source.meta.type === "scenario" &&
              entry.path === "/content/steps"
                ? [
                    linked(
                      dependencies.find(
                        (ref) => ref.artifactId === "art_rb_direction_pair",
                      )!,
                    ),
                  ]
                : []),
            ],
          }
        : {}),
    })),
  };
  const candidateRef = exact(candidate);
  put(root, "work_" + id + ".json", {
    artifacts: [candidate],
    work: {
      result: {
        runId,
        taskId,
        skillId: task.skillId,
        inputRefs: invocation.inputRefs,
        outputRefs: [candidateRef],
        proposal: {
          packetId,
          reason: "Explicit synthetic host review",
          items: [
            {
              id: proposalId,
              ref: candidateRef,
              alternatives: ["approve", "reject"],
              rationale: "Review exact CLI replay candidate",
              evidenceLimits: [
                "Synthetic only",
                "No live model reasoning",
                "No real owner decision",
              ],
              dependents: [],
            },
          ],
        },
      },
    },
  });
  accepted(
    root,
    "submit",
    runId,
    "--task",
    taskId,
    "--package",
    packageDir,
    "--work",
    "work_" + id + ".json",
  );
  const decided: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: { status: "approved", decisionId, actorId, at: decisionAt },
    content: options.selected
      ? {
          ...(candidate.content as Record<string, unknown>),
          selectionStatus: "selected",
        }
      : candidate.content,
    provenance: options.selected
      ? [
          ...candidate.provenance,
          {
            path: "/content/selectionStatus",
            kind: "human-decision",
            decisionId,
          },
        ]
      : candidate.provenance,
  };
  decided.meta = { ...decided.meta, contentDigest: artifactDigest(decided) };
  const selectedRef = exact(decided);
  const decision = {
    id: decisionId,
    packetId,
    proposalId,
    outcome: "approved",
    actor: { kind: "human", id: actorId },
    at: decisionAt,
    rationale: "Synthetic local host confirmation only",
    output: { ref: selectedRef, artifact: decided },
  };
  const registry = state(root).registry;
  const confirmation = {
    version: 1,
    action: "decide",
    hostId,
    humanActorId: actorId,
    confirmedAt,
    runId,
    scopeOwnerId: source.scope.ownerId,
    packetId,
    packetDigest: localPacketDigest(registry.packets[packetId]!),
    requestId: decisionId,
    requestDigest: hash(decision),
    proposalId,
    proposalDigest: localProposalDigest(
      registry.runs[runId]!.proposals[proposalId]!,
    ),
    outcome: "approved",
    candidate: candidateRef,
    output: selectedRef,
  };
  put(root, "decision_" + id + ".json", decision);
  put(root, "confirmation_" + id + ".json", confirmation);
  if (options.rejectBeforeAccept) {
    expect(
      invoke(root, "decide", "--file", "decision_" + id + ".json").status,
    ).toBe(2);
    put(root, "wrong_" + id + ".json", {
      ...confirmation,
      candidate: { ...candidateRef, lockDigest: historicalDirection },
    });
    expect(
      invoke(
        root,
        "decide",
        "--file",
        "decision_" + id + ".json",
        "--confirmation",
        "wrong_" + id + ".json",
      ).status,
    ).toBe(3);
    put(root, "wrong_scope_" + id + ".json", {
      ...confirmation,
      scopeOwnerId: "domain_dispatch",
    });
    expect(
      invoke(
        root,
        "decide",
        "--file",
        "decision_" + id + ".json",
        "--confirmation",
        "wrong_scope_" + id + ".json",
      ).status,
    ).toBe(3);
    expect(
      state(root).registry.runs[runId]!.proposals[proposalId],
    ).toMatchObject({ status: "pending" });
  }
  accepted(
    root,
    "decide",
    "--file",
    "decision_" + id + ".json",
    "--confirmation",
    "confirmation_" + id + ".json",
  );
  const commit = {
    id: "commit_" + id,
    packetId,
    approvals: [{ proposalId, decisionId }],
    actor: { kind: "human", id: actorId },
    at: decisionAt,
    reason: "Publish exact synthetic CLI replay revision",
  };
  const commitConfirmation = {
    version: 1,
    action: "commit",
    hostId,
    humanActorId: actorId,
    confirmedAt,
    runId,
    scopeOwnerId: source.scope.ownerId,
    packetId,
    packetDigest: localPacketDigest(state(root).registry.packets[packetId]!),
    requestId: commit.id,
    requestDigest: hash(commit),
    approvals: commit.approvals,
  };
  put(root, "commit_" + id + ".json", commit);
  put(root, "commit_confirmation_" + id + ".json", commitConfirmation);
  if (options.rejectBeforeAccept) {
    expect(
      invoke(
        root,
        "decide",
        "--file",
        "decision_" + id + ".json",
        "--confirmation",
        "confirmation_" + id + ".json",
        "--commit",
        "commit_" + id + ".json",
      ).status,
    ).toBe(2);
    put(root, "wrong_commit_" + id + ".json", {
      ...commitConfirmation,
      requestDigest: historicalDirection,
    });
    expect(
      invoke(
        root,
        "decide",
        "--file",
        "decision_" + id + ".json",
        "--confirmation",
        "confirmation_" + id + ".json",
        "--commit",
        "commit_" + id + ".json",
        "--commit-confirmation",
        "wrong_commit_" + id + ".json",
      ).status,
    ).toBe(3);
  }
  accepted(
    root,
    "decide",
    "--file",
    "decision_" + id + ".json",
    "--confirmation",
    "confirmation_" + id + ".json",
    "--commit",
    "commit_" + id + ".json",
    "--commit-confirmation",
    "commit_confirmation_" + id + ".json",
  );
  return { candidateRef, selectedRef };
}

test("Riverbend authored chain replays through unmodified built CLI in independent processes", async () => {
  const source = await setupSystemFirst();
  roots.push(source.root);
  const root = mkdtempSync(path.join(os.tmpdir(), "mimic-riverbend-cli-"));
  roots.push(root);
  expect(existsSync(path.join(root, ".mimic"))).toBe(false);
  const scopes = [
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
  ];
  put(root, "scopes.json", {
    version: 1,
    defaultScope: "product_riverbend",
    scopes,
  });
  accepted(root, "init", "--scopes", "scopes.json");
  const ordered = [
    ...source.refs.assets,
    source.refs.current,
    source.refs.product,
    source.refs.users,
    source.refs.contract,
    ...source.refs.domains,
    source.refs.journey,
    source.refs.profile,
    source.refs.references,
    source.refs.directionA,
    source.refs.directionB,
    source.refs.request,
    source.refs.proposed,
    source.refs.scenario,
  ];
  const mapped = new Map<string, ExactArtifactRef>();
  const typeById = new Map<string, string>();
  let directionCandidate: ExactArtifactRef | undefined;
  for (const original of ordered) {
    const record = await source.runtime.artifacts.read(
      original.artifactId,
      original.revision,
    );
    expect(record.digest).toBe(original.lockDigest);
    const artifact = record.artifact;
    const dependencies = artifact.dependencies.map((dependency) => {
      const replay = mapped.get(dependency.artifactId);
      expect(
        replay,
        "unresolved authored dependency " + linked(dependency),
      ).toBeDefined();
      return replay!;
    });
    if (original.artifactId === source.refs.scenario.artifactId)
      dependencies.push(mapped.get(source.refs.directionB.artifactId)!);
    const result = submitAndCommit(root, artifact, dependencies, typeById, {
      selected: original.artifactId === source.refs.directionB.artifactId,
      rejectBeforeAccept:
        original.artifactId === source.refs.directionB.artifactId,
    });
    mapped.set(original.artifactId, result.selectedRef);
    typeById.set(original.artifactId, artifact.meta.type);
    if (original.artifactId === source.refs.directionB.artifactId)
      directionCandidate = result.candidateRef;
  }
  expect(source.refs.directionB.lockDigest).toBe(historicalDirection);
  expect(directionCandidate!.lockDigest).not.toBe(historicalDirection);
  const identity = JSON.parse(
    readFileSync(
      path.join(repo, "fixtures/dogfood/system-first/cli/replay-identity.json"),
      "utf8",
    ),
  ) as {
    historical150: { candidate: ExactArtifactRef };
    cliReplay: {
      candidate: ExactArtifactRef;
      syntheticSelected: ExactArtifactRef;
      syntheticScenario: ExactArtifactRef;
    };
  };
  expect(identity.historical150.candidate).toEqual(source.refs.directionB);
  expect(identity.cliReplay.candidate).toEqual(directionCandidate);
  expect(identity.cliReplay.syntheticSelected).toEqual(
    mapped.get(source.refs.directionB.artifactId),
  );
  expect(identity.cliReplay.syntheticScenario).toEqual(
    mapped.get(source.refs.scenario.artifactId),
  );
  const replayState = JSON.parse(
    readFileSync(path.join(root, ".mimic/workspace.json"), "utf8"),
  ) as {
    snapshots: Record<string, string>;
  };
  for (const original of ordered) {
    const replay = mapped.get(original.artifactId)!;
    const saved = JSON.parse(
      replayState.snapshots[original.artifactId + "@2"]!,
    ) as { artifact: ArtifactSnapshot; digest: string };
    const authored = (
      await source.runtime.artifacts.read(
        original.artifactId,
        original.revision,
      )
    ).artifact;
    expect(saved.digest).toBe(replay.lockDigest);
    expect(exact(saved.artifact)).toEqual(replay);
    expect(saved.artifact.meta).toMatchObject({
      id: original.artifactId,
      revision: 2,
      type: typeById.get(original.artifactId),
      schemaVersion: "1.0.0",
    });
    expect(saved.artifact.scope).toEqual(authored.scope);
    expect(saved.artifact.origin).toMatchObject({
      actorKind: "skill",
      actorId: "mimic.riverbend.cli-replay",
      runId: "run_" + original.artifactId,
    });
    const expectedDependencies = authored.dependencies.map((item) =>
      mapped.get(item.artifactId)!,
    );
    if (original.artifactId === source.refs.scenario.artifactId)
      expectedDependencies.push(mapped.get(source.refs.directionB.artifactId)!);
    expect(
      saved.artifact.dependencies.map((item) => ({
        artifactId: item.artifactId,
        revision: item.revision,
        lockDigest: item.lockDigest,
      })),
    ).toEqual(expectedDependencies);
  }
  const replaceRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replaceRefs);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (
        typeof record.artifactId === "string" &&
        typeof record.revision === "number" &&
        typeof record.lockDigest === "string"
      ) {
        const replay = mapped.get(record.artifactId);
        expect(replay, "unmapped plan ref " + record.artifactId).toBeDefined();
        return { ...record, ...replay };
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, replaceRefs(item)]),
      );
    }
    return value;
  };
  const modePlan = replaceRefs(source.modePlan) as typeof source.modePlan;
  const wrongScenarioRef = {
    ...modePlan.current.scenario,
    lockDigest: historicalDirection,
  };
  const changedScenario = {
    ...modePlan,
    current: { ...modePlan.current, scenario: wrongScenarioRef },
    proposed: { ...modePlan.proposed, scenario: wrongScenarioRef },
  };
  expect(changedScenario.current.scenario).toEqual(
    changedScenario.proposed.scenario,
  );
  put(root, "wrong-scenario-lock.json", {
    kind: "modes",
    plan: changedScenario,
    uiContract: mapped.get(source.refs.contract.artifactId),
  });
  const wrongScenario = invoke(
    root,
    "preview",
    "--file",
    "wrong-scenario-lock.json",
  );
  expect(wrongScenario.status).toBe(3);
  expect(wrongScenario.stderr).toContain(
    "MIMIC_3: Exact lock mismatch: art_rb_scenario@2",
  );
  expect(existsSync(path.join(root, changedScenario.comparisonPath))).toBe(
    false,
  );
  expect(
    readdirSync(root).filter((name) => name.startsWith(".mimic-modes-")),
  ).toEqual([]);
  put(root, "modes.json", {
    kind: "modes",
    plan: modePlan,
    uiContract: mapped.get(source.refs.contract.artifactId),
  });
  const preview = accepted(root, "preview", "--file", "modes.json") as {
    directories: string[];
    reports: {
      path: string;
      target: { planDigest: string };
      findings: { criterion: string; state: string }[];
    }[];
    fallback?: string;
  };
  expect(preview.fallback).toBeUndefined();
  expect(preview.directories).toHaveLength(2);
  expect(preview.reports).toHaveLength(2);
  const current = readFileSync(
    path.join(root, preview.directories[0]!, "index.html"),
    "utf8",
  );
  const proposed = readFileSync(
    path.join(root, preview.directories[1]!, "index.html"),
    "utf8",
  );
  expect(current).toContain("WO-1042");
  expect(current).toContain("WO-1043");
  expect(current).not.toContain("Proposed, not implemented");
  expect(proposed).toContain("Proposed, not implemented");
  expect(proposed).toContain(source.refs.request.artifactId);
  const scenarioRef = mapped.get(source.refs.scenario.artifactId)!;
  const selectedDirection = mapped.get(source.refs.directionB.artifactId)!;
  for (const [index, report] of preview.reports.entries()) {
    expect(
      report.findings.find((finding) => finding.criterion === "source-locks")
        ?.state,
    ).toBe("PASS");
    expect(
      report.findings.find((finding) => finding.criterion === "bundle-manifest")
        ?.state,
    ).toBe("PASS");
    expect(
      report.findings.filter((finding) => finding.state === "FAIL"),
    ).toEqual([]);
    const quality = JSON.parse(
      readFileSync(path.join(root, report.path), "utf8"),
    ) as { target: { scenario: ExactArtifactRef; planDigest: string } };
    const manifest = JSON.parse(
      readFileSync(
        path.join(root, preview.directories[index]!, "manifest.json"),
        "utf8",
      ),
    ) as {
      scenario: ExactArtifactRef;
      planDigest: string;
      selectedAssets: (ExactArtifactRef & { kind: string })[];
      tokenSources: ExactArtifactRef[];
    };
    expect(quality.target.scenario).toEqual(scenarioRef);
    expect(quality.target.planDigest).toBe(manifest.planDigest);
    expect(manifest.scenario).toEqual(scenarioRef);
    expect(
      manifest.selectedAssets.map((asset) => ({
        artifactId: asset.artifactId,
        revision: asset.revision,
        lockDigest: asset.lockDigest,
      })),
    ).toEqual(
      source.refs.assets.slice(0, 5).map((ref) => mapped.get(ref.artifactId)),
    );
    expect(manifest.tokenSources).toEqual([
      mapped.get(source.refs.assets[5]!.artifactId),
    ]);
  }
  put(root, "current-bundle.json", {
    kind: "standalone",
    plan: { ...modePlan.current, outputPath: "standalone-current" },
    uiContract: mapped.get(source.refs.contract.artifactId),
  });
  const standalone = accepted(
    root,
    "preview",
    "--file",
    "current-bundle.json",
  ) as typeof preview;
  expect(standalone.fallback).toBeUndefined();
  expect(standalone.directories).toHaveLength(1);
  expect(standalone.reports).toHaveLength(1);
  expect(
    standalone.reports[0]!.findings.filter(
      (finding) => finding.state === "FAIL",
    ),
  ).toEqual([]);
  const bundleDirectory = path.join(root, standalone.directories[0]!);
  expect(
    standalone.reports[0]!.findings.find(
      (finding) => finding.criterion === "ui-contract-consistency",
    )?.state,
  ).toBe("CONCERN");
  const files: Record<string, string> = Object.fromEntries(
    fiveFiles.map((name) => [
      "prototype/" + name,
      path.join(standalone.directories[0]!, name),
    ]),
  );
  cpSync(
    path.join(repo, "fixtures/dogfood/system-first/case.json"),
    path.join(root, "case.json"),
  );
  files["case.json"] = "case.json";
  for (const [name, contents] of [
    [
      "quality/limits.txt",
      "Static synthetic quality only. No dispatcher study, manual accessibility acceptance, or WCAG conformance claim.\n",
    ],
    [
      "decisions.txt",
      "9UI-150 chose only the historical candidate digest. This new CLI selected direction and release are synthetic, with independent local confirmations.\n",
    ],
    [
      "guide.md",
      "Open prototype/index.html locally. Proposed comparison and its exact System Request are review-only evidence, not a Current capability.\n",
    ],
  ]) {
    const local = name.replaceAll("/", "_");
    writeFileSync(path.join(root, local), contents);
    files[name] = local;
  }
  // The constructed dependency exists only under the temporary CLI root.
  const childRef = { packageId: "org/riverbend-colors", version: "1.0.0" };
  const childBytes = Buffer.from(
    '{"source":"synthetic design-system reference"}\n',
  );
  const childManifest: PackageManifest = {
    format: 1,
    ref: childRef,
    kind: "design-system",
    mode: "reference",
    scope: { level: "organization", ownerId: "org_riverbend" },
    schemaVersion: "1.0.0",
    approval: {
      decisionId: "synthetic_color_fixture",
      actorId,
      at: decisionAt,
    },
    files: [{ path: "colors.json", digest: sha256(childBytes) }],
    assets: [],
    artifacts: [],
    dependencies: [],
  };
  const childLock = {
    format: 1,
    root: childRef,
    assets: [],
    artifacts: [],
    packages: [],
  };
  const child = {
    manifestBytes: serializePackageDocument(childManifest),
    lockBytes: serializePackageDocument(childLock),
    files: { "colors.json": childBytes },
  };
  const childDirectory = path.join(
    root,
    "imports",
    "org",
    "riverbend-colors",
    "1.0.0",
  );
  mkdirSync(childDirectory, { recursive: true });
  writeFileSync(
    path.join(childDirectory, "manifest.json"),
    child.manifestBytes,
  );
  writeFileSync(path.join(childDirectory, "design.lock.yaml"), child.lockBytes);
  writeFileSync(path.join(childDirectory, "colors.json"), childBytes);
  const childDigest = packageDigest(child);
  const included = (
    artifacts: ExactArtifactRef[] = [],
    ownedFiles: string[] = [],
    dependencies: (typeof childRef)[] = [],
  ) => ({ status: "included", artifacts, files: ownedFiles, dependencies });
  const selected = (ref: ExactArtifactRef) => mapped.get(ref.artifactId)!;
  const inventory = {
    "product-foundation": included(
      [source.refs.current, source.refs.product, source.refs.users].map(
        selected,
      ),
      ["case.json"],
    ),
    "experience-structure": included(
      [
        ...source.refs.domains,
        source.refs.journey,
        source.refs.profile,
        source.refs.references,
        source.refs.directionB,
      ].map(selected),
    ),
    "design-system": included(source.refs.assets.map(selected), [], [childRef]),
    "interface-system-boundary": included([selected(source.refs.contract)]),
    prototype: included(
      [],
      fiveFiles.map((name) => "prototype/" + name),
    ),
    scenarios: included([scenarioRef]),
    quality: included([], ["quality/limits.txt"]),
    decisions: included([], ["decisions.txt"]),
    handoff: included([], ["guide.md"]),
  };
  mkdirSync(path.join(root, "packages"));
  const published: {
    mode: "reference" | "portable";
    digest: string;
    directory: string;
  }[] = [];
  for (const mode of ["reference", "portable"] as const) {
    const id = "riverbend_" + mode;
    const plan = {
      ref: { packageId: "product/riverbend-" + mode, version: "0.1.0" },
      mode,
      scope: {
        level: "domain",
        ownerId: "domain_triage",
        parentId: "product_riverbend",
      },
      schemaVersion: "1.0.0",
      approval: {
        decisionId: "synthetic_release_" + mode,
        actorId,
        at: decisionAt,
      },
      inventory,
      files,
      dependencies: [
        {
          ref: childRef,
          digest: childDigest,
          source: "imports",
          license: "Apache-2.0",
        },
      ],
      quality: [
        { report: standalone.reports[0]!.path, artifacts: [scenarioRef] },
      ],
    };
    put(root, id + "-plan.json", plan);
    const matrix = accepted(
      root,
      "release",
      "inspect",
      "--file",
      id + "-plan.json",
    ) as {
      planDigest: string;
      dependencyContextDigest: string;
      dependencyContext: {
        consumer: unknown;
        nodes: { ref: typeof childRef; digest: string }[];
        edges: unknown[];
      };
      reports: {
        reportDigest: string;
        findings: {
          findingIndex: number;
          findingDigest: string;
          criterion: string;
          state: string;
          severity: string;
        }[];
      }[];
    };
    expect(matrix.dependencyContext.nodes.map((node) => node.ref)).toEqual([
      childRef,
    ]);
    expect(matrix.dependencyContext.nodes[0]!.digest).toBe(childDigest);
    const policy = {
      version: 1,
      action: "release-policy",
      hostId,
      confirmedAt: new Date().toISOString(),
      planDigest: matrix.planDigest,
      decisions: matrix.reports.flatMap((report) =>
        report.findings.map((finding) => ({
          reportDigest: report.reportDigest,
          ...finding,
          blockRelease: finding.state === "FAIL",
          reason: "Explicit synthetic exact static finding review",
        })),
      ),
    };
    const dependencyConfirmation = {
      version: 1,
      action: "release-dependencies",
      hostId,
      humanActorId: actorId,
      confirmedAt: new Date().toISOString(),
      contextDigest: matrix.dependencyContextDigest,
      consumer: matrix.dependencyContext.consumer,
      destination: "packages",
      packages: matrix.dependencyContext.nodes.map((node) => ({
        ref: node.ref,
        digest: node.digest,
        kind: "imported-acceptance",
        allowed: true,
        evidence: "Synthetic exact imported package review",
      })),
      licenses: matrix.dependencyContext.edges.map((edge) => ({
        edge,
        allowed: true,
        evidence: "Synthetic exact edge license review",
      })),
      redistribution:
        mode === "portable"
          ? matrix.dependencyContext.nodes.map((node) => ({
              ref: node.ref,
              digest: node.digest,
              allowed: true,
              evidence: "Synthetic exact Portable redistribution grant",
            }))
          : [],
    };
    put(root, id + "-policy.json", policy);
    put(root, id + "-dependencies.json", dependencyConfirmation);
    const prepareArgs = [
      "release",
      "prepare",
      "--id",
      id,
      "--file",
      id + "-plan.json",
      "--destination",
      "packages",
      "--policy-confirmation",
      id + "-policy.json",
      "--dependency-confirmation",
      id + "-dependencies.json",
    ];
    expect(
      invoke(
        root,
        ...prepareArgs.filter(
          (item, index, all) =>
            item !== "--dependency-confirmation" &&
            all[index - 1] !== "--dependency-confirmation",
        ),
      ).status,
    ).toBe(4);
    if (mode === "reference") {
      const cssPath = path.join(bundleDirectory, "prototype.css");
      const originalCss = readFileSync(cssPath);
      writeFileSync(
        cssPath,
        Buffer.concat([
          originalCss,
          Buffer.from("\n/* changed after quality report */\n"),
        ]),
      );
      expect(invoke(root, ...prepareArgs).status).toBe(3);
      expect(
        existsSync(path.join(root, ".mimic/releases", id + ".prepared.json")),
      ).toBe(false);
      writeFileSync(cssPath, originalCss);
      const importedColors = path.join(childDirectory, "colors.json");
      unlinkSync(importedColors);
      expect(invoke(root, ...prepareArgs).status).toBe(4);
      expect(
        existsSync(path.join(root, ".mimic/releases", id + ".prepared.json")),
      ).toBe(false);
      writeFileSync(importedColors, childBytes);
    }
    put(root, id + "-dependencies.json", {
      ...dependencyConfirmation,
      licenses: [],
    });
    expect(invoke(root, ...prepareArgs).status).toBe(3);
    expect(
      existsSync(path.join(root, ".mimic/releases", id + ".prepared.json")),
    ).toBe(false);
    put(root, id + "-dependencies.json", dependencyConfirmation);
    if (mode === "portable") {
      put(root, id + "-dependencies.json", {
        ...dependencyConfirmation,
        redistribution: [],
      });
      expect(invoke(root, ...prepareArgs).status).toBe(3);
      expect(
        existsSync(path.join(root, ".mimic/releases", id + ".prepared.json")),
      ).toBe(false);
      put(root, id + "-dependencies.json", dependencyConfirmation);
    }
    const prepared = accepted(root, ...prepareArgs) as { reviewPath: string };
    const review = JSON.parse(
      readFileSync(path.join(root, prepared.reviewPath), "utf8"),
    ) as {
      request: { ref: typeof plan.ref; mode: typeof mode; digest: string };
      destination: string;
      requestDigest: string;
    };
    const confirmation = {
      version: 1,
      action: "release",
      hostId,
      humanActorId: actorId,
      confirmedAt: new Date().toISOString(),
      requestId: plan.approval.decisionId,
      requestDigest: review.requestDigest,
      packageId: review.request.ref.packageId,
      packageVersion: review.request.ref.version,
      mode: review.request.mode,
      digest: review.request.digest,
      destination: review.destination,
    };
    put(root, id + "-confirmation.json", confirmation);
    expect(invoke(root, "release", "publish", id).status).toBe(2);
    put(root, id + "-wrong-digest.json", {
      ...confirmation,
      digest: historicalDirection,
    });
    expect(
      invoke(
        root,
        "release",
        "publish",
        id,
        "--confirmation",
        id + "-wrong-digest.json",
      ).status,
    ).toBe(3);
    put(root, id + "-wrong-destination.json", {
      ...confirmation,
      destination: "imports",
    });
    expect(
      invoke(
        root,
        "release",
        "publish",
        id,
        "--confirmation",
        id + "-wrong-destination.json",
      ).status,
    ).toBe(3);
    expect(
      existsSync(
        path.join(root, "packages", "product", "riverbend-" + mode, "0.1.0"),
      ),
    ).toBe(false);
    const released = accepted(
      root,
      "release",
      "publish",
      id,
      "--confirmation",
      id + "-confirmation.json",
    ) as { digest: string };
    expect(released.digest).toBe(review.request.digest);
    const retry = accepted(
      root,
      "release",
      "publish",
      id,
      "--confirmation",
      id + "-confirmation.json",
    );
    expect(retry.status).toBe("recovered");
    expect(retry.digest).toBe(released.digest);
    const snapshot = await new FilePackageSource(
      path.join(root, "packages"),
    ).read(plan.ref);
    expect(snapshot).toBeDefined();
    expect(packageDigest(snapshot!)).toBe(released.digest);
    const manifest = parseManifest(snapshot!.manifestBytes);
    const lock = parseDesignLock(snapshot!.lockBytes);
    expect(manifest.ref).toEqual(plan.ref);
    expect(lock.root).toEqual(plan.ref);
    for (const ref of [scenarioRef, selectedDirection])
      expect(lock.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: ref.artifactId,
          revision: ref.revision,
          snapshotDigest: ref.lockDigest,
        }),
      );
    for (const name of fiveFiles)
      expect(
        Buffer.from(snapshot!.files["prototype/" + name]!).equals(
          readFileSync(path.join(bundleDirectory, name)),
        ),
      ).toBe(true);
    const distribution = mode === "reference" ? "external" : "bundled";
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.dependencies[0]).toMatchObject({
      ref: childRef,
      digest: childDigest,
      distribution,
    });
    expect(lock.packages).toHaveLength(1);
    expect(lock.packages[0]).toMatchObject({
      ref: childRef,
      digest: childDigest,
      distribution,
      dependencies: [],
    });
    const bundledKey = `${encodeURIComponent(childRef.packageId)}@${childRef.version}`;
    if (mode === "reference") {
      expect(Object.keys(snapshot!.bundled ?? {})).toEqual([]);
    } else {
      expect(Object.keys(snapshot!.bundled ?? {})).toEqual([bundledKey]);
      const bundledChild = snapshot!.bundled?.[bundledKey];
      expect(bundledChild).toBeDefined();
      expect(packageDigest(bundledChild!)).toBe(childDigest);
      expect(
        Buffer.from(bundledChild!.files["colors.json"]!).equals(childBytes),
      ).toBe(true);
      expect(
        Buffer.from(bundledChild!.manifestBytes).equals(
          Buffer.from(child.manifestBytes),
        ),
      ).toBe(true);
      expect(
        Buffer.from(bundledChild!.lockBytes).equals(
          Buffer.from(child.lockBytes),
        ),
      ).toBe(true);
      expect(Object.keys(bundledChild!.bundled ?? {})).toEqual([]);
    }
    published.push({
      mode,
      digest: released.digest,
      directory: path.join(
        root,
        "packages",
        "product",
        "riverbend-" + mode,
        "0.1.0",
      ),
    });
  }
  expect(published.map((item) => item.mode)).toEqual(["reference", "portable"]);
  expect(new Set(published.map((item) => item.digest)).size).toBe(2);
  expect(published.every((item) => existsSync(item.directory))).toBe(true);
  const replayRecord = {
    historicalReference: {
      ref: source.refs.directionB,
      origin: "agent",
      decision: "9UI-150 limits selection to this historical digest",
    },
    syntheticReplay: {
      candidate: directionCandidate,
      selected: mapped.get(source.refs.directionB.artifactId),
      scenario: mapped.get(source.refs.scenario.artifactId),
      run: "run_art_rb_direction_pair",
      authority: "synthetic local host only",
    },
  };
  put(root, "replay-record.json", replayRecord);
  expect(accepted(root, "status").canonical as string[]).toHaveLength(
    ordered.length,
  );
}, 2_400_000);
