import { expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  artifactDigest,
  CANONICALIZATION_VERSION,
  canonicalJson,
} from "./artifact-canonical.js";
import {
  ArtifactStore,
  type ArtifactSnapshot,
  type SnapshotStorage,
} from "./artifact-store.js";
import { loadSchemaDirectory } from "./schema-registry.js";
import { FileWorkspaceStorage } from "./workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../..");

test("bounded diamond profile", async () => {
  const base = JSON.parse(
    await readFile(
      path.join(repository, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const snapshots: Record<string, string> = {};
  let previous: ArtifactSnapshot[] = [];
  let edges = 0;
  for (let layer = 10; layer >= 0; layer--) {
    const count = layer === 0 ? 1 : 2;
    const current: ArtifactSnapshot[] = [];
    for (let side = 0; side < count; side++) {
      const deps = previous.map((child) => ({
        artifactId: child.meta.id,
        revision: 1,
        lockDigest: artifactDigest(child),
        onChange: "validate",
      }));
      edges += deps.length;
      const artifact: ArtifactSnapshot = {
        ...base,
        meta: { ...base.meta, id: `art_profile_${layer}_${side}` },
        dependencies: deps,
        content: {
          ...(base.content as object),
          summary: `Layer ${layer} side ${side}`,
        },
      };
      snapshots[`${artifact.meta.id}@1`] = canonicalJson({
        canonicalization: CANONICALIZATION_VERSION,
        digest: artifactDigest(artifact),
        artifact,
      });
      current.push(artifact);
    }
    previous = current;
  }
  const root = previous[0]!;
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimic-9ui-153-"));
  try {
    const file = path.join(dir, "workspace.json");
    const registry = {
      canonical: {},
      freshness: {},
      runs: {},
      packets: {},
      decisions: {},
      commits: {},
      events: [],
    };
    await writeFile(file, JSON.stringify({ version: 1, snapshots, registry }));
    const workspace = new FileWorkspaceStorage(file);
    let loads = 0;
    const instrumented = workspace as unknown as {
      readSource: () => Promise<unknown>;
    };
    const originalLoad = instrumented.readSource.bind(workspace);
    instrumented.readSource = async () => {
      loads++;
      return originalLoad();
    };
    let reads = 0;
    const storage: SnapshotStorage = {
      async read(id, revision) {
        reads++;
        return workspace.snapshots.read(id, revision);
      },
      revisions: workspace.snapshots.revisions,
      writeIfAbsent: workspace.snapshots.writeIfAbsent,
      withReadSession: workspace.snapshots.withReadSession,
    };
    let validates = 0;
    const originalValidate = schemas.validate.bind(schemas);
    schemas.validate = (artifact) => {
      validates++;
      return originalValidate(artifact);
    };
    const store = new ArtifactStore(storage, schemas, [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ]);
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const result = await store.read(root.meta.id, 1);
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    expect({
      nodes: Object.keys(snapshots).length,
      edges,
      reads,
      validates,
      workspaceLoads: loads,
    }).toEqual({
      nodes: 21,
      edges: 38,
      reads: 21,
      validates: 21,
      workspaceLoads: 2,
    });
    expect(result.digest).toBe(artifactDigest(root));
    console.log(
      JSON.stringify({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }),
    );

    let changed = false;
    schemas.validate = (artifact) => {
      const outcome = originalValidate(artifact);
      if (!changed) {
        changed = true;
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            snapshots,
            registry: { ...registry, events: [{ changed: true }] },
          }),
        );
      }
      return outcome;
    };
    await expect(store.read(root.meta.id, 1)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    schemas.validate = originalValidate;

    const badLock: ArtifactSnapshot = {
      ...root,
      dependencies: [
        { ...root.dependencies[0]!, lockDigest: `sha256:${"0".repeat(64)}` },
        ...root.dependencies.slice(1),
      ],
    };
    snapshots[`${root.meta.id}@1`] = canonicalJson({
      canonicalization: CANONICALIZATION_VERSION,
      digest: artifactDigest(badLock),
      artifact: badLock,
    });
    await writeFile(file, JSON.stringify({ version: 1, snapshots, registry }));
    await expect(store.read(root.meta.id, 1)).rejects.toMatchObject({
      code: "CORRUPT",
    });

    snapshots[`${root.meta.id}@1`] = canonicalJson({
      canonicalization: CANONICALIZATION_VERSION,
      digest: artifactDigest(root),
      artifact: root,
    });
    const leaf = JSON.parse(snapshots["art_profile_10_0@1"]!)
      .artifact as ArtifactSnapshot;
    const cyclic: ArtifactSnapshot = {
      ...leaf,
      dependencies: [
        {
          artifactId: root.meta.id,
          revision: 1,
          lockDigest: artifactDigest(root),
          onChange: "validate",
        },
      ],
    };
    snapshots["art_profile_10_0@1"] = canonicalJson({
      canonicalization: CANONICALIZATION_VERSION,
      digest: artifactDigest(cyclic),
      artifact: cyclic,
    });
    await writeFile(file, JSON.stringify({ version: 1, snapshots, registry }));
    await expect(store.read(root.meta.id, 1)).rejects.toMatchObject({
      code: "CORRUPT",
      message: expect.stringContaining("Dependency cycle"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

test("rechecks unversioned authority when a completed dependency is revisited", async () => {
  const base = JSON.parse(
    await readFile(
      path.join(repository, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const bareLeaf: ArtifactSnapshot = {
    ...base,
    meta: { ...base.meta, id: "art_authority_leaf" },
    approval: {
      status: "approved",
      decisionId: "decision_1",
      actorId: "human_1",
      at: "2026-10-05T18:00:00Z",
    },
    lifecycle: { status: "approved", freshness: "valid" },
  };
  const leaf: ArtifactSnapshot = {
    ...bareLeaf,
    meta: { ...bareLeaf.meta, contentDigest: artifactDigest(bareLeaf) },
  };
  const make = (
    id: string,
    children: readonly ArtifactSnapshot[],
  ): ArtifactSnapshot => ({
    ...base,
    meta: { ...base.meta, id },
    dependencies: children.map((child) => ({
      artifactId: child.meta.id,
      revision: 1,
      lockDigest: artifactDigest(child),
      onChange: "validate",
    })),
  });
  const left = make("art_authority_left", [leaf]);
  const right = make("art_authority_right", [leaf]);
  const root = make("art_authority_root", [left, right]);
  const records = new Map(
    [leaf, left, right, root].map((artifact) => [
      `${artifact.meta.id}@1`,
      canonicalJson({
        canonicalization: CANONICALIZATION_VERSION,
        digest: artifactDigest(artifact),
        artifact,
      }),
    ]),
  );
  const storage: SnapshotStorage = {
    read: async (id, revision) => records.get(`${id}@${revision}`),
    revisions: async () => [1],
    writeIfAbsent: async () => false,
    withReadSession: async (read) => read(),
  };
  let checks = 0;
  const store = new ArtifactStore(
    storage,
    schemas,
    [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ],
    {
      verifyApproval: async () => ++checks === 1,
      verifyDecision: async () => false,
    },
  );
  await expect(store.read(root.meta.id, 1)).rejects.toMatchObject({
    code: "UNVERIFIED",
  });
  expect(checks).toBe(2);
});

test.each(["success", "failure"] as const)(
  "a deferred descendant starts a fresh verification after %s closes its session",
  async (outcome) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimic-session-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let descendant:
      | Promise<{ digest: string; freshnessStatus: string | undefined }>
      | undefined;
    try {
      const base = JSON.parse(
        await readFile(
          path.join(
            repository,
            "fixtures/artifacts/valid/product-definition.json",
          ),
          "utf8",
        ),
      ) as ArtifactSnapshot;
      const first: ArtifactSnapshot = {
        ...base,
        meta: { ...base.meta, id: "art_session_lifecycle" },
      };
      const second: ArtifactSnapshot = {
        ...first,
        meta: { ...first.meta, revision: 2, supersedesRevision: 1 },
        content: { ...(first.content as object), summary: "Published later" },
      };
      const record = (artifact: ArtifactSnapshot) =>
        canonicalJson({
          canonicalization: CANONICALIZATION_VERSION,
          digest: artifactDigest(artifact),
          artifact,
        });
      const workspace = new FileWorkspaceStorage(
        path.join(directory, "workspace.json"),
      );
      const schemas = await loadSchemaDirectory(
        path.join(repository, "schemas/artifacts"),
      );
      const store = new ArtifactStore(workspace.snapshots, schemas, [
        { level: "organization", ownerId: "org_9uile" },
        { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
      ]);
      expect(
        await workspace.snapshots.writeIfAbsent(
          first.meta.id,
          1,
          record(first),
        ),
      ).toBe(true);

      const outer = workspace.snapshots.withReadSession!(async () => {
        descendant = Promise.resolve().then(async () => {
          await gate;
          const snapshot = await store.read(first.meta.id, 2);
          const state = await workspace.readVerificationState();
          return {
            digest: snapshot.digest,
            freshnessStatus: state.freshness[first.meta.id]?.status,
          };
        });
        expect((await store.read(first.meta.id, 1)).digest).toBe(
          artifactDigest(first),
        );
        if (outcome === "failure") throw new Error("planned failure");
      });
      if (outcome === "failure")
        await expect(outer).rejects.toThrow("planned failure");
      else await outer;

      expect(
        await workspace.snapshots.writeIfAbsent(
          second.meta.id,
          2,
          record(second),
        ),
      ).toBe(true);
      await workspace.transact(async (registry) => {
        registry.freshness[first.meta.id] = {
          ref: {
            artifactId: second.meta.id,
            revision: 2,
            lockDigest: artifactDigest(second),
          },
          status: "stale",
          reason: "Updated after the first read",
        };
      });
      release();
      expect(await descendant!).toEqual({
        digest: artifactDigest(second),
        freshnessStatus: "stale",
      });
    } finally {
      release();
      if (descendant) await Promise.allSettled([descendant]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  { name: "wrong lock", error: "Dependency lock digest mismatch" },
  {
    name: "invalid consuming scope",
    error: "Dependency scope is not an ancestor",
  },
] as const)(
  "checks the second incoming edge to a completed node: $name",
  async ({ name, error }) => {
    const base = JSON.parse(
      await readFile(
        path.join(
          repository,
          "fixtures/artifacts/valid/product-definition.json",
        ),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const leaf: ArtifactSnapshot = {
      ...base,
      meta: { ...base.meta, id: "art_shared_leaf" },
    };
    const edge = (artifact: ArtifactSnapshot) => ({
      artifactId: artifact.meta.id,
      revision: 1,
      lockDigest: artifactDigest(artifact),
      onChange: "validate",
    });
    const left: ArtifactSnapshot = {
      ...base,
      meta: { ...base.meta, id: "art_first_consumer" },
      dependencies: [edge(leaf)],
    };
    const right: ArtifactSnapshot = {
      ...base,
      meta: { ...base.meta, id: "art_second_consumer" },
      scope:
        name === "invalid consuming scope"
          ? { level: "organization", ownerId: "org_9uile" }
          : base.scope,
      dependencies: [
        {
          ...edge(leaf),
          lockDigest:
            name === "wrong lock"
              ? `sha256:${"0".repeat(64)}`
              : artifactDigest(leaf),
        },
      ],
    };
    const root: ArtifactSnapshot = {
      ...base,
      meta: { ...base.meta, id: "art_two_consumers" },
      dependencies: [edge(left), edge(right)],
    };
    const records = new Map(
      [leaf, left, right, root].map((artifact) => [
        `${artifact.meta.id}@1`,
        canonicalJson({
          canonicalization: CANONICALIZATION_VERSION,
          digest: artifactDigest(artifact),
          artifact,
        }),
      ]),
    );
    const reads = new Map<string, number>();
    const storage: SnapshotStorage = {
      read: async (id, revision) => {
        const key = `${id}@${revision}`;
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return records.get(key);
      },
      revisions: async () => [1],
      writeIfAbsent: async () => false,
      withReadSession: async (read) => read(),
    };
    const schemas = await loadSchemaDirectory(
      path.join(repository, "schemas/artifacts"),
    );
    const store = new ArtifactStore(storage, schemas, [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ]);
    await expect(store.read(root.meta.id, 1)).rejects.toMatchObject({
      code: "CORRUPT",
      message: expect.stringContaining(error),
    });
    expect(reads.get("art_shared_leaf@1")).toBe(1);
  },
);
