import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import { buildPrototype } from "../prototype-builder/index.js";
import {
  inspectBundle,
  runStaticQualityGates,
} from "../quality-gates/index.js";
import { DependencyGraph } from "../runtime-engines/dependency.js";
import { evaluatePropertyPolicy } from "../runtime-engines/policy.js";
import { setupExperienceFirst } from "../../../../fixtures/dogfood/experience-first/setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const fixture = await setupExperienceFirst();
  roots.push(fixture.root);
  return fixture;
}

test("Experience-first locks two domains, a cross-domain journey, and inherited design context", async () => {
  const fixture = await setup();
  const graph = await DependencyGraph.load(fixture.store, [
    fixture.scenario.ref,
    fixture.domains[0]!.ref,
  ]);
  expect(graph.order.map((ref) => ref.artifactId)).toEqual(
    expect.arrayContaining([
      fixture.contract.ref.artifactId,
      fixture.journey.ref.artifactId,
      fixture.domains[0]!.ref.artifactId,
      fixture.domains[1]!.ref.artifactId,
      fixture.scenario.ref.artifactId,
    ]),
  );
  expect(fixture.caseData.domains.map((domain) => domain.primaryGoal)).toEqual([
    "Find the next case",
    "Assess one case and its evidence",
  ]);
  expect(
    (fixture.journey.artifact.content as { preservedContext: string[] })
      .preservedContext,
  ).toEqual(["entity", "terminology", "navigation", "return-path", "state"]);
  expect(fixture.scenario.artifact.scope.ownerId).toBe("domain_review");
  expect(fixture.domainAsset.artifact.dependencies[0]).toMatchObject(
    fixture.productAsset.ref,
  );
  expect(fixture.productAsset.artifact.dependencies[0]).toMatchObject(
    fixture.orgAsset.ref,
  );
  const locked = {
    parent: fixture.orgAsset.ref,
    path: "/content/definition/caseIdentity",
    policy: "locked" as const,
    value: "C-204",
  };
  expect(
    await evaluatePropertyPolicy(locked, {
      parent: fixture.orgAsset.ref,
      path: locked.path,
      value: "C-204",
      intent: "propose",
    }),
  ).toMatchObject({ allowed: true, effect: "inherit" });
  expect(
    await evaluatePropertyPolicy(locked, {
      parent: fixture.orgAsset.ref,
      path: locked.path,
      value: "C-999",
      rationale: "Synthetic candidate",
      intent: "propose",
    }),
  ).toMatchObject({ allowed: false, effect: "blocked" });
  const queueScoped = (
    id: string,
    dependencies: ArtifactSnapshot["dependencies"],
  ): ArtifactSnapshot => {
    const source = fixture.scenario.artifact;
    const bare: ArtifactSnapshot = {
      ...source,
      meta: {
        ...Object.fromEntries(
          Object.entries(source.meta).filter(
            ([key]) => key !== "contentDigest",
          ),
        ),
        id,
      } as ArtifactSnapshot["meta"],
      scope: {
        level: "domain",
        ownerId: "domain_queue",
        parentId: "product_mimic",
      },
      dependencies,
    };
    return {
      ...bare,
      meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
    };
  };
  const invalid = queueScoped(
    "art_exp_invalid_sibling",
    fixture.scenario.artifact.dependencies,
  );
  await expect(fixture.store.create(invalid)).rejects.toMatchObject({
    code: "INVALID",
    message: "Dependency scope is not an ancestor",
  });
  const validDependencies = fixture.scenario.artifact.dependencies.filter(
    (dependency) =>
      dependency.artifactId !== fixture.domains[1]!.ref.artifactId &&
      dependency.artifactId !== fixture.domainAsset.ref.artifactId,
  );
  const repaired = queueScoped("art_exp_queue_scoped_control", [
    ...validDependencies,
    { ...fixture.domains[0]!.ref, onChange: "validate" },
  ]);
  const savedControl = await fixture.store.create(repaired);
  expect(savedControl.digest).toBe(artifactDigest(repaired));
});

