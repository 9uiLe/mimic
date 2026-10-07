import { afterEach, expect, test } from "vitest";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import {
  setupSystemFirst,
  exact,
  at,
  agent,
  syntheticHuman,
} from "../../../../fixtures/dogfood/system-first/setup.js";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import {
  FilePackageSource,
  PackageRegistry,
  packageDigest,
  serializePackageDocument,
  sha256,
  type PackageManifest,
  type PackageSnapshot,
  type PackageSource,
} from "../package-registry/index.js";
import {
  compilePackage,
  FilePackagePublisher,
  type CompileInput,
} from "../package-compiler/index.js";
import { buildPrototypeModes } from "../prototype-modes/index.js";
import { buildPrototype } from "../prototype-builder/index.js";
import { runStaticQualityGates } from "../quality-gates/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

test("system-first synthetic case builds exact Current/Proposed outputs through the real artifact store", async () => {
  const x = await setupSystemFirst();
  cleanup.push(x.close);
  const modes = await buildPrototypeModes(
    x.runtime.artifacts,
    x.modePlan,
    x.root,
  );
  expect(modes.fallback).toBeUndefined();
  expect(modes.proposed).toBeDefined();
  const current = await readFile(
    path.join(modes.current.directory, "index.html"),
    "utf8",
  );
  const proposed = await readFile(
    path.join(modes.proposed!.directory, "index.html"),
    "utf8",
  );
  expect(current).toContain("work order");
  expect(current).not.toContain("Proposed, not implemented");
  expect(proposed).toContain("Proposed, not implemented");
  expect(proposed).toContain(x.refs.request.artifactId);
  for (const output of [modes.current, modes.proposed!]) {
    const { report } = await runStaticQualityGates({
      trustedRoot: x.root,
      directory: output.directory,
      store: x.runtime.artifacts,
      uiContract: x.refs.contract,
    });
    expect(report.target.planDigest).toBe(output.planDigest);
    expect(
      report.findings.find((finding) => finding.criterion === "bundle-manifest")
        ?.state,
    ).toBe("PASS");
    expect(
      report.findings.find((finding) => finding.criterion === "source-locks")
        ?.state,
    ).toBe("PASS");
    expect(
      report.findings.filter((finding) => finding.state === "FAIL"),
    ).toEqual([]);
  }
  const standalone = await buildPrototype(
    x.runtime.artifacts,
    { ...x.modePlan.current, outputPath: "standalone-current" },
    x.root,
  );
  const validated = await runStaticQualityGates({
    trustedRoot: x.root,
    directory: standalone.directory,
    store: x.runtime.artifacts,
    uiContract: x.refs.contract,
  });
  expect(
    validated.report.findings.filter((finding) => finding.state === "FAIL"),
  ).toEqual([]);
});

function decidedOutput(
  source: ArtifactSnapshot,
  decisionId: string,
  outcome: "approved" | "rejected",
) {
  const { contentDigest: _digest, ...meta } = source.meta;
  void _digest;
  const artifact = {
    ...source,
    meta: {
      ...meta,
      revision: source.meta.revision + 1,
      supersedesRevision: source.meta.revision,
    },
    lifecycle: { status: outcome, freshness: "valid" } as const,
    approval: { status: outcome, decisionId, actorId: syntheticHuman.id, at },
    content:
      outcome === "approved"
        ? {
            ...(source.content as Record<string, unknown>),
            selectionStatus: "selected",
          }
        : source.content,
    provenance:
      outcome === "approved"
        ? [
            ...source.provenance,
            {
              path: "/content/selectionStatus",
              kind: "human-decision" as const,
              decisionId,
            },
          ]
        : source.provenance,
  };
  const output = {
    ...artifact,
    meta: { ...artifact.meta, contentDigest: artifactDigest(artifact) },
  };
  return { ref: exact(output), artifact: output };
}

