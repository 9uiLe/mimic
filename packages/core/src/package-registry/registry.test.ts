import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FilePackageSource,
  PackageRegistry,
  PackageRegistryError,
  assessUpgrade,
  packageDigest,
  parseDesignLock,
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
const outsider = { level: "organization", ownerId: "other" } as const;
const scopes = [org, product, domain, outsider];
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
function registry(source: PackageSource, supportedSchemaVersions = ["1.0.0"]) {
  return new PackageRegistry(source, {
    scopes,
    supportedSchemaVersions,
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
      artifactId: "art_button",
      revision: 4,
      schemaVersion: "1.0.0",
      path: "artifact.json",
      digest: sha256(bytes("artifact")),
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
        "artifact.json": bytes("artifact"),
      },
    };
    const active = registry(memory([snapshot]));
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
            "art_button",
            4,
          )
        ).bytes,
      ),
    ).toBe("artifact");
    await expect(
      active.resolveArtifact(
        manifest.ref,
        locked,
        manifest.ref,
        "art_button",
        5,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
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
});