test("exact stale input and lock mismatch are rejected before generated output", async () => {
  const fixture = await setup();
  const previous = fixture.contract.artifact;
  const changedBare: ArtifactSnapshot = {
    ...previous,
    meta: {
      ...Object.fromEntries(
        Object.entries(previous.meta).filter(
          ([key]) => key !== "contentDigest",
        ),
      ),
      revision: 2,
      supersedesRevision: 1,
    } as ArtifactSnapshot["meta"],
    content: {
      ...(previous.content as Record<string, unknown>),
      summary: "Revised synthetic contract",
    },
  };
  const changed: ArtifactSnapshot = {
    ...changedBare,
    meta: { ...changedBare.meta, contentDigest: artifactDigest(changedBare) },
  };
  const saved = await fixture.store.create(changed);
  const graph = await DependencyGraph.load(fixture.store, [
    fixture.scenario.ref,
  ]);
  const findings = await graph.assessChanges([
    {
      artifactId: previous.meta.id,
      fromRevision: 1,
      candidateRevision: 2,
      candidateDigest: saved.digest,
    },
  ]);
  expect(
    findings.some(
      (item) =>
        item.artifact.artifactId === fixture.scenario.ref.artifactId &&
        item.freshness === "stale",
    ),
  ).toBe(true);
  const bad = structuredClone(fixture.input);
  (bad.scenario as { lockDigest: string }).lockDigest =
    `sha256:${"0".repeat(64)}`;
  await expect(
    buildPrototype(fixture.store, bad, fixture.root),
  ).rejects.toMatchObject({ code: "INTEGRITY" });
  expect(
    (await fixture.store.read(fixture.contract.ref.artifactId, 1)).digest,
  ).toBe(fixture.contract.ref.lockDigest);
});

test("generated states, exact source locks, and static quality remain reviewable", async () => {
  const fixture = await setup();
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const inspected = await inspectBundle({
    trustedRoot: fixture.root,
    directory: output.directory,
    store: fixture.store,
    uiContract: fixture.contract.ref,
  });
  const html = await readFile(
    path.join(output.directory, "index.html"),
    "utf8",
  );
  expect(html).toContain("C-204");
  expect(html).toContain("Return to filtered queue; draft remains uncommitted");
  expect(inspected.plan?.scenario).toEqual(fixture.scenario.ref);
  expect(inspected.manifest?.fixtures).toBe("synthetic");
  const { report: quality } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: output.directory,
    store: fixture.store,
    uiContract: fixture.contract.ref,
  });
  expect(quality.target.scenario).toEqual(fixture.scenario.ref);
  expect(quality.findings.some((finding) => finding.state === "FAIL")).toBe(
    false,
  );
  expect(
    quality.findings.some(
      (finding) =>
        finding.state === "CONCERN" || finding.state === "UNVERIFIED",
    ),
  ).toBe(true);
});

test("domain routing and draft editing are not representable by the current builder", async () => {
  const fixture = await setup();
  const route = structuredClone(fixture.input);
  (
    route.states[0]!.root.children![0] as unknown as { children: unknown[] }
  ).children.push({
    tag: "a",
    text: "Open C-204 review",
    href: "/review/C-204",
  });
  await expect(
    buildPrototype(fixture.store, route, fixture.root),
  ).rejects.toMatchObject({
    code: "INVALID",
    message: "Only local fragment URLs are allowed",
  });
  const target = structuredClone(fixture.input);
  (
    target.states[0]!.root.children![0]!.children![3] as { targetState: string }
  ).targetState = "review";
  await expect(
    buildPrototype(fixture.store, target, fixture.root),
  ).rejects.toMatchObject({
    code: "INVALID",
    message: "Only buttons may use supported state transitions",
  });
  const draft = structuredClone(fixture.input);
  (
    draft.states[0]!.root.children![0] as unknown as { children: unknown[] }
  ).children.push({
    tag: "input",
    id: "draft-note",
    text: "Synthetic draft note",
  });
  await expect(
    buildPrototype(fixture.store, draft, fixture.root),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REVISION_REQUIRED",
    upstreamRevisionRequest: "Unsupported semantic element: input",
  });
});