const directionTask = (ref: {
  artifactId: string;
  revision: number;
  lockDigest: string;
}) => ({
  id: "select-direction",
  skillId: "s11.direction-evaluator",
  outputType: "design-direction",
  scopeOwnerId: "product_riverbend",
  targetArtifactId: ref.artifactId,
  inputs: { required: [], optional: [], alternatives: [] },
  intent: "revise" as const,
  authority: "PROPOSE_ONLY" as const,
});

async function advanceSyntheticSelectionToScenario(
  x: Awaited<ReturnType<typeof setupSystemFirst>>,
) {
  const { orchestrator, registry, artifacts } = x.runtime;
  const directionRun = await orchestrator.start({
    id: "run_rb_package_direction",
    scopeOwnerId: "product_riverbend",
    entryMode: "system-first",
    actor: agent,
    at,
    tasks: [directionTask(x.refs.directionB)],
  });
  await registry.produce({
    runId: directionRun.id,
    ref: x.refs.directionB,
    inputs: [x.refs.profile, x.refs.contract, x.refs.references],
    actor: agent,
    at,
    reason: "Synthetic candidate direction",
  });
  await registry.submit({
    runId: directionRun.id,
    packetId: "packet_rb_package_direction",
    proposals: [
      {
        id: "proposal_rb_package_direction",
        ref: x.refs.directionB,
        alternatives: [
          "Provisional paired inspection",
          "Retain queue/detail",
          "Revise",
        ],
        rationale: "Synthetic test of a structural choice, not owner judgment",
        evidenceLimits: [
          "No owner decision",
          "No observed dispatcher task",
          "Comparison capability proposed only",
        ],
        dependents: [],
      },
    ],
    actor: agent,
    at,
    reason: "Synthetic review packet",
  });
  const candidateDirection = (
    await artifacts.read(x.refs.directionB.artifactId, 1)
  ).artifact;
  const direction = decidedOutput(
    candidateDirection,
    "decision_rb_package_synthetic",
    "approved",
  );
  await registry.decide({
    id: "decision_rb_package_synthetic",
    packetId: "packet_rb_package_direction",
    proposalId: "proposal_rb_package_direction",
    outcome: "approved",
    actor: syntheticHuman,
    at,
    rationale: "Synthetic fixture decision only",
    output: direction,
  });
  await registry.commit({
    id: "commit_rb_package_direction",
    packetId: "packet_rb_package_direction",
    approvals: [
      {
        proposalId: "proposal_rb_package_direction",
        decisionId: "decision_rb_package_synthetic",
      },
    ],
    actor: syntheticHuman,
    at,
    reason: "Synthetic direction commit only",
  });

  const assetTasks = x.refs.assets.map((ref, index) => ({
    id: `reuse-asset-${index}`,
    skillId: "s12.design-system-resolver",
    outputType: "design-system-asset",
    scopeOwnerId: "product_riverbend",
    targetArtifactId: ref.artifactId,
    inputs: { required: [], optional: [], alternatives: [] },
    intent: "use" as const,
    authority: "AUTONOMOUS" as const,
  }));
  const scenarioTask = {
    id: "revise-scenario",
    skillId: "s14.ui-composition-planner",
    outputType: "scenario",
    scopeOwnerId: "domain_triage",
    targetArtifactId: x.refs.scenario.artifactId,
    inputs: { required: [], optional: [], alternatives: [] },
    intent: "revise" as const,
    authority: "PROPOSE_ONLY" as const,
  };
  const scenarioRun = await orchestrator.start({
    id: "run_rb_package_scenario",
    scopeOwnerId: "domain_triage",
    entryMode: "system-first",
    actor: agent,
    at,
    tasks: [...assetTasks, scenarioTask],
  });
  const reuse = await orchestrator.next(scenarioRun.id, [
    ...assetTasks,
    scenarioTask,
  ]);
  for (const [index, ref] of x.refs.assets.entries())
    expect(
      reuse.actions.find((action) => action.taskId === `reuse-asset-${index}`),
    ).toMatchObject({ action: "USE", ref });
  const prior = (await artifacts.read(x.refs.scenario.artifactId, 1)).artifact;
  const { contentDigest: _priorDigest, ...priorMeta } = prior.meta;
  void _priorDigest;
  const proposedScenario: ArtifactSnapshot = {
    ...prior,
    meta: { ...priorMeta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    dependencies: [
      ...prior.dependencies,
      { ...direction.ref, onChange: "validate" },
    ],
    provenance: [
      ...prior.provenance,
      {
        path: "/content/expectedOutcome",
        kind: "derived",
        inputRefs: [
          `${direction.ref.artifactId}@${direction.ref.revision}#${direction.ref.lockDigest}`,
        ],
        rationale:
          "Provisional paired-inspection direction chosen only by synthetic test authority",
      },
    ],
  };
  const proposedRef = exact(proposedScenario);
  await artifacts.create(proposedScenario);
  await registry.produce({
    runId: scenarioRun.id,
    ref: proposedRef,
    inputs: [
      x.refs.scenario,
      direction.ref,
      x.refs.contract,
      x.refs.journey,
      ...x.refs.assets,
    ],
    actor: agent,
    at,
    reason: "Explicitly adopt exact synthetic direction and unchanged assets",
  });
  await registry.submit({
    runId: scenarioRun.id,
    packetId: "packet_rb_package_scenario",
    proposals: [
      {
        id: "proposal_rb_package_scenario",
        ref: proposedRef,
        expectedCanonical: x.refs.scenario,
        alternatives: ["Adopt scenario", "Retain previous scenario"],
        rationale:
          "Bind the scenario to the selected exact direction and reused Design System",
        evidenceLimits: ["No real owner review or empirical outcome"],
        dependents: [],
      },
    ],
    actor: agent,
    at,
    reason: "Synthetic scenario review",
  });
  const approvedScenario: ArtifactSnapshot = {
    ...proposedScenario,
    meta: { ...priorMeta, revision: 3, supersedesRevision: 2 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_rb_scenario_synthetic",
      actorId: syntheticHuman.id,
      at,
    },
  };
  const scenario = {
    artifact: {
      ...approvedScenario,
      meta: {
        ...approvedScenario.meta,
        contentDigest: artifactDigest(approvedScenario),
      },
    },
    ref: exact(approvedScenario),
  };
  await registry.decide({
    id: "decision_rb_scenario_synthetic",
    packetId: "packet_rb_package_scenario",
    proposalId: "proposal_rb_package_scenario",
    outcome: "approved",
    actor: syntheticHuman,
    at,
    rationale: "Synthetic fixture decision only",
    output: scenario,
  });
  await registry.commit({
    id: "commit_rb_package_scenario",
    packetId: "packet_rb_package_scenario",
    approvals: [
      {
        proposalId: "proposal_rb_package_scenario",
        decisionId: "decision_rb_scenario_synthetic",
      },
    ],
    actor: syntheticHuman,
    at,
    reason: "Synthetic scenario commit only",
  });
  expect(
    (await registry.snapshot()).canonical[x.refs.scenario.artifactId]?.ref,
  ).toEqual(scenario.ref);
  const modePlan = {
    ...x.modePlan,
    current: { ...x.modePlan.current, scenario: scenario.ref },
    proposed: { ...x.modePlan.proposed, scenario: scenario.ref },
  };
  return { direction: direction.ref, scenario: scenario.ref, modePlan };
}

test("actual Run submission guards synthetic decision, exact commit, and unchanged reuse", async () => {
  const x = await setupSystemFirst();
  cleanup.push(x.close);
  const { registry, orchestrator, artifacts } = x.runtime;
  const task = directionTask(x.refs.directionB);
  const run = await orchestrator.start({
    id: "run_rb_selection",
    scopeOwnerId: "product_riverbend",
    entryMode: "system-first",
    actor: agent,
    at,
    tasks: [task],
  });
  expect(run.entryMode).toBe("system-first");
  expect(
    run.reused.some(
      (item) => item.ref.artifactId === x.refs.current.artifactId,
    ),
  ).toBe(true);
  const next = await orchestrator.next(run.id, [task]);
  expect(next.actions[0]?.action).toBe("GENERATE");
  await registry.produce({
    runId: run.id,
    ref: x.refs.directionB,
    inputs: [x.refs.profile, x.refs.contract, x.refs.references],
    actor: agent,
    at,
    reason: "Synthetic proposed selection",
  });
  await registry.submit({
    runId: run.id,
    packetId: "packet_rb",
    proposals: [
      {
        id: "proposal_rb",
        ref: x.refs.directionB,
        alternatives: [
          "Adopt paired inspection",
          "Retain queue detail",
          "Revise",
        ],
        rationale:
          "Two structurally different directions; comparison remains unimplemented",
        evidenceLimits: ["No human review or dispatcher observation"],
        dependents: [],
      },
    ],
    actor: agent,
    at,
    reason: "Synthetic test packet only",
  });
  expect((await orchestrator.next(run.id, [task])).actions[0]?.action).toBe(
    "REQUEST_DECISION",
  );
  await expect(
    registry.commit({
      id: "commit_unapproved",
      packetId: "packet_rb",
      approvals: [{ proposalId: "proposal_rb", decisionId: "missing" }],
      actor: syntheticHuman,
      at,
      reason: "Must fail",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const candidate = (await artifacts.read(x.refs.directionB.artifactId, 1))
    .artifact;
  const output = decidedOutput(candidate, "decision_rb_synthetic", "approved");
  await registry.decide({
    id: "decision_rb_synthetic",
    packetId: "packet_rb",
    proposalId: "proposal_rb",
    outcome: "approved",
    actor: syntheticHuman,
    at,
    rationale: "Synthetic authority simulation; not a real human choice",
    output,
  });
  await registry.commit({
    id: "commit_rb_synthetic",
    packetId: "packet_rb",
    approvals: [
      { proposalId: "proposal_rb", decisionId: "decision_rb_synthetic" },
    ],
    actor: syntheticHuman,
    at,
    reason: "Synthetic commit for deterministic path proof",
  });
  expect(
    (await registry.snapshot()).canonical[x.refs.directionB.artifactId]?.ref,
  ).toEqual(output.ref);
  expect(
    (await artifacts.read(output.ref.artifactId, output.ref.revision)).digest,
  ).toBe(output.ref.lockDigest);
  const repeat = await orchestrator.start({
    id: "run_rb_repeat",
    scopeOwnerId: "product_riverbend",
    entryMode: "system-first",
    actor: agent,
    at,
    tasks: [],
  });
  expect(
    repeat.reused.some(
      (item) =>
        item.ref.artifactId === x.refs.current.artifactId &&
        item.ref.lockDigest === x.refs.current.lockDigest,
    ),
  ).toBe(true);
}, 30_000);

test.each(["reference", "portable"] as const)(
  "synthetic %s Design Package reconstructs exact source and generated bytes",
  async (mode) => {
    const x = await setupSystemFirst();
    cleanup.push(x.close);
    const chain = await advanceSyntheticSelectionToScenario(x);
    const modes = await buildPrototypeModes(
      x.runtime.artifacts,
      chain.modePlan,
      x.root,
    );
    expect(modes.proposed).toBeDefined();
    if (mode === "reference" && process.env.MIMIC_EXPORT_SYSTEM_FIRST === "1") {
      const sample = path.resolve(
        import.meta.dirname,
        "../../../../fixtures/dogfood/system-first/sample",
      );
      await rm(sample, { recursive: true, force: true });
      await cp(modes.comparisonDirectory, path.join(sample, "comparison"), {
        recursive: true,
      });
      for (const directory of ["", "current", "proposed"]) {
        const root = path.join(sample, "comparison", directory);
        for (const name of await readdir(root)) {
          if (!name.endsWith(".json")) continue;
          await rename(path.join(root, name), path.join(root, `${name}.raw`));
        }
      }
      const exportedArtifacts = path.join(sample, "artifacts");
      await mkdir(exportedArtifacts);
      for (const [name, ref] of [
        ["queue-direction", x.refs.directionA],
        ["paired-candidate", x.refs.directionB],
        ["paired-synthetic-selection", chain.direction],
        ["synthetic-scenario", chain.scenario],
      ] as const) {
        const snapshot = await x.runtime.artifacts.read(
          ref.artifactId,
          ref.revision,
        );
        expect(snapshot.digest).toBe(ref.lockDigest);
        await writeFile(
          path.join(exportedArtifacts, `${name}.json`),
          await format(JSON.stringify(snapshot.artifact), { parser: "json" }),
        );
      }
      await writeFile(
        path.join(sample, "review.json"),
        `${JSON.stringify(
          {
            authority: "synthetic-simulation-only",
            humanCommitPoint: "pending-real-owner-decision",
            candidate: x.refs.directionB,
            selectedInSimulation: chain.direction,
            scenarioAfterSimulation: chain.scenario,
            modePlanDigest: modes.modePlanDigest,
            systemRequest: x.refs.request,
            limits: [
              "No owner judgment or dispatcher task observation",
              "Authored render and mode plans; no AI design judgment demonstrated",
              "No comparison endpoint or production release",
            ],
          },
          null,
          2,
        )}\n`,
      );
    }
    if (mode === "reference") {
      const sample = path.resolve(
        import.meta.dirname,
        "../../../../fixtures/dogfood/system-first/sample/comparison",
      );
      for (const [directory, names] of [
        ["", ["comparison.json", "mode-plan.json"]],
        [
          "current",
          [
            "index.html",
            "prototype.css",
            "prototype.js",
            "plan.json",
            "manifest.json",
          ],
        ],
        [
          "proposed",
          [
            "index.html",
            "prototype.css",
            "prototype.js",
            "plan.json",
            "manifest.json",
          ],
        ],
      ] as const) {
        for (const name of names) {
          const sampleName = name.endsWith(".json") ? `${name}.raw` : name;
          expect(
            await readFile(path.join(sample, directory, sampleName)),
          ).toEqual(
            await readFile(
              path.join(modes.comparisonDirectory, directory, name),
            ),
          );
        }
      }
    }
    for (const output of [modes.current, modes.proposed!]) {
      const { report: modeQuality } = await runStaticQualityGates({
        trustedRoot: x.root,
        directory: output.directory,
        store: x.runtime.artifacts,
        uiContract: x.refs.contract,
      });
      expect(modeQuality.target.planDigest).toBe(output.planDigest);
      expect(
        modeQuality.findings.find(
          (finding) => finding.criterion === "bundle-manifest",
        )?.state,
      ).toBe("PASS");
      expect(
        modeQuality.findings.filter((finding) => finding.state === "FAIL"),
      ).toEqual([]);
    }
    const built = await buildPrototype(
      x.runtime.artifacts,
      { ...chain.modePlan.current, outputPath: "release-prototype" },
      x.root,
    );
    const report = (
      await runStaticQualityGates({
        trustedRoot: x.root,
        directory: built.directory,
        store: x.runtime.artifacts,
        uiContract: x.refs.contract,
      })
    ).report;
    expect(
      report.findings.filter((finding) => finding.state === "FAIL"),
    ).toEqual([]);
    const names = [
      "index.html",
      "prototype.css",
      "prototype.js",
      "plan.json",
      "manifest.json",
    ] as const;
    const files: Record<string, Uint8Array> = Object.fromEntries(
      await Promise.all(
        names.map(
          async (name) =>
            [
              `prototype/${name}`,
              await readFile(path.join(built.directory, name)),
            ] as const,
        ),
      ),
    );
    files["case.json"] = await readFile(
      path.join(
        import.meta.dirname,
        "../../../../fixtures/dogfood/system-first/case.json",
      ),
    );
    files["decisions.txt"] = new TextEncoder().encode(
      "Synthetic authority only. No real Human Commit Point or release approval.\n",
    );
    files["quality/limits.txt"] = new TextEncoder().encode(
      "Static checks only; dispatcher task success and WCAG 2.2 AA remain unverified.\n",
    );
    files["guide.md"] = new TextEncoder().encode(
      "Open prototype/index.html locally. Proposed comparison is a separate reviewable input, not implemented capability.\n",
    );
    const childRef = { packageId: "org/riverbend-colors", version: "1.0.0" };
    const childContent = new TextEncoder().encode(
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
        decisionId: "synthetic_seed",
        actorId: syntheticHuman.id,
        at,
      },
      files: [{ path: "colors.json", digest: sha256(childContent) }],
      assets: [],
      artifacts: [],
      dependencies: [],
    };
    const child: PackageSnapshot = {
      manifestBytes: serializePackageDocument(childManifest),
      lockBytes: serializePackageDocument({
        format: 1,
        root: childRef,
        assets: [],
        artifacts: [],
        packages: [],
      }),
      files: { "colors.json": childContent },
    };
    const packageRoot = path.join(x.root, `published-${mode}`);
    const source = (root: string): PackageSource => {
      const local = new FilePackageSource(root);
      return {
        read: async (ref) =>
          ref.packageId === childRef.packageId ? child : local.read(ref),
        versions: async (id) =>
          id === childRef.packageId
            ? [{ ...childRef, digest: packageDigest(child) }]
            : local.versions(id),
      };
    };
    const registryForSource = (value: PackageSource) =>
      new PackageRegistry(value, {
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
        supportedSchemaVersions: ["1.0.0"],
        artifactSchemas: x.runtime.artifacts.schemas,
        authority: {
          verifyRelease: async (manifest) =>
            manifest.approval.actorId === syntheticHuman.id,
          verifyPromotion: async () => false,
        },
        licenseAllowed: (license) => license === "Apache-2.0",
      });
    const registry = registryForSource(source(packageRoot));
    const included = (
      artifacts: readonly {
        artifactId: string;
        revision: number;
        lockDigest: string;
      }[],
      ownedFiles: string[] = [],
      dependencies: { packageId: string; version: string }[] = [],
    ) => ({
      status: "included" as const,
      artifacts,
      files: ownedFiles,
      dependencies,
    });
    const inventory: CompileInput["inventory"] = {
      "product-foundation": included(
        [x.refs.product, x.refs.users, x.refs.current],
        ["case.json"],
      ),
      "experience-structure": included([
        ...x.refs.domains,
        x.refs.journey,
        x.refs.profile,
        x.refs.references,
        chain.direction,
      ]),
      "design-system": included(x.refs.assets, [], [childRef]),
      "interface-system-boundary": included([x.refs.contract]),
      prototype: included(
        [],
        names.map((name) => `prototype/${name}`),
      ),
      scenarios: included([chain.scenario]),
      quality: included([], ["quality/limits.txt"]),
      decisions: included([], ["decisions.txt"]),
      handoff: included([], ["guide.md"]),
    };
    const input: CompileInput = {
      ref: { packageId: `product/riverbend-${mode}`, version: "0.1.0" },
      mode,
      scope: {
        level: "domain",
        ownerId: "domain_triage",
        parentId: "product_riverbend",
      },
      schemaVersion: "1.0.0",
      approval: {
        decisionId: "synthetic_release",
        actorId: syntheticHuman.id,
        at,
      },
      inventory,
      files,
      dependencies: [
        {
          ref: childRef,
          digest: packageDigest(child),
          source: "fixture:org/riverbend-colors",
          license: "Apache-2.0",
        },
      ],
      redistribution:
        mode === "portable"
          ? [
              {
                ref: childRef,
                digest: packageDigest(child),
                allowed: true,
                evidence:
                  "Explicit synthetic redistribution grant for fixture-owned bytes",
              },
            ]
          : [],
      quality: [{ report, artifacts: [chain.scenario] }],
    };
    const policy = {
      assess: async (finding: { state: string }) => ({
        blockRelease: finding.state === "FAIL",
        reason:
          "Fixture-only package: disclose unverified human and empirical outcomes",
      }),
    };
    const compiled = await compilePackage(
      input,
      x.runtime.artifacts,
      registry,
      policy,
      registryForSource,
    );
    expect(compiled.digest).toBe(packageDigest(compiled.snapshot));
    await expect(
      new FilePackagePublisher(packageRoot).publish(compiled, {
        verifyRelease: async () => false,
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
    const published = await new FilePackagePublisher(packageRoot).publish(
      compiled,
      {
        verifyRelease: async (request) =>
          request.digest === compiled.digest && request.mode === mode,
      },
    );
    expect(published.digest).toBe(compiled.digest);
    const reconstructed = await registry.reconstruct(
      input.ref,
      compiled.digest,
    );
    expect(
      reconstructed[0]!.manifest.artifacts.some(
        (entry) =>
          entry.artifactId === chain.direction.artifactId &&
          entry.revision === chain.direction.revision &&
          entry.snapshotDigest === chain.direction.lockDigest,
      ),
    ).toBe(true);
    expect(
      reconstructed[0]!.manifest.artifacts.some(
        (entry) =>
          entry.artifactId === chain.scenario.artifactId &&
          entry.revision === chain.scenario.revision &&
          entry.snapshotDigest === chain.scenario.lockDigest,
      ),
    ).toBe(true);
    expect(reconstructed.map((item) => item.manifest.ref.packageId)).toEqual([
      input.ref.packageId,
      childRef.packageId,
    ]);
    expect(reconstructed[0]!.snapshot.files["prototype/index.html"]).toEqual(
      Uint8Array.from(files["prototype/index.html"]!),
    );
    expect(Object.keys(reconstructed[0]!.snapshot.bundled ?? {})).toHaveLength(
      mode === "portable" ? 1 : 0,
    );
  },
  120_000,
);

test("rejection requires a new revision and explicit retry provenance", async () => {
  const x = await setupSystemFirst();
  cleanup.push(x.close);
  const { registry, orchestrator, artifacts } = x.runtime;
  const task = directionTask(x.refs.directionB);
  await orchestrator.start({
    id: "run_rb_reject",
    scopeOwnerId: "product_riverbend",
    entryMode: "system-first",
    actor: agent,
    at,
    tasks: [task],
  });
  await registry.produce({
    runId: "run_rb_reject",
    ref: x.refs.directionB,
    inputs: [x.refs.profile, x.refs.contract, x.refs.references],
    actor: agent,
    at,
    reason: "Review alternative",
  });
  const item = (ref: typeof x.refs.directionB, priorRejectionId?: string) => ({
    id: `proposal_${ref.revision}`,
    ref,
    alternatives: ["Select", "Reject", "Revise"],
    rationale: "Synthetic structural choice",
    evidenceLimits: ["No dispatcher observation"],
    dependents: [],
    ...(priorRejectionId ? { priorRejectionId } : {}),
  });
  await registry.submit({
    runId: "run_rb_reject",
    packetId: "packet_reject",
    proposals: [item(x.refs.directionB)],
    actor: agent,
    at,
    reason: "Synthetic review",
  });
  const source = (await artifacts.read(x.refs.directionB.artifactId, 1))
    .artifact;
  const rejected = decidedOutput(
    source,
    "decision_reject_synthetic",
    "rejected",
  );
  await registry.decide({
    id: "decision_reject_synthetic",
    packetId: "packet_reject",
    proposalId: "proposal_1",
    outcome: "rejected",
    actor: syntheticHuman,
    at,
    rationale: "Synthetic rejection; comparison unsupported",
    output: rejected,
  });
  expect(
    (await artifacts.read(rejected.ref.artifactId, rejected.ref.revision))
      .digest,
  ).toBe(rejected.ref.lockDigest);
  const { contentDigest: _digest, ...meta } = rejected.artifact.meta;
  void _digest;
  const retry: ArtifactSnapshot = {
    ...source,
    meta: { ...meta, revision: 3, supersedesRevision: 2 },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    content: {
      ...(source.content as Record<string, unknown>),
      summary: "Revised paired inspection with explicit mock boundary",
    },
    provenance: [
      {
        path: "/content/summary",
        kind: "assumption",
        rationale: "Retry after synthetic rejection decision_reject_synthetic",
      },
    ],
  };
  const retryRef = exact(retry);
  await artifacts.create(retry);
  await registry.produce({
    runId: "run_rb_reject",
    ref: retryRef,
    inputs: [x.refs.profile, x.refs.contract, x.refs.references],
    actor: agent,
    at,
    reason: "New proposed revision after rejection",
  });
  await expect(
    registry.submit({
      runId: "run_rb_reject",
      packetId: "packet_bad_retry",
      proposals: [item(retryRef)],
      actor: agent,
      at,
      reason: "Missing rejection link",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await registry.submit({
    runId: "run_rb_reject",
    packetId: "packet_retry",
    proposals: [item(retryRef, "decision_reject_synthetic")],
    actor: agent,
    at,
    reason: "Explicit revision after rejection",
  });
  expect(
    (await registry.run("run_rb_reject")).run.proposals.proposal_3
      ?.priorRejectionId,
  ).toBe("decision_reject_synthetic");
}, 30_000);

test("stale locks, unapproved scenario, and tampering fail before a durable claim", async () => {
  const x = await setupSystemFirst();
  cleanup.push(x.close);
  const wrong = {
    ...x.modePlan,
    choices: [
      {
        ...x.modePlan.choices[0]!,
        capability: {
          ...x.refs.current,
          lockDigest: `sha256:${"0".repeat(64)}`,
        },
      },
      x.modePlan.choices[1]!,
    ],
  };
  await expect(
    buildPrototypeModes(x.runtime.artifacts, wrong, x.root),
  ).rejects.toMatchObject({ code: "INTEGRITY" });
  const source = (await x.runtime.artifacts.read(x.refs.scenario.artifactId, 1))
    .artifact;
  const { contentDigest: _digest, ...meta } = source.meta;
  void _digest;
  const proposed: ArtifactSnapshot = {
    ...source,
    meta: { ...meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
  };
  await x.runtime.artifacts.create(proposed);
  await expect(
    buildPrototype(
      x.runtime.artifacts,
      {
        ...x.modePlan.current,
        scenario: exact(proposed),
        outputPath: "unapproved-scenario",
      },
      x.root,
    ),
  ).rejects.toMatchObject({ code: "UNAPPROVED" });
  const built = await buildPrototype(
    x.runtime.artifacts,
    { ...x.modePlan.current, outputPath: "tampered-prototype" },
    x.root,
  );
  const original = await readFile(
    path.join(built.directory, "index.html"),
    "utf8",
  );
  await writeFile(
    path.join(built.directory, "index.html"),
    original.replace("<main", "<div"),
  );
  const quality = (
    await runStaticQualityGates({
      trustedRoot: x.root,
      directory: built.directory,
      store: x.runtime.artifacts,
      uiContract: x.refs.contract,
    })
  ).report;
  expect(
    quality.findings.some(
      (finding) =>
        finding.criterion === "html-lint" &&
        finding.state === "FAIL" &&
        finding.severity === "MAJOR",
    ),
  ).toBe(true);
});
