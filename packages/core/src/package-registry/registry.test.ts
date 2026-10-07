import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import {
  loadSchemaDirectory,
  type SchemaRegistry,
} from "../schema-registry.js";
import {
  FilePackageSource,
  PackageRegistry,
  PackageRegistryError,
  assessUpgrade,
  packageDigest,
  parseDesignLock,
  parseManifest,
  serializePackageDocument,
  sha256,
  type DesignLock,
  type LockedDependency,
  type PackageManifest,
  type PackageRef,
  type PackageSnapshot,
  type PackageSource,
} from "./index.js";

const org = { level: "organization", ownerId: "org" } as const;
const product = {
  level: "product",
  ownerId: "product",
  parentId: "org",
} as const;
const domain = {
  level: "domain",
  ownerId: "domain",
  parentId: "product",
} as const;
const anotherDomain = {
  level: "domain",
  ownerId: "another-domain",
  parentId: "product",
} as const;
const local = { level: "local", ownerId: "local", parentId: "domain" } as const;
const foreignProduct = {
  level: "product",
  ownerId: "foreign-product",
  parentId: "other",
} as const;
const foreignDomain = {
  level: "domain",
  ownerId: "foreign-domain",
  parentId: "foreign-product",
} as const;
const outsider = { level: "organization", ownerId: "other" } as const;
const scopes = [
  org,
  product,
  domain,
  anotherDomain,
  local,
  outsider,
  foreignProduct,
  foreignDomain,
];
const bytes = (text: string) => new TextEncoder().encode(text);
const ref = (packageId: string, version = "1.0.0"): PackageRef => ({
  packageId,
  version,
});

function release(
  identity: PackageRef,
  scope: PackageManifest["scope"],
  dependencies: readonly LockedDependency[] = [],
  packages: DesignLock["packages"] = [],
  bundled: PackageSnapshot["bundled"] = {},
): PackageSnapshot {
  const contents = bytes(`package ${identity.packageId}@${identity.version}`);
  const manifest: PackageManifest = {
    format: 1,
    ref: identity,
    kind: "design",
    mode: Object.keys(bundled ?? {}).length ? "portable" : "reference",
    scope,
    schemaVersion: "1.0.0",
    approval: {
      decisionId: "decision-1",
      actorId: "human-1",
      at: "2026-10-06T00:00:00Z",
    },
    files: [{ path: "guide.txt", digest: sha256(contents) }],
    assets: [],
    artifacts: [],
    dependencies: dependencies.map(
      ({ ref, digest, source, license, distribution }) => ({
        ref,
        digest,
        source,
        license,
        distribution,
      }),
    ),
  };
  const lock: DesignLock = {
    format: 1,
    root: identity,
    assets: [],
    artifacts: [],
    packages,
  };
  return {
    manifestBytes: serializePackageDocument(manifest),
    lockBytes: serializePackageDocument(lock),
    files: { "guide.txt": contents },
    bundled,
  };
}
function withArtifacts(
  snapshot: PackageSnapshot,
  documents: readonly Record<string, unknown>[],
): PackageSnapshot {
  const manifest = JSON.parse(
    new TextDecoder().decode(snapshot.manifestBytes),
  ) as PackageManifest;
  const lock = parseDesignLock(snapshot.lockBytes);
  const artifacts = documents.map((document, index) => {
    const meta = document.meta as {
      id: string;
      revision: number;
      schemaVersion: string;
    };
    const contents = bytes(JSON.stringify(document));
    return {
      artifactId: meta.id,
      revision: meta.revision,
      schemaVersion: meta.schemaVersion,
      snapshotDigest: artifactDigest(document),
      path: `artifact-${index}.json`,
      digest: sha256(contents),
    };
  });
  return {
    ...snapshot,
    manifestBytes: serializePackageDocument({ ...manifest, artifacts }),
    lockBytes: serializePackageDocument({ ...lock, artifacts }),
    files: {
      ...snapshot.files,
      ...Object.fromEntries(
        documents.map((document, index) => [
          `artifact-${index}.json`,
          bytes(JSON.stringify(document)),
        ]),
      ),
    },
  };
}
function node(
  snapshot: PackageSnapshot,
  source = "cache:acquired",
  distribution: "external" | "bundled" = "external",
) {
  const manifest = JSON.parse(
    new TextDecoder().decode(snapshot.manifestBytes),
  ) as PackageManifest;
  return {
    ref: manifest.ref,
    digest: packageDigest(snapshot),
    source,
    license: "Apache-2.0",
    distribution,
    scope: manifest.scope,
    schemaVersion: manifest.schemaVersion,
    assets: manifest.assets,
    artifacts: manifest.artifacts,
    dependencies: manifest.dependencies.map((edge) => edge.ref),
  };
}
function memory(entries: readonly PackageSnapshot[]): PackageSource {
  const snapshots = new Map(
    entries.map((snapshot) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(snapshot.manifestBytes),
      ) as PackageManifest;
      return [`${manifest.ref.packageId}@${manifest.ref.version}`, snapshot];
    }),
  );
  return {
    async read(identity) {
      return snapshots.get(`${identity.packageId}@${identity.version}`);
    },
    async versions(packageId) {
      return [...snapshots]
        .filter(([key]) => key.startsWith(`${packageId}@`))
        .map(([, snapshot]) => {
          const manifest = JSON.parse(
            new TextDecoder().decode(snapshot.manifestBytes),
          ) as PackageManifest;
          return { ...manifest.ref, digest: packageDigest(snapshot) };
        });
    },
  };
}
function registry(
  source: PackageSource,
  supportedSchemaVersions = ["1.0.0"],
  artifactSchemas?: SchemaRegistry,
) {
  return new PackageRegistry(source, {
    scopes,
    supportedSchemaVersions,
    artifactSchemas,
    authority: {
      async verifyRelease(manifest) {
        return manifest.approval.actorId === "human-1";
      },
      async verifyPromotion(record) {
        return record.approval.actorId === "human-1";
      },
    },
    licenseAllowed: (license) => license === "Apache-2.0",
  });
}