test("mobile transformation is rejected as unsupported structure, rather than fixture-label proof", async () => {
  const fixture = await setup();
  const altered = structuredClone(fixture.input) as unknown as Record<
    string,
    unknown
  >;
  altered.mobileTransformation = {
    reorder: ["decision-summary", "evidence-list"],
    collapse: "evidence-list",
    replace: "side-by-side-context",
    progressiveDisclose: "decision-history",
  };
  await expect(
    buildPrototype(
      fixture.store,
      altered as unknown as typeof fixture.input,
      fixture.root,
    ),
  ).rejects.toMatchObject({
    code: "INVALID",
    message: expect.stringContaining("unsupported field mobileTransformation"),
  });
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const css = await readFile(
    path.join(output.directory, "prototype.css"),
    "utf8",
  );
  expect(css).toContain("grid-template-columns: repeat(1, minmax(0, 1fr))");
  expect(css).not.toContain("order:");
  expect(css).toContain("[data-state][hidden] { display: none !important; }");
});

test("Experience-first Run keeps rejection out of canonical selection and requires revision history", async () => {
  const fixture = await setup();
  const { FileWorkspaceStorage } = await import("../workspace-transaction.js");
  const { ArtifactStore } = await import("../artifact-store.js");
  const { loadSchemaDirectory } = await import("../schema-registry.js");
  const { ArtifactStorePublication, RegistryAuthorityVerifier } =
    await import("../run-registry/publication.js");
  const { RunRegistry } = await import("../run-registry/registry.js");
  const backend = new FileWorkspaceStorage(
    path.join(fixture.root, "run-workspace.json"),
  );
  const schemas = await loadSchemaDirectory(
    path.resolve(import.meta.dirname, "../../../../schemas/artifacts"),
  );
  const at = "2026-10-07T00:00:00Z";
  const human = { kind: "human" as const, id: "human_fixture" };
  const agent = { kind: "agent" as const, id: "agent_experience" };
  const authority = {
    verify: async (record: { actor: { id: string } }) =>
      record.actor.id === human.id,
    allowCommit: async () => true,
  };
  const seed = {
    verifyApproval: async (approval: { decisionId?: string }) =>
      approval.decisionId === "decision_fixture",
    verifyDecision: async (id: string) => id === "decision_fixture",
  };
  const runStore = new ArtifactStore(
    backend.snapshots,
    schemas,
    (await import("../../../../fixtures/dogfood/experience-first/setup.js"))
      .scopes,
    new RegistryAuthorityVerifier(backend, authority, seed),
  );
  const registry = new RunRegistry(
    backend,
    runStore,
    authority,
    new ArtifactStorePublication(runStore, authority),
  );
  const graph = await DependencyGraph.load(fixture.store, [
    fixture.scenario.ref,
    fixture.domains[0]!.ref,
  ]);
  for (const ref of graph.order)
    await runStore.create(
      (await fixture.store.read(ref.artifactId, ref.revision)).artifact,
    );
  await registry.seedCanonical([
    fixture.productDefinition.ref,
    fixture.userTask.ref,
    fixture.contract.ref,
    fixture.journey.ref,
    fixture.domains[0]!.ref,
    fixture.domains[1]!.ref,
  ]);
  await registry.start({
    id: "run_exp",
    scope: "product_mimic",
    entryMode: "experience-first",
    base: [
      fixture.productDefinition.ref,
      fixture.userTask.ref,
      fixture.contract.ref,
      fixture.journey.ref,
    ],
    reused: [
      { ref: fixture.journey.ref, reason: "Reuse exact cross-domain journey" },
    ],
    safeActions: ["critique"],
    actor: agent,
    at,
    reason: "Desired GUI behavior exposes contract revision",
  });
  const old = fixture.contract.artifact;
  const candidate: ArtifactSnapshot = {
    ...old,
    meta: {
      ...Object.fromEntries(
        Object.entries(old.meta).filter(([key]) => key !== "contentDigest"),
      ),
      revision: 2,
      supersedesRevision: 1,
    } as ArtifactSnapshot["meta"],
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    content: {
      ...(old.content as Record<string, unknown>),
      summary: "Candidate: preserve review draft after return",
    },
  };
  await runStore.create(candidate);
  const candidateRef = {
    artifactId: old.meta.id,
    revision: 2,
    lockDigest: artifactDigest(candidate),
  };
  await registry.produce({
    runId: "run_exp",
    ref: candidateRef,
    inputs: [fixture.productDefinition.ref, fixture.userTask.ref],
    actor: agent,
    at,
    reason: "Reviewable contract candidate",
  });
  await registry.submit({
    runId: "run_exp",
    packetId: "packet_exp",
    proposals: [
      {
        id: "proposal_exp",
        ref: candidateRef,
        expectedCanonical: fixture.contract.ref,
        alternatives: ["adopt", "retain"],
        rationale: "Draft retention needs owner review",
        evidenceLimits: ["Synthetic case and automated checks only"],
        dependents: [],
      },
    ],
    actor: agent,
    at,
    reason: "Human Commit Point candidate",
  });
  const rejectedBare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 3, supersedesRevision: 2 },
    lifecycle: { status: "rejected", freshness: "valid" },
    approval: {
      status: "rejected",
      decisionId: "decision_exp_reject",
      actorId: human.id,
      at,
    },
  };
  const rejected: ArtifactSnapshot = {
    ...rejectedBare,
    meta: { ...rejectedBare.meta, contentDigest: artifactDigest(rejectedBare) },
  };
  await registry.decide({
    id: "decision_exp_reject",
    packetId: "packet_exp",
    proposalId: "proposal_exp",
    outcome: "rejected",
    actor: human,
    at,
    rationale: "Fixture rejection; not a real owner decision",
    output: {
      ref: {
        artifactId: old.meta.id,
        revision: 3,
        lockDigest: artifactDigest(rejected),
      },
      artifact: rejected,
    },
  });
  expect((await registry.snapshot()).canonical[old.meta.id].ref).toEqual(
    fixture.contract.ref,
  );
  expect((await runStore.read(old.meta.id, 3)).artifact.lifecycle.status).toBe(
    "rejected",
  );
  const renewed: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 4, supersedesRevision: 3 },
    content: {
      ...(candidate.content as Record<string, unknown>),
      summary: "Revised candidate after fixture rejection",
    },
  };
  await runStore.create(renewed);
  const renewedRef = {
    artifactId: old.meta.id,
    revision: 4,
    lockDigest: artifactDigest(renewed),
  };
  await registry.start({
    id: "run_exp_revision",
    scope: "product_mimic",
    entryMode: "experience-first",
    base: [
      fixture.productDefinition.ref,
      fixture.userTask.ref,
      fixture.contract.ref,
    ],
    reused: [],
    safeActions: ["critique"],
    actor: agent,
    at,
    reason: "Revision after rejection",
  });
  await registry.produce({
    runId: "run_exp_revision",
    ref: renewedRef,
    inputs: [fixture.productDefinition.ref, fixture.userTask.ref],
    actor: agent,
    at,
    reason: "Revised candidate",
  });
  const proposal = {
    id: "proposal_exp_revision",
    ref: renewedRef,
    expectedCanonical: fixture.contract.ref,
    alternatives: ["adopt", "retain"],
    rationale: "Revised draft treatment",
    evidenceLimits: ["No real user study"],
    dependents: [],
  };
  await expect(
    registry.submit({
      runId: "run_exp_revision",
      packetId: "packet_exp_revision",
      proposals: [proposal],
      actor: agent,
      at,
      reason: "Missing rejection link",
    }),
  ).rejects.toThrow();
  await registry.submit({
    runId: "run_exp_revision",
    packetId: "packet_exp_revision",
    proposals: [{ ...proposal, priorRejectionId: "decision_exp_reject" }],
    actor: agent,
    at,
    reason: "Cite exact rejection",
  });
  expect((await registry.snapshot()).canonical[old.meta.id].ref).toEqual(
    fixture.contract.ref,
  );
});

