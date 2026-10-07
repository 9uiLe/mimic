import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import { serializeArtifactYaml } from "../artifact-codec.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
} from "../artifact-store.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import {
  FilePackageSource,
  PackageRegistry,
  packageDigest,
  parseManifest,
  parseDesignLock,
  serializePackageDocument,
  sha256,
  type PackageManifest,
  type PackageSnapshot,
  type PackageSource,
  type DesignLock,
} from "../package-registry/index.js";
import type { QualityReport } from "../quality-gates/index.js";
import {
  FilePackagePublisher,
  compilePackage,
  type CompileInput,
  type ReleasePolicy,
} from "./index.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const scope = {
  level: "product",
  ownerId: "product_mimic",
  parentId: "org_9uile",
} as const;
const organization = { level: "organization", ownerId: "org_9uile" } as const;
const approval = {
  decisionId: "release_fixture_1",
  actorId: "human_fixture_1",
  at: "2026-10-07T00:00:00Z",
};
const reference = { packageId: "product/mimic", version: "1.0.0" };
const prototypeNames = [
  "index.html",
  "prototype.css",
  "prototype.js",
  "plan.json",
  "manifest.json",
] as const;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function dependency(): PackageSnapshot {
  const content = bytes('{"token":true}\n');
  const ref = { packageId: "org/tokens", version: "1.0.0" };
  const manifest: PackageManifest = {
    format: 1,
    ref,
    kind: "design-system",
    mode: "reference",
    scope: organization,
    schemaVersion: "1.0.0",
    approval,
    files: [{ path: "tokens.json", digest: sha256(content) }],
    assets: [],
    artifacts: [],
    dependencies: [],
  };
  const lock: DesignLock = {
    format: 1,
    root: ref,
    assets: [],
    artifacts: [],
    packages: [],
  };
  return {
    manifestBytes: serializePackageDocument(manifest),
    lockBytes: serializePackageDocument(lock),
    files: { "tokens.json": content },
  };
}
function packageSource(
  directory: string,
  child: PackageSnapshot,
): PackageSource {
  const local = new FilePackageSource(directory);
  return {
    read: async (ref) =>
      ref.packageId === "org/tokens" ? child : local.read(ref),
    versions: async (id) =>
      id === "org/tokens"
        ? [{ packageId: id, version: "1.0.0", digest: packageDigest(child) }]
        : local.versions(id),
  };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-package-compiler-"));
  dirs.push(root);
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const store = new ArtifactStore(
    new FileSnapshotStorage(path.join(root, "artifacts")),
    schemas,
    [organization, scope],
    {
      verifyApproval: async (item) =>
        item.actorId === "human_fixture_1" &&
        item.decisionId === "decision_fixture_1",
      verifyDecision: async (id) => id === "decision_fixture_1",
    },
  );
  const sourceFixture = JSON.parse(
    await readFile(
      path.join(repository, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const document: ArtifactSnapshot = {
    ...sourceFixture,
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      actorId: "human_fixture_1",
      decisionId: "decision_fixture_1",
      at: "2026-10-07T00:00:00Z",
    },
  };
  const saved = await store.create({
    ...document,
    meta: { ...document.meta, contentDigest: artifactDigest(document) },
  });
  const child = dependency();
  const packages = path.join(root, "packages");
  const registryForSource = (source: PackageSource): PackageRegistry =>
    new PackageRegistry(source, {
      scopes: [organization, scope],
      supportedSchemaVersions: ["1.0.0"],
      artifactSchemas: schemas,
      authority: {
        verifyRelease: async (manifest) =>
          manifest.approval.actorId === "human_fixture_1",
        verifyPromotion: async () => false,
      },
      licenseAllowed: (license) => license === "Apache-2.0",
    });
  const registry = registryForSource(packageSource(packages, child));
  const fixtureDir = path.join(repository, "fixtures/package-compiler");
  const files: Record<string, Uint8Array> = Object.fromEntries(
    await Promise.all(
      prototypeNames.map(
        async (name) =>
          [
            `prototype/${name}`,
            await readFile(path.join(fixtureDir, "prototype", name)),
          ] as const,
      ),
    ),
  );
  files["guide.md"] = await readFile(path.join(fixtureDir, "guide.md"));
  files["decisions.txt"] = await readFile(
    path.join(fixtureDir, "decisions.txt"),
  );
  files["quality/observations.txt"] = await readFile(
    path.join(fixtureDir, "observations.txt"),
  );
  const digests = Object.fromEntries(
    prototypeNames.map((name) => [name, sha256(files[`prototype/${name}`]!)]),
  );
  const report: QualityReport = {
    action: "inspect-only",
    inspectedAt: "2026-10-07T00:00:00Z",
    target: {
      directory: "fixture/prototype",
      files: digests,
      bundleDigest: sha256(
        bytes(
          prototypeNames.map((name) => `${name}\0${digests[name]}`).join("\n"),
        ),
      ),
    },
    findings: [
      {
        criterion: "fixture-review",
        state: "CONCERN",
        severity: "MAJOR",
        reason: "Synthetic fixture review leaves semantics unverified.",
        evidence: ["quality/observations.txt"],
        limitations: "Not a real human evaluation.",
        conditions: { browser: "fixture" },
      },
    ],
  };
  const selected = {
    artifactId: document.meta.id,
    revision: 1,
    lockDigest: saved.digest,
  };
  const inventory: CompileInput["inventory"] = {
    "product-foundation": {
      status: "included",
      artifacts: [selected],
      files: [],
      dependencies: [],
    },
    "experience-structure": {
      status: "absent",
      reason: "Fixture focuses on package mechanics.",
    },
    "design-system": {
      status: "included",
      artifacts: [],
      files: [],
      dependencies: [{ packageId: "org/tokens", version: "1.0.0" }],
    },
    "interface-system-boundary": {
      status: "absent",
      reason: "No interface contract in this fixture.",
    },
    prototype: {
      status: "included",
      artifacts: [],
      files: prototypeNames.map((name) => `prototype/${name}`),
      dependencies: [],
    },
    scenarios: {
      status: "absent",
      reason: "No task scenario in this fixture.",
    },
    quality: {
      status: "included",
      artifacts: [],
      files: ["quality/observations.txt"],
      dependencies: [],
    },
    decisions: {
      status: "included",
      artifacts: [],
      files: ["decisions.txt"],
      dependencies: [],
    },
    handoff: {
      status: "included",
      artifacts: [],
      files: ["guide.md"],
      dependencies: [],
    },
  };
  const input: CompileInput = {
    ref: reference,
    mode: "reference",
    scope,
    schemaVersion: "1.0.0",
    approval,
    inventory,
    files,
    dependencies: [
      {
        ref: { packageId: "org/tokens", version: "1.0.0" },
        digest: packageDigest(child),
        source: "fixture-cache:org/tokens",
        license: "Apache-2.0",
      },
    ],
    quality: [{ report, artifacts: [selected] }],
  };
  const policy: ReleasePolicy = {
    assess: async (finding) => ({
      blockRelease: finding.state === "FAIL",
      reason: "Fixture policy records this concern without asserting a pass.",
    }),
  };
  const publisher = new FilePackagePublisher(packages);
  let approvedDigest: string | undefined;
  const approve = (digest: string): void => {
    approvedDigest = digest;
  };
  const authority = {
    verifyRelease: async (request: {
      digest: string;
      ref: typeof reference;
      mode: string;
    }) =>
      request.digest === approvedDigest &&
      request.ref.version === "1.0.0" &&
      ["reference", "portable"].includes(request.mode),
  };
  return {
    root,
    store,
    registry,
    registryForSource,
    child,
    packages,
    input,
    policy,
    publisher,
    authority,
    approve,
    saved,
  };
}

describe("package compiler and local publisher", () => {
  test.each(["reference", "portable"] as const)(
    "real store to registry reconstruction in %s mode",
    async (mode) => {
      const fixture = await setup();
      const input: CompileInput = {
        ...fixture.input,
        mode,
        redistribution:
          mode === "portable"
            ? [
                {
                  ref: fixture.input.dependencies[0]!.ref,
                  digest: fixture.input.dependencies[0]!.digest,
                  allowed: true,
                  evidence: "Fixture redistribution grant only",
                },
              ]
            : [],
      };
      const compiled = await compilePackage(
        input,
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      );
      const repeated = await compilePackage(
        input,
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      );
      expect(repeated.digest).toBe(compiled.digest);
      expect(repeated.snapshot.manifestBytes).toEqual(
        compiled.snapshot.manifestBytes,
      );
      expect(compiled.qualityDecisions[0]).toMatchObject({
        state: "CONCERN",
        severity: "MAJOR",
        blockRelease: false,
      });
      fixture.approve(compiled.digest);
      const published = await fixture.publisher.publish(
        compiled,
        fixture.authority,
      );
      expect(published.digest).toBe(compiled.digest);
      const resolved = await fixture.registry.reconstruct(
        reference,
        compiled.digest,
      );
      expect(resolved.map((value) => value.manifest.ref.packageId)).toEqual([
        "product/mimic",
        "org/tokens",
      ]);
      expect(resolved[0]!.manifest.mode).toBe(mode);
      expect(resolved[0]!.snapshot.files["inventory.json"]).toEqual(
        compiled.snapshot.files["inventory.json"],
      );
      expect(
        await fixture.registry.resolveArtifact(
          reference,
          compiled.digest,
          reference,
          fixture.saved.artifact.meta.id,
          1,
        ),
      ).toMatchObject({
        entry: { snapshotDigest: artifactDigest(fixture.saved.artifact) },
      });
      expect(Object.keys(resolved[0]!.snapshot.bundled ?? {})).toHaveLength(
        mode === "portable" ? 1 : 0,
      );
      await expect(
        fixture.publisher.publish(compiled, fixture.authority),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
  );

  test("rejects missing inventory, stale quality, absent locks and unapproved artifacts", async () => {
    const fixture = await setup();
    await expect(
      compilePackage(
        {
          ...fixture.input,
          inventory: {
            ...fixture.input.inventory,
            prototype: { status: "absent", reason: "skip" },
          },
        },
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
    const quality = fixture.input.quality[0]!;
    await expect(
      compilePackage(
        {
          ...fixture.input,
          quality: [
            {
              ...quality,
              report: {
                ...quality.report,
                target: {
                  ...quality.report.target,
                  bundleDigest: sha256(bytes("changed")),
                },
              },
            },
          ],
        },
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toThrow("stale");
    await expect(
      compilePackage(
        {
          ...fixture.input,
          inventory: {
            ...fixture.input.inventory,
            "product-foundation": {
              status: "included",
              files: [],
              dependencies: [],
              artifacts: [
                {
                  ...quality.artifacts[0]!,
                  lockDigest: sha256(bytes("wrong")),
                },
              ],
            },
          },
        },
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
    const provisional = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    await fixture.store.create({
      ...provisional,
      meta: { ...provisional.meta, id: "art_unapproved_fixture" },
    });
    await expect(
      compilePackage(
        {
          ...fixture.input,
          inventory: {
            ...fixture.input.inventory,
            "product-foundation": {
              status: "included",
              files: [],
              dependencies: [],
              artifacts: [
                {
                  artifactId: "art_unapproved_fixture",
                  revision: 1,
                  lockDigest: artifactDigest({
                    ...provisional,
                    meta: { ...provisional.meta, id: "art_unapproved_fixture" },
                  }),
                },
              ],
            },
          },
        },
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test("portable requires exact redistribution permission and reference keeps acquisition source", async () => {
    const fixture = await setup();
    await expect(
      compilePackage(
        { ...fixture.input, mode: "portable" },
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
    const compiled = await compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    expect(compiled.manifest.dependencies[0]).toMatchObject({
      distribution: "external",
      source: "fixture-cache:org/tokens",
    });
  });

  test("rejects missing or tampered exact dependency bytes", async () => {
    const fixture = await setup();
    const absent = { packageId: "org/missing", version: "1.0.0" };
    const missing: CompileInput = {
      ...fixture.input,
      dependencies: [{ ...fixture.input.dependencies[0]!, ref: absent }],
      inventory: {
        ...fixture.input.inventory,
        "design-system": {
          status: "included",
          artifacts: [],
          files: [],
          dependencies: [absent],
        },
      },
    };
    await expect(
      compilePackage(
        missing,
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    (fixture.child.files as Record<string, Uint8Array>)["tokens.json"] =
      bytes("tampered");
    await expect(
      compilePackage(
        fixture.input,
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toThrow(/digest mismatch/i);
  });

  test("rejects a verified but stale approved artifact", async () => {
    const fixture = await setup();
    const base = fixture.saved.artifact;
    const meta = Object.fromEntries(
      Object.entries(base.meta).filter(([key]) => key !== "contentDigest"),
    ) as ArtifactSnapshot["meta"];
    const stale: ArtifactSnapshot = {
      ...base,
      meta: { ...meta, id: "art_stale_package_fixture" },
      lifecycle: {
        status: "approved",
        freshness: "stale",
        freshnessReason: "Fixture validation is outdated.",
      },
    };
    const saved = await fixture.store.create({
      ...stale,
      meta: { ...stale.meta, contentDigest: artifactDigest(stale) },
    });
    const selected = {
      artifactId: stale.meta.id,
      revision: 1,
      lockDigest: saved.digest,
    };
    const input: CompileInput = {
      ...fixture.input,
      inventory: {
        ...fixture.input.inventory,
        "product-foundation": {
          status: "included",
          artifacts: [selected],
          files: [],
          dependencies: [],
        },
      },
      quality: [{ ...fixture.input.quality[0]!, artifacts: [selected] }],
    };
    await expect(
      compilePackage(
        input,
        fixture.store,
        fixture.registry,
        fixture.policy,
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test.each(["provisional", "stale"] as const)(
    "rejects %s external artifact in new release while historical registry reads remain available",
    async (state) => {
      const fixture = await setup();
      const original = fixture.saved.artifact;
      const withoutDigest = (
        meta: ArtifactSnapshot["meta"],
      ): ArtifactSnapshot["meta"] =>
        Object.fromEntries(
          Object.entries(meta).filter(([key]) => key !== "contentDigest"),
        ) as ArtifactSnapshot["meta"];
      const external: ArtifactSnapshot = {
        ...original,
        meta: { ...withoutDigest(original.meta), id: "art_external_fixture" },
        scope: organization,
        lifecycle:
          state === "stale"
            ? {
                status: "approved",
                freshness: "stale",
                freshnessReason: "Fixture external assessment is outdated.",
              }
            : { status: "provisional", freshness: "valid" },
        approval: state === "stale" ? original.approval : { status: "pending" },
      };
      const externalDocument =
        state === "stale"
          ? {
              ...external,
              meta: {
                ...external.meta,
                contentDigest: artifactDigest(external),
              },
            }
          : external;
      const externalSaved = await fixture.store.create(externalDocument);
      const root: ArtifactSnapshot = {
        ...original,
        meta: {
          ...withoutDigest(original.meta),
          id: "art_root_with_external_fixture",
        },
        dependencies: [
          {
            artifactId: external.meta.id,
            revision: 1,
            lockDigest: externalSaved.digest,
            onChange: "validate",
          },
        ],
      };
      const rootSaved = await fixture.store.create({
        ...root,
        meta: { ...root.meta, contentDigest: artifactDigest(root) },
      });
      const childManifest = parseManifest(fixture.child.manifestBytes);
      const artifactBytes = bytes(
        serializeArtifactYaml(externalSaved.artifact),
      );
      const entry = {
        artifactId: external.meta.id,
        revision: 1,
        schemaVersion: "1.0.0",
        snapshotDigest: externalSaved.digest,
        path: "artifacts/external.yaml",
        digest: sha256(artifactBytes),
      };
      const child: PackageSnapshot = {
        manifestBytes: serializePackageDocument({
          ...childManifest,
          artifacts: [entry],
        }),
        lockBytes: serializePackageDocument({
          ...parseDesignLock(fixture.child.lockBytes),
          artifacts: [entry],
        }),
        files: { ...fixture.child.files, [entry.path]: artifactBytes },
      };
      const childDigest = packageDigest(child);
      const registry = fixture.registryForSource(
        packageSource(fixture.packages, child),
      );
      expect(
        await registry.reconstruct(childManifest.ref, childDigest),
      ).toHaveLength(1);
      const selected = {
        artifactId: root.meta.id,
        revision: 1,
        lockDigest: rootSaved.digest,
      };
      const input: CompileInput = {
        ...fixture.input,
        dependencies: [
          { ...fixture.input.dependencies[0]!, digest: childDigest },
        ],
        inventory: {
          ...fixture.input.inventory,
          "product-foundation": {
            status: "included",
            artifacts: [selected],
            files: [],
            dependencies: [],
          },
        },
        quality: [{ ...fixture.input.quality[0]!, artifacts: [selected] }],
      };
      await expect(
        compilePackage(
          input,
          fixture.store,
          registry,
          fixture.policy,
          fixture.registryForSource,
        ),
      ).rejects.toMatchObject({ code: "UNVERIFIED" });
      const contextOnly: CompileInput = {
        ...fixture.input,
        dependencies: [
          { ...fixture.input.dependencies[0]!, digest: childDigest },
        ],
      };
      await expect(
        compilePackage(
          contextOnly,
          fixture.store,
          registry,
          fixture.policy,
          fixture.registryForSource,
        ),
      ).resolves.toMatchObject({ ref: reference });
    },
  );

  test("copies mutable inputs and rejects changed candidate bytes", async () => {
    const fixture = await setup();
    const baseline = await compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    const pending = compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    fixture.input.files["prototype/index.html"]![0] ^= 1;
    const copied = await pending;
    expect(copied.digest).toBe(baseline.digest);
    fixture.approve(copied.digest);
    copied.snapshot.files["guide.md"]![0] ^= 1;
    await expect(
      fixture.publisher.publish(copied, fixture.authority),
    ).rejects.toMatchObject({ code: "INVALID" });
    (baseline.qualityDecisions as unknown as { state: string }[])[0]!.state =
      "PASS";
    await expect(
      fixture.publisher.publish(baseline, fixture.authority),
    ).rejects.toThrow("review metadata");
    await expect(readdir(fixture.packages)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("keeps WebKit focus FAIL and semantic UI CONCERN separate from policy", async () => {
    const fixture = await setup();
    const original = fixture.input.quality[0]!;
    const evidence = {
      ...original,
      report: {
        ...original.report,
        findings: [
          {
            ...original.report.findings[0]!,
            criterion: "webkit-first-tab-focus",
            state: "FAIL" as const,
            severity: "BLOCKER" as const,
            reason: "Synthetic WebKit fixture loses first Tab focus.",
          },
          {
            ...original.report.findings[0]!,
            criterion: "ui-contract-consistency",
            state: "CONCERN" as const,
            reason: "Semantic consistency still requires review.",
          },
          {
            ...original.report.findings[0]!,
            criterion: "empirical-task-success",
            state: "UNVERIFIED" as const,
            reason: "No participant observation in fixture.",
          },
        ],
      },
    };
    const input = { ...fixture.input, quality: [evidence] };
    await expect(
      compilePackage(
        input,
        fixture.store,
        fixture.registry,
        {
          assess: async (finding) => ({
            blockRelease: finding.criterion === "webkit-first-tab-focus",
            reason: "Fixture policy names affected release.",
          }),
        },
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({
      code: "BLOCKED",
      decisions: [
        {
          criterion: "webkit-first-tab-focus",
          state: "FAIL",
          severity: "BLOCKER",
          blockRelease: true,
        },
        {
          criterion: "ui-contract-consistency",
          state: "CONCERN",
          blockRelease: false,
        },
        {
          criterion: "empirical-task-success",
          state: "UNVERIFIED",
          blockRelease: false,
        },
      ],
    });
  });

  test("policy blocks are separate from human authority and do not publish", async () => {
    const fixture = await setup();
    await expect(
      compilePackage(
        fixture.input,
        fixture.store,
        fixture.registry,
        {
          assess: async () => ({
            blockRelease: true,
            reason: "Fixture review required.",
          }),
        },
        fixture.registryForSource,
      ),
    ).rejects.toMatchObject({ code: "BLOCKED" });
    const compiled = await compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    await expect(
      fixture.publisher.publish(compiled, { verifyRelease: async () => false }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
    await expect(readdir(fixture.packages)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("registry preflight rejects forbidden root edges before any publication effects", async () => {
    const fixture = await setup();
    const input = {
      ...fixture.input,
      dependencies: [
        { ...fixture.input.dependencies[0]!, license: "Forbidden" },
      ],
    };
    const compiled = await compilePackage(
      input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    fixture.approve(compiled.digest);
    await expect(
      fixture.publisher.publish(compiled, fixture.authority),
    ).rejects.toThrow(/License prohibits dependency/);
    await expect(readdir(fixture.packages)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("cancellation, retry and concurrent same-version commits have no partial version", async () => {
    const fixture = await setup();
    const compiled = await compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    fixture.approve(compiled.digest);
    const abort = new AbortController();
    await expect(
      fixture.publisher.publish(
        compiled,
        {
          verifyRelease: async () => {
            abort.abort();
            return true;
          },
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    const parent = path.join(fixture.packages, "product", "mimic");
    await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
    const attempts = await Promise.allSettled([
      fixture.publisher.publish(compiled, fixture.authority),
      fixture.publisher.publish(compiled, fixture.authority),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    expect((await readdir(parent)).sort()).toEqual(["1.0.0"]);
    expect(
      (await fixture.registry.resolve(reference, compiled.digest))[0]!.ref,
    ).toEqual(reference);
  });

  test("abort during final verification leaves no version, stage or claim and permits retry", async () => {
    const fixture = await setup();
    const compiled = await compilePackage(
      fixture.input,
      fixture.store,
      fixture.registry,
      fixture.policy,
      fixture.registryForSource,
    );
    fixture.approve(compiled.digest);
    const abort = new AbortController();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalVerificationReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let checks = 0;
    const candidate = {
      ...compiled,
      verifyCurrent: async () => {
        await compiled.verifyCurrent();
        if (++checks === 3) {
          reached();
          await gate;
        }
      },
    };
    const publication = fixture.publisher.publish(
      candidate,
      fixture.authority,
      { signal: abort.signal },
    );
    await finalVerificationReached;
    abort.abort();
    release();
    await expect(publication).rejects.toMatchObject({ code: "CANCELLED" });
    const parent = path.join(fixture.packages, "product", "mimic");
    expect(await readdir(parent)).toEqual([]);
    await expect(
      fixture.registry.resolve(reference, compiled.digest),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await fixture.publisher.publish(compiled, fixture.authority);
    expect(await readdir(parent)).toEqual(["1.0.0"]);
  });
});