describe("package registry", () => {
  test("resolves a transitive exact graph from acquired bytes without a registry service", async () => {
    const token = release(ref("org/tokens"), org);
    const tokenNode = node(token);
    const icon = release(ref("org/icons"), org, [tokenNode], [tokenNode]);
    const iconNode = node(icon);
    const app = release(
      ref("product/app"),
      product,
      [iconNode],
      [iconNode, tokenNode],
    );
    const resolved = await registry(memory([app, icon, token])).resolve(
      ref("product/app"),
      packageDigest(app),
    );
    expect(resolved.map((item) => item.ref.packageId)).toEqual([
      "product/app",
      "org/icons",
      "org/tokens",
    ]);
    expect(parseDesignLock(app.lockBytes).packages).toHaveLength(2);
  });

  test("portable bytes are self-contained and every bundled byte participates in digest", async () => {
    const token = release(ref("org/tokens"), org);
    const tokenNode = node(token, "cache:acquired", "bundled");
    const app = release(ref("product/app"), product, [tokenNode], [tokenNode], {
      "org%2Ftokens@1.0.0": token,
    });
    expect(
      (
        await registry(memory([app])).resolve(
          ref("product/app"),
          packageDigest(app),
        )
      ).map((item) => item.ref.packageId),
    ).toEqual(["product/app", "org/tokens"]);
    const tampered = { ...token, files: { "guide.txt": bytes("changed") } };
    const changed = { ...app, bundled: { "org%2Ftokens@1.0.0": tampered } };
    expect(packageDigest(changed)).not.toBe(packageDigest(app));
    await expect(
      registry(memory([changed])).resolve(
        ref("product/app"),
        packageDigest(changed),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("portable root rejects a transitive external edge inside a bundled reference package", async () => {
    const leaf = release(ref("org/leaf"), org);
    const leafExternal = node(leaf);
    const middle = release(
      ref("org/middle"),
      org,
      [leafExternal],
      [leafExternal],
    );
    const middleBundled = node(middle, "bundle:middle", "bundled");
    const app = release(
      ref("product/app"),
      product,
      [middleBundled],
      [middleBundled, leafExternal],
      {
        "org%2Fmiddle@1.0.0": middle,
      },
    );
    const digest = packageDigest(app);
    await expect(
      registry(memory([app, leaf])).resolve(ref("product/app"), digest),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      registry(memory([app])).resolve(ref("product/app"), digest),
    ).rejects.toMatchObject({ code: "INVALID" });

    const leafBundled = node(leaf, "bundle:leaf", "bundled");
    const middleWithLeaf = release(
      ref("org/middle"),
      org,
      [leafBundled],
      [leafBundled],
      { "org%2Fleaf@1.0.0": leaf },
    );
    const middleManifest = JSON.parse(
      new TextDecoder().decode(middleWithLeaf.manifestBytes),
    ) as PackageManifest;
    const referenceMiddle = {
      ...middleWithLeaf,
      manifestBytes: serializePackageDocument({
        ...middleManifest,
        mode: "reference",
      }),
    };
    const referenceNode = node(referenceMiddle, "bundle:middle", "bundled");
    const portable = release(
      ref("product/app"),
      product,
      [referenceNode],
      [referenceNode, leafBundled],
      { "org%2Fmiddle@1.0.0": referenceMiddle },
    );
    expect(
      (
        await registry(memory([portable])).resolve(
          ref("product/app"),
          packageDigest(portable),
        )
      ).map((item) => item.ref.packageId),
    ).toEqual(["product/app", "org/middle", "org/leaf"]);
  });

  test("portable ancestry survives a reference root and a previously visited shared package", async () => {
    const leaf = release(ref("org/leaf"), org);
    const leafExternal = node(leaf);
    const shared = release(
      ref("org/shared"),
      org,
      [leafExternal],
      [leafExternal],
    );
    const sharedBundled = node(shared, "bundle:shared", "bundled");
    const portable = release(
      ref("org/portable"),
      org,
      [sharedBundled],
      [sharedBundled, leafExternal],
      { "org%2Fshared@1.0.0": shared },
    );
    const portableExternal = node(portable, "cache:portable", "external");

    const root = release(
      ref("product/app"),
      product,
      [portableExternal],
      [portableExternal, sharedBundled, leafExternal],
    );
    await expect(
      registry(memory([root, portable, leaf])).resolve(
        ref("product/app"),
        packageDigest(root),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });

    const rootWithShared = release(
      ref("product/app"),
      product,
      [sharedBundled, portableExternal],
      [sharedBundled, portableExternal, leafExternal],
      { "org%2Fshared@1.0.0": shared },
    );
    const rootManifest = JSON.parse(
      new TextDecoder().decode(rootWithShared.manifestBytes),
    ) as PackageManifest;
    const referenceRoot = {
      ...rootWithShared,
      manifestBytes: serializePackageDocument({
        ...rootManifest,
        mode: "reference",
      }),
    };
    await expect(
      registry(memory([referenceRoot, portable, leaf])).resolve(
        ref("product/app"),
        packageDigest(referenceRoot),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("rejects tampering, missing exact releases, incompatible schemas, and forbidden scope", async () => {
    const token = release(ref("org/tokens"), org);
    const edge = node(token);
    const app = release(ref("product/app"), product, [edge], [edge]);
    const expected = packageDigest(app);
    await expect(
      registry(memory([app])).resolve(ref("product/app"), expected),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const changed = { ...token, files: { "guide.txt": bytes("tampered") } };
    await expect(
      registry(memory([app, changed])).resolve(ref("product/app"), expected),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(
      registry(memory([app, token]), ["2.0.0"]).resolve(
        ref("product/app"),
        expected,
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    const foreign = release(ref("other/tokens"), outsider);
    const foreignEdge = node(foreign);
    const scoped = release(
      ref("product/app"),
      product,
      [foreignEdge],
      [foreignEdge],
    );
    await expect(
      registry(memory([scoped, foreign])).resolve(
        ref("product/app"),
        packageDigest(scoped),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("rejects ranges, duplicate lock identities, graph mismatch, and unsigned releases", async () => {
    const fixed = release(ref("product/app"), product);
    await expect(
      registry(memory([fixed])).resolve(
        ref("product/app", "latest"),
        packageDigest(fixed),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
    const nodeA = node(release(ref("org/tokens"), org));
    const bad = release(ref("product/app"), product, [], [nodeA]);
    await expect(
      registry(memory([bad])).resolve(ref("product/app"), packageDigest(bad)),
    ).rejects.toMatchObject({ code: "INVALID" });
    const nodeB = node(release(ref("org/tokens", "2.0.0"), org));
    const conflict = release(
      ref("product/app"),
      product,
      [nodeA],
      [nodeA, nodeB],
    );
    await expect(
      registry(memory([conflict])).resolve(
        ref("product/app"),
        packageDigest(conflict),
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    const noAuthority = new PackageRegistry(memory([fixed]), {
      scopes,
      supportedSchemaVersions: ["1.0.0"],
      authority: {
        async verifyRelease() {
          return false;
        },
        async verifyPromotion() {
          return false;
        },
      },
      licenseAllowed: () => true,
    });
    await expect(
      noAuthority.resolve(ref("product/app"), packageDigest(fixed)),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test("recommendation is only a verified new-project hint; impact never changes a lock", async () => {
    const old = release(ref("org/tokens", "1.0.0"), org);
    const next = release(ref("org/tokens", "1.1.0"), org);
    const candidate = await registry(
      memory([old, next]),
    ).recommendForNewProject("org/tokens", product);
    expect(candidate).toEqual({
      ...ref("org/tokens", "1.1.0"),
      digest: packageDigest(next),
    });
    expect(assessUpgrade(ref("org/tokens"), ref("org/tokens", "1.1.0"))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(
      assessUpgrade(ref("org/tokens"), ref("org/tokens", "1.1.0"), "SAFE"),
    ).toBe("SAFE");
    expect(
      assessUpgrade(ref("org/tokens"), ref("org/tokens", "2.0.0"), "SAFE"),
    ).toBe("BREAKING");
    expect(assessUpgrade(ref("org/tokens"), ref("org/tokens"))).toBe("NONE");
    expect(
      assessUpgrade(
        ref("org/tokens", "1.9007199254740992.0"),
        ref("org/tokens", "1.9007199254740993.0"),
      ),
    ).toBe("REVIEW_REQUIRED");
    expect(packageDigest(old)).not.toBe(packageDigest(next));
  });

  test("promotion requires a reviewed step and human authority", async () => {
    const candidate = {
      source: {
        ...ref("product/assets"),
        assetId: "button",
        assetVersion: "1.0.0",
        digest: sha256(bytes("button")),
        scope: domain,
      },
      destination: {
        ...ref("product/assets", "1.1.0"),
        assetId: "button",
        assetVersion: "1.1.0",
        scope: product,
      },
      compatibilityReview: "review-1",
      licenseReview: "review-2",
      approval: {
        decisionId: "decision-1",
        actorId: "human-1",
        at: "2026-10-06T00:00:00Z",
      },
    } as const;
    await expect(
      registry(memory([])).verifyPromotion(candidate),
    ).resolves.toBeUndefined();
    await expect(
      registry(memory([])).verifyPromotion({
        ...candidate,
        destination: { ...candidate.destination, scope: org },
      }),
    ).rejects.toBeInstanceOf(PackageRegistryError);
    await expect(
      registry(memory([])).verifyPromotion({
        ...candidate,
        approval: { ...candidate.approval, actorId: "bot" },
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test("digest is deterministic across file map insertion order and distinct from artifact rules", () => {
    const snapshot = release(ref("product/app"), product);
    const a = {
      ...snapshot,
      files: { "b.txt": bytes("b"), "a.txt": bytes("a") },
    };
    const b = {
      ...snapshot,
      files: { "a.txt": bytes("a"), "b.txt": bytes("b") },
    };
    expect(packageDigest(a)).toBe(packageDigest(b));
    expect(packageDigest(snapshot)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packageDigest(snapshot)).not.toBe(sha256(snapshot.manifestBytes));
  });

  test("asset SemVer and artifact integer revision resolve as separate exact identities", async () => {
    const base = release(ref("product/app", "1.2.0"), product);
    const repository = path.resolve(import.meta.dirname, "../../../../");
    const artifactBody = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    artifactBody.scope = product;
    const artifactMeta = artifactBody.meta as {
      id: string;
      revision: number;
      schemaVersion: string;
    };
    const artifactBytes = bytes(JSON.stringify(artifactBody));
    const schemas = await loadSchemaDirectory(
      path.join(repository, "schemas/artifacts"),
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(base.manifestBytes),
    ) as PackageManifest;
    const lock = parseDesignLock(base.lockBytes);
    const asset = {
      assetId: "button",
      version: "2.1.0",
      path: "button.json",
      digest: sha256(bytes("button")),
    };
    const artifact = {
      artifactId: artifactMeta.id,
      revision: artifactMeta.revision,
      schemaVersion: artifactMeta.schemaVersion,
      snapshotDigest: artifactDigest(artifactBody),
      path: "artifact.json",
      digest: sha256(artifactBytes),
    };
    const snapshot = {
      ...base,
      manifestBytes: serializePackageDocument({
        ...manifest,
        assets: [asset],
        artifacts: [artifact],
      }),
      lockBytes: serializePackageDocument({
        ...lock,
        assets: [asset],
        artifacts: [artifact],
      }),
      files: {
        ...base.files,
        "button.json": bytes("button"),
        "artifact.json": artifactBytes,
      },
    };
    const active = registry(memory([snapshot]), ["1.0.0"], schemas);
    const locked = packageDigest(snapshot);
    expect(
      new TextDecoder().decode(
        (
          await active.resolveAsset(manifest.ref, locked, {
            ...manifest.ref,
            assetId: "button",
            assetVersion: "2.1.0",
          })
        ).bytes,
      ),
    ).toBe("button");
    expect(
      new TextDecoder().decode(
        (
          await active.resolveArtifact(
            manifest.ref,
            locked,
            manifest.ref,
            artifactMeta.id,
            artifactMeta.revision,
          )
        ).bytes,
      ),
    ).toBe(new TextDecoder().decode(artifactBytes));
    await expect(
      active.resolveArtifact(
        manifest.ref,
        locked,
        manifest.ref,
        artifactMeta.id,
        artifactMeta.revision + 1,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(
      registry(memory([snapshot])).resolve(manifest.ref, locked),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
    const wrong = { ...artifact, snapshotDigest: sha256(bytes("wrong")) };
    const changed = {
      ...snapshot,
      manifestBytes: serializePackageDocument({
        ...manifest,
        assets: [asset],
        artifacts: [wrong],
      }),
      lockBytes: serializePackageDocument({
        ...lock,
        assets: [asset],
        artifacts: [wrong],
      }),
    };
    await expect(
      registry(memory([changed]), ["1.0.0"], schemas).resolve(
        manifest.ref,
        packageDigest(changed),
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
  });

  test("a Product design deliverable inventories registered descendant artifacts without consuming them", async () => {
    const schemas = await loadSchemaDirectory(
      path.join(
        path.resolve(import.meta.dirname, "../../../../"),
        "schemas/artifacts",
      ),
    );
    const original = JSON.parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const artifact = (
      scope: PackageManifest["scope"],
      id: string,
      dependencies: unknown[] = [],
    ) => ({
      ...original,
      meta: { ...(original.meta as object), id },
      scope,
      dependencies,
    });
    const descendants = [
      artifact(domain, "art_domain_one"),
      artifact(anotherDomain, "art_domain_two"),
      artifact(local, "art_local_extension"),
      artifact(product, "art_product_own"),
      artifact(org, "art_org_ancestor"),
    ];
    const snapshot = withArtifacts(
      release(ref("product/delivery"), product),
      descendants,
    );
    const active = registry(memory([snapshot]), ["1.0.0"], schemas);
    const resolved = await active.reconstruct(
      ref("product/delivery"),
      packageDigest(snapshot),
    );
    expect(resolved[0]!.manifest.artifacts).toHaveLength(descendants.length);
    for (const item of descendants) {
      expect(
        (
          await active.resolveArtifact(
            ref("product/delivery"),
            packageDigest(snapshot),
            ref("product/delivery"),
            (item.meta as { id: string }).id,
            1,
          )
        ).entry.snapshotDigest,
      ).toBe(artifactDigest(item));
    }

    const wrongKindManifest = parseManifest(snapshot.manifestBytes);
    const wrongKind = {
      ...snapshot,
      manifestBytes: serializePackageDocument({
        ...wrongKindManifest,
        kind: "design-system",
      }),
    };
    await expect(
      registry(memory([wrongKind]), ["1.0.0"], schemas).reconstruct(
        ref("product/delivery"),
        packageDigest(wrongKind),
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    const domainRelease = withArtifacts(
      release(ref("domain/delivery"), domain),
      [artifact(local, "art_local_not_domain_inventory")],
    );
    await expect(
      registry(memory([domainRelease]), ["1.0.0"], schemas).reconstruct(
        ref("domain/delivery"),
        packageDigest(domainRelease),
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    for (const foreign of [
      artifact(foreignDomain, "art_foreign_domain"),
      artifact(foreignProduct, "art_foreign_product"),
      artifact({ ...domain, parentId: "foreign-product" }, "art_forged_parent"),
      artifact(
        { level: "domain", ownerId: "unregistered", parentId: "product" },
        "art_unregistered",
      ),
    ]) {
      const invalid = withArtifacts(release(ref("product/delivery"), product), [
        foreign,
      ]);
      await expect(
        registry(memory([invalid]), ["1.0.0"], schemas).reconstruct(
          ref("product/delivery"),
          packageDigest(invalid),
        ),
      ).rejects.toMatchObject({ code: "CORRUPT" });
    }
    const wrongDigestManifest = parseManifest(snapshot.manifestBytes);
    const wrongDigestEntries = wrongDigestManifest.artifacts.map(
      (entry, index) =>
        index === 0
          ? { ...entry, snapshotDigest: sha256(bytes("wrong")) }
          : entry,
    );
    const wrongDigest = {
      ...snapshot,
      manifestBytes: serializePackageDocument({
        ...wrongDigestManifest,
        artifacts: wrongDigestEntries,
      }),
      lockBytes: serializePackageDocument({
        ...parseDesignLock(snapshot.lockBytes),
        artifacts: wrongDigestEntries,
      }),
    };
    await expect(
      registry(memory([wrongDigest]), ["1.0.0"], schemas).reconstruct(
        ref("product/delivery"),
        packageDigest(wrongDigest),
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
  });

  test("Product inventory does not grant sibling artifact or child package consumption", async () => {
    const schemas = await loadSchemaDirectory(
      path.join(
        path.resolve(import.meta.dirname, "../../../../"),
        "schemas/artifacts",
      ),
    );
    const original = JSON.parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const target = {
      ...original,
      meta: { ...(original.meta as object), id: "art_other_domain" },
      scope: anotherDomain,
    };
    const consumer = {
      ...original,
      meta: { ...(original.meta as object), id: "art_domain_consumer" },
      scope: domain,
      dependencies: [
        {
          artifactId: "art_other_domain",
          revision: 1,
          lockDigest: artifactDigest(target),
          onChange: "validate",
        },
      ],
    };
    const invalid = withArtifacts(release(ref("product/delivery"), product), [
      consumer,
      target,
    ]);
    await expect(
      registry(memory([invalid]), ["1.0.0"], schemas).reconstruct(
        ref("product/delivery"),
        packageDigest(invalid),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
    const child = release(ref("domain/child"), domain);
    const childNode = node(child);
    const root = release(
      ref("product/delivery"),
      product,
      [childNode],
      [childNode],
    );
    await expect(
      registry(memory([root, child])).reconstruct(
        ref("product/delivery"),
        packageDigest(root),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("filesystem source reads an exact release from a local or Git checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimic-packages-"));
    try {
      const snapshot = release(ref("product/app"), product);
      const directory = path.join(root, "product", "app", "1.0.0");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "manifest.json"),
        snapshot.manifestBytes,
      );
      await writeFile(
        path.join(directory, "design.lock.yaml"),
        snapshot.lockBytes,
      );
      await writeFile(
        path.join(directory, "guide.txt"),
        snapshot.files["guide.txt"]!,
      );
      const source = new FilePackageSource(root);
      expect(await source.versions("product/app")).toEqual([
        { ...ref("product/app"), digest: packageDigest(snapshot) },
      ]);
      expect(
        (
          await registry(source).reconstruct(
            ref("product/app"),
            packageDigest(snapshot),
          )
        )[0]?.snapshot.files["guide.txt"],
      ).toEqual(snapshot.files["guide.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("license denial and incomplete nested locks block reconstruction", async () => {
    const leaf = release(ref("org/leaf"), org);
    const leafNode = node(leaf);
    const middle = release(ref("org/middle"), org, [leafNode], []);
    const middleNode = node(middle);
    const app = release(
      ref("product/app"),
      product,
      [middleNode],
      [middleNode, leafNode],
    );
    await expect(
      registry(memory([app, middle, leaf])).resolve(
        ref("product/app"),
        packageDigest(app),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
    const forbidden = { ...leafNode, license: "LicenseRef-restricted" };
    const restricted = release(
      ref("product/app"),
      product,
      [forbidden],
      [forbidden],
    );
    await expect(
      registry(memory([restricted, leaf])).resolve(
        ref("product/app"),
        packageDigest(restricted),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("schema-valid artifact locks require an exact acquired artifact dependency closure", async () => {
    const repository = path.resolve(import.meta.dirname, "../../../../");
    const schemas = await loadSchemaDirectory(
      path.join(repository, "schemas/artifacts"),
    );
    const stale = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/stale-locked-dependency.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    stale.scope = product;
    expect(schemas.validate(stale).valid).toBe(true);
    const missing = withArtifacts(release(ref("product/app"), product), [
      stale,
    ]);
    await expect(
      registry(memory([missing]), ["1.0.0"], schemas).reconstruct(
        ref("product/app"),
        packageDigest(missing),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });

    const tokens = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    tokens.scope = product;
    tokens.meta = {
      ...(tokens.meta as object),
      id: "art_tokens_01",
      revision: 3,
      supersedesRevision: 2,
    };
    expect(schemas.validate(tokens).valid).toBe(true);
    const mismatched = withArtifacts(release(ref("product/app"), product), [
      stale,
      tokens,
    ]);
    await expect(
      registry(memory([mismatched]), ["1.0.0"], schemas).reconstruct(
        ref("product/app"),
        packageDigest(mismatched),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });

    const exact = structuredClone(stale);
    exact.dependencies = [
      {
        ...(stale.dependencies as Record<string, unknown>[])[0],
        lockDigest: artifactDigest(tokens),
      },
    ];
    const complete = withArtifacts(release(ref("product/app"), product), [
      exact,
      tokens,
    ]);
    expect(
      (
        await registry(memory([complete]), ["1.0.0"], schemas).reconstruct(
          ref("product/app"),
          packageDigest(complete),
        )
      )[0]?.manifest.artifacts,
    ).toHaveLength(2);
  });

  test("conflicting cross-package artifact revisions fail closed", async () => {
    const repository = path.resolve(import.meta.dirname, "../../../../");
    const schemas = await loadSchemaDirectory(
      path.join(repository, "schemas/artifacts"),
    );
    const original = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const productArtifact = { ...original, scope: product };
    const orgArtifact = {
      ...original,
      scope: org,
      content: {
        ...(original.content as object),
        summary: "Conflicting revision",
      },
    };
    const leaf = withArtifacts(release(ref("org/leaf"), org), [orgArtifact]);
    const leafNode = node(leaf);
    const app = withArtifacts(
      release(ref("product/app"), product, [leafNode], [leafNode]),
      [productArtifact],
    );
    await expect(
      registry(memory([app, leaf]), ["1.0.0"], schemas).reconstruct(
        ref("product/app"),
        packageDigest(app),
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("authority callbacks and caller scope changes cannot mutate verified registry data", async () => {
    const mutableOrg = { level: "organization" as const, ownerId: "org" };
    const mutableProduct = {
      level: "product" as const,
      ownerId: "product",
      parentId: "org",
    };
    const snapshot = release(ref("product/app"), product);
    const authority = {
      async verifyRelease(manifest: PackageManifest) {
        (
          manifest as unknown as { schemaVersion: string; mode: string }
        ).schemaVersion = "999.0.0";
        (manifest as unknown as { mode: string }).mode = "unverified";
        return true;
      },
      async verifyPromotion() {
        return true;
      },
    };
    const active = new PackageRegistry(memory([snapshot]), {
      scopes: [mutableOrg, mutableProduct],
      supportedSchemaVersions: ["1.0.0"],
      authority,
      licenseAllowed: () => true,
    });
    mutableProduct.parentId = "other";
    const reconstructed = await active.reconstruct(
      ref("product/app"),
      packageDigest(snapshot),
    );
    expect(reconstructed[0]?.manifest.schemaVersion).toBe("1.0.0");
    expect(reconstructed[0]?.manifest.mode).toBe("reference");
    expect(reconstructed[0]?.manifest.scope).toEqual(product);
  });
});