test("one canonical Experience-first artifact set compiles as exact Reference and Portable candidates", async () => {
  const fixture = await setup();
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const { report } = await runStaticQualityGates({
    trustedRoot: fixture.root,
    directory: output.directory,
    store: fixture.store,
    uiContract: fixture.contract.ref,
  });
  expect(report.findings.some((finding) => finding.state === "FAIL")).toBe(
    false,
  );
  const { loadSchemaDirectory } = await import("../schema-registry.js");
  const {
    FilePackageSource,
    PackageRegistry,
    packageDigest,
    serializePackageDocument,
    sha256,
  } = await import("../package-registry/index.js");
  const { compilePackage, FilePackagePublisher } =
    await import("../package-compiler/index.js");
  type PackageSource = import("../package-registry/index.js").PackageSource;
  type PackageSnapshot = import("../package-registry/index.js").PackageSnapshot;
  type CompileInput = import("../package-compiler/index.js").CompileInput;
  const schemas = await loadSchemaDirectory(
    path.resolve(import.meta.dirname, "../../../../schemas/artifacts"),
  );
  const childRef = { packageId: "org/experience-tokens", version: "1.0.0" };
  const childBytes = new TextEncoder().encode(
    "synthetic organization dependency\n",
  );
  const child: PackageSnapshot = {
    manifestBytes: serializePackageDocument({
      format: 1,
      ref: childRef,
      kind: "design-system",
      mode: "reference",
      scope: { level: "organization", ownerId: "org_9uile" },
      schemaVersion: "1.0.0",
      approval: {
        decisionId: "release_fixture",
        actorId: "human_fixture",
        at: "2026-10-07T00:00:00Z",
      },
      files: [{ path: "tokens.txt", digest: sha256(childBytes) }],
      assets: [],
      artifacts: [],
      dependencies: [],
    }),
    lockBytes: serializePackageDocument({
      format: 1,
      root: childRef,
      assets: [],
      artifacts: [],
      packages: [],
    }),
    files: { "tokens.txt": childBytes },
  };
  const childDigest = packageDigest(child);
  const packages = path.join(fixture.root, "package-candidates");
  const disk = new FilePackageSource(packages);
  const source = (candidate?: PackageSnapshot): PackageSource => ({
    read: async (ref) =>
      ref.packageId === childRef.packageId
        ? child
        : candidate && ref.packageId === "product/experience-case"
          ? candidate
          : disk.read(ref),
    versions: async (id) =>
      id === childRef.packageId
        ? [{ ...childRef, digest: childDigest }]
        : disk.versions(id),
  });
  const packageScopes = (
    await import("../../../../fixtures/dogfood/experience-first/setup.js")
  ).scopes;
  const registryForSource = (custom: PackageSource) =>
    new PackageRegistry(
      {
        read: async (ref) =>
          ref.packageId === childRef.packageId ? child : custom.read(ref),
        versions: async (id) =>
          id === childRef.packageId
            ? [{ ...childRef, digest: childDigest }]
            : custom.versions(id),
      },
      {
        scopes: packageScopes,
        supportedSchemaVersions: ["1.0.0"],
        artifactSchemas: schemas,
        authority: {
          verifyRelease: async (manifest) =>
            manifest.approval.actorId === "human_fixture",
          verifyPromotion: async () => false,
        },
        licenseAllowed: async (license) => license === "Apache-2.0",
      },
    );
  const registry = registryForSource(source());
  const graph = await DependencyGraph.load(fixture.store, [
    fixture.scenario.ref,
    fixture.domains[0]!.ref,
  ]);
  const all = graph.order.filter(
    (ref) => ref.artifactId !== fixture.domains[0]!.ref.artifactId,
  );
  const ids = new Set(all.map((ref) => ref.artifactId));
  const categories = {
    "product-foundation": [fixture.productDefinition.ref, fixture.userTask.ref],
    "experience-structure": [fixture.domains[1]!.ref, fixture.journey.ref],
    "design-system": [
      fixture.orgAsset.ref,
      fixture.productAsset.ref,
      fixture.domainAsset.ref,
      fixture.refs.pattern,
      fixture.refs.layout,
      fixture.refs.component,
      fixture.refs.responsiveRule,
      fixture.refs.accessibilityRule,
      fixture.refs.token,
    ],
    "interface-system-boundary": [fixture.contract.ref],
    scenarios: [fixture.scenario.ref],
  };
  expect(
    Object.values(categories)
      .flat()
      .map((ref) => ref.artifactId)
      .sort(),
  ).toEqual([...ids].sort());
  const names = [
    "index.html",
    "prototype.css",
    "prototype.js",
    "plan.json",
    "manifest.json",
  ];
  const files: Record<string, Uint8Array> = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        `prototype/${name}`,
        await readFile(path.join(output.directory, name)),
      ]),
    ),
  );
  files["quality/limits.md"] = new TextEncoder().encode(
    "Automated checks inspect synthetic output only; mobile structure remains unsupported.\n",
  );
  files["decisions.txt"] = new TextEncoder().encode(
    "Fixture approval only. Real human direction and release decisions remain open.\n",
  );
  files["handoff.md"] = new TextEncoder().encode(
    "Review the authored plan and mobile contract gap before release.\n",
  );
  const included = (
    artifacts: typeof all,
    paths: string[] = [],
    dependencies: (typeof childRef)[] = [],
  ) => ({ status: "included" as const, artifacts, files: paths, dependencies });
  const inventory: CompileInput["inventory"] = {
    "product-foundation": included(categories["product-foundation"]),
    "experience-structure": included(categories["experience-structure"]),
    "design-system": included(categories["design-system"], [], [childRef]),
    "interface-system-boundary": included(
      categories["interface-system-boundary"],
    ),
    prototype: included(
      [],
      names.map((name) => `prototype/${name}`),
    ),
    scenarios: included(categories.scenarios),
    quality: included([], ["quality/limits.md"]),
    decisions: included([], ["decisions.txt"]),
    handoff: included([], ["handoff.md"]),
  };
  const common: Omit<CompileInput, "mode" | "redistribution"> = {
    ref: { packageId: "product/experience-case", version: "1.0.0" },
    scope: {
      level: "domain",
      ownerId: "domain_review",
      parentId: "product_mimic",
    },
    schemaVersion: "1.0.0",
    approval: {
      decisionId: "release_fixture",
      actorId: "human_fixture",
      at: "2026-10-07T00:00:00Z",
    },
    inventory,
    files,
    dependencies: [
      {
        ref: childRef,
        digest: childDigest,
        source: "fixture-cache:org/experience-tokens",
        license: "Apache-2.0",
      },
    ],
    quality: [
      { report, artifacts: [fixture.scenario.ref, fixture.contract.ref] },
    ],
  };
  const policy = {
    assess: async (finding: { state: string }) => ({
      blockRelease: finding.state === "FAIL",
      reason: "Fixture policy retains each measured state and its limits.",
    }),
  };
  for (const mode of ["reference", "portable"] as const) {
    const input: CompileInput = {
      ...common,
      mode,
      redistribution:
        mode === "portable"
          ? [
              {
                ref: childRef,
                digest: childDigest,
                allowed: true,
                evidence: "Synthetic fixture redistribution grant",
              },
            ]
          : [],
    };
    const compiled = await compilePackage(
      input,
      fixture.store,
      registry,
      policy,
      registryForSource,
    );
    expect(compiled.qualityDecisions.map((item) => item.state)).toEqual(
      report.findings.map((item) => item.state),
    );
    expect(compiled.lock.packages[0]?.ref).toEqual(childRef);
    const reconstructed = await registryForSource(
      source(compiled.snapshot),
    ).reconstruct(input.ref, compiled.digest);
    expect(reconstructed.map((item) => item.manifest.ref.packageId)).toEqual([
      "product/experience-case",
      childRef.packageId,
    ]);
    expect(reconstructed[0]!.manifest.mode).toBe(mode);
    expect(Object.keys(reconstructed[0]!.snapshot.bundled ?? {})).toHaveLength(
      mode === "portable" ? 1 : 0,
    );
    const publisher = new FilePackagePublisher(packages);
    await expect(
      publisher.publish(compiled, { verifyRelease: async () => false }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  }
  const wholeProduct: CompileInput = {
    ...common,
    mode: "reference",
    scope: {
      level: "product",
      ownerId: "product_mimic",
      parentId: "org_9uile",
    },
    inventory: {
      ...inventory,
      "experience-structure": included([
        fixture.domains[0]!.ref,
        ...categories["experience-structure"],
      ]),
    },
  };
  const invalidWhole = await compilePackage(
    wholeProduct,
    fixture.store,
    registry,
    policy,
    registryForSource,
  );
  await expect(
    registryForSource(source(invalidWhole.snapshot)).reconstruct(
      wholeProduct.ref,
      invalidWhole.digest,
    ),
  ).rejects.toThrow("Artifact is out of package scope");
});
