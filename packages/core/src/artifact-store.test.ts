import { afterEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { artifactDigest, canonicalJson } from "./artifact-canonical.js";
import { parseArtifactYaml, serializeArtifactYaml } from "./artifact-codec.js";
import { loadSchemaDirectory, SchemaRegistry } from "./schema-registry.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
  type AuthorityVerifier,
  type SnapshotStorage,
} from "./artifact-store.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const schemaDirectory = path.join(repository, "schemas/artifacts");
const validDirectory = path.join(repository, "fixtures/artifacts/valid");
const invalidDirectory = path.join(repository, "fixtures/artifacts/invalid");
const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<ArtifactSnapshot> {
  return JSON.parse(
    await readFile(
      path.join(validDirectory, "product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
}

async function setup(authority?: AuthorityVerifier) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-artifacts-"));
  tempRoots.push(root);
  const schemas = await loadSchemaDirectory(schemaDirectory);
  const scopes = [
    { level: "organization" as const, ownerId: "org_9uile" },
    {
      level: "product" as const,
      ownerId: "product_mimic",
      parentId: "org_9uile",
    },
    {
      level: "domain" as const,
      ownerId: "domain_a",
      parentId: "product_mimic",
    },
    { level: "local" as const, ownerId: "local_a", parentId: "domain_a" },
    {
      level: "domain" as const,
      ownerId: "domain_b",
      parentId: "product_mimic",
    },
  ];
  return {
    root,
    scopes,
    schemas,
    store: new ArtifactStore(
      new FileSnapshotStorage(root),
      schemas,
      scopes,
      authority,
    ),
  };
}

function revision(base: ArtifactSnapshot, number: number): ArtifactSnapshot {
  return {
    ...base,
    meta: { ...base.meta, revision: number, supersedesRevision: number - 1 },
    content: { ...(base.content as object), summary: `Revision ${number}` },
  };
}

const authorized: AuthorityVerifier = {
  async verifyApproval(approval) {
    return (
      approval.actorId === "human_1" && approval.decisionId === "decision_1"
    );
  },
  async verifyDecision(decisionId) {
    return decisionId === "decision_1";
  },
};

describe("schema registry and YAML codec", () => {
  test("compiles the full local graph and checks every current fixture", async () => {
    const registry = await loadSchemaDirectory(schemaDirectory);
    expect(registry.identities).toHaveLength(18);
    for (const file of (await readdir(validDirectory)).filter((name) =>
      name.endsWith(".json"),
    )) {
      expect(
        registry.validate(
          JSON.parse(await readFile(path.join(validDirectory, file), "utf8")),
        ).valid,
        file,
      ).toBe(true);
    }
    for (const file of (await readdir(invalidDirectory)).filter((name) =>
      name.endsWith(".json"),
    )) {
      expect(
        registry.validate(
          JSON.parse(await readFile(path.join(invalidDirectory, file), "utf8")),
        ).valid,
        file,
      ).toBe(false);
    }
    const unsupported = await fixture();
    expect(
      registry.validate({
        ...unsupported,
        meta: { ...unsupported.meta, schemaVersion: "2.0.0" },
      }).diagnostics[0]?.keyword,
    ).toBe("schemaVersion");
    expect(
      registry.validate(parseArtifactYaml("meta: { schemaVersion: {} }"))
        .diagnostics[0],
    ).toMatchObject({
      keyword: "schemaVersion",
      params: { actualType: "object" },
    });
  });

  test("rejects duplicate and unresolved schema identities", () => {
    const entry = {
      $id: "urn:mimic:artifact:v1",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "urn:mimic:artifact:v1:missing",
    };
    expect(
      () => new SchemaRegistry([{ location: "entry", schema: entry }]),
    ).toThrow(/Unresolved/);
    expect(
      () =>
        new SchemaRegistry([
          { location: "one", schema: entry },
          { location: "two", schema: entry },
        ]),
    ).toThrow(/Duplicate/);
  });

  test("round trips deterministic YAML and refuses unsafe YAML forms", () => {
    const artifact = { z: ["é", 1, true], a: { escaped: "a\nb", number: -0 } };
    const yaml = serializeArtifactYaml(artifact);
    expect(yaml).toBe(serializeArtifactYaml({ a: artifact.a, z: artifact.z }));
    expect(parseArtifactYaml(yaml)).toEqual({
      a: { escaped: "a\nb", number: 0 },
      z: ["é", 1, true],
    });
    for (const source of [
      "a: 1\na: 2",
      "? [a, b]\n: 1",
      "1: a",
      "a: .nan",
      "a: .inf",
      "a: !!binary YQ==",
      "a: !!set { b: null }",
      "!!set { a: null }",
      "a: !unknown value",
      "a: !unknown [1]",
      "a: &a [1]\nb: *a",
      "a: [1]\n---\nb: 2",
      "- a",
    ]) {
      expect(() => parseArtifactYaml(source), source).toThrow();
    }
    expect(parseArtifactYaml("a: !!str 123")).toEqual({ a: "123" });
    expect(
      parseArtifactYaml("a: !!map { b: !!int 2 }\nc: !!seq [true]"),
    ).toEqual({ a: { b: 2 }, c: [true] });
  });

  test("tag and version policy covers default, explicit 1.2 and explicit 1.1", () => {
    const versions = [
      { name: "default", prefix: "", supported: true },
      { name: "explicit 1.2", prefix: "%YAML 1.2\n---\n", supported: true },
      { name: "explicit 1.1", prefix: "%YAML 1.1\n---\n", supported: false },
    ];
    const nonJsonTags = [
      "a: !!set { b: null }", // Nested mapping tag.
      "!!set { a: null }", // Root mapping tag.
      "a: !!omap [{ b: 1 }]", // Nested collection sequence tag.
      "a: !!timestamp 2026-10-06", // Scalar tag outside the JSON core.
      "a: !custom [1]", // Unresolved sequence tag.
    ];
    for (const version of versions) {
      for (const source of nonJsonTags) {
        expect(
          () => parseArtifactYaml(version.prefix + source),
          `${version.name}: ${source}`,
        ).toThrow();
      }
      const core =
        "a: !!str 123\nb: !!map { count: !!int 2, ok: !!bool true, ratio: !!float 1.5 }\nc: !!seq [!!null null]";
      if (version.supported)
        expect(parseArtifactYaml(version.prefix + core)).toEqual({
          a: "123",
          b: { count: 2, ok: true, ratio: 1.5 },
          c: [null],
        });
      else
        expect(() => parseArtifactYaml(version.prefix + core)).toThrow(
          /version 1\.2/,
        );
    }
  });
});

describe("canonical digest", () => {
  test("covers entire parsed snapshot except self digest with stable key order", async () => {
    const artifact = await fixture();
    const digest = artifactDigest(artifact);
    const reordered = parseArtifactYaml(serializeArtifactYaml(artifact));
    expect(artifactDigest(reordered)).toBe(digest);
    expect(
      artifactDigest({
        ...artifact,
        meta: { ...artifact.meta, contentDigest: digest },
      }),
    ).toBe(digest);
    expect(
      artifactDigest({
        ...artifact,
        content: { ...(artifact.content as object), goals: ["changed"] },
      }),
    ).not.toBe(digest);
    expect(
      artifactDigest({
        ...artifact,
        content: { ...(artifact.content as object), goals: ["a", "b"] },
      }),
    ).not.toBe(
      artifactDigest({
        ...artifact,
        content: { ...(artifact.content as object), goals: ["b", "a"] },
      }),
    );
    expect(canonicalJson({ n: -0, exponent: 1e-7, u: "é", e: "\n" })).toBe(
      '{"e":"\\n","exponent":1e-7,"n":0,"u":"é"}',
    );
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => canonicalJson({ s: "\ud800" })).toThrow();
    expect(artifactDigest({ meta: {}, content: { text: "é" } })).not.toBe(
      artifactDigest({ meta: {}, content: { text: "e\u0301" } }),
    );
    expect(
      artifactDigest(parseArtifactYaml("meta: {}\ncontent:\n  text: plain\n")),
    ).toBe(
      artifactDigest(
        parseArtifactYaml('content: { text: "plain" }\nmeta: {}\n'),
      ),
    );
  });
});

describe("filesystem artifact store", () => {
  test("persists exact revisions, survives restart and relocation, and isolates returned objects", async () => {
    const { root, scopes, schemas, store } = await setup();
    const first = await fixture();
    await store.create(first);
    const second = revision(first, 2);
    await store.create(second);
    expect(
      (await store.history(first.meta.id)).map(
        (item) => item.artifact.meta.revision,
      ),
    ).toEqual([1, 2]);
    const read = await store.read(first.meta.id, 1);
    (read.artifact.content as Record<string, unknown>).summary = "mutation";
    expect((await store.read(first.meta.id, 1)).artifact.content).toEqual(
      first.content,
    );
    const moved = `${root}-moved`;
    await rename(root, moved);
    tempRoots.splice(tempRoots.indexOf(root), 1, moved);
    const restarted = new ArtifactStore(
      new FileSnapshotStorage(moved),
      schemas,
      scopes,
    );
    expect((await restarted.read(first.meta.id, 2)).artifact).toEqual(second);
    await expect(restarted.read(first.meta.id, 3)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  test("rejects revision gaps, conflicting retries, mismatched digest, and tampering", async () => {
    const { root, store } = await setup();
    const first = await fixture();
    expect((await store.create(first)).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await store.create(first)).artifact).toEqual(first);
    await expect(store.create(revision(first, 3))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      store.create({
        ...revision(first, 2),
        meta: { ...revision(first, 2).meta, supersedesRevision: 9 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.create({
        ...first,
        content: { ...(first.content as object), summary: "conflict" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.create({
        ...revision(first, 2),
        meta: {
          ...revision(first, 2).meta,
          contentDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    const file = path.join(root, first.meta.id, "1.json");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("Illustrative", "Corrupted"),
    );
    await expect(store.read(first.meta.id, 1)).rejects.toMatchObject({
      code: "CORRUPT",
    });
  });

  test("resolves exact locks, registered ancestry, and pointers without adopting newer revisions", async () => {
    const { store } = await setup();
    const first = await fixture();
    const locked = await store.create(first);
    const downstream = {
      ...first,
      meta: { ...first.meta, id: "art_downstream" },
      dependencies: [
        {
          artifactId: first.meta.id,
          revision: 1,
          lockDigest: locked.digest,
          onChange: "validate",
        },
      ],
    };
    await store.create(downstream);
    await store.create(revision(first, 2));
    expect(
      (await store.read("art_downstream", 1)).artifact.dependencies[0]
        ?.revision,
    ).toBe(1);
    await expect(
      store.create({
        ...downstream,
        meta: { ...downstream.meta, id: "art_bad_lock" },
        dependencies: [
          {
            ...downstream.dependencies[0]!,
            lockDigest: `sha256:${"0".repeat(64)}`,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      store.create({
        ...downstream,
        meta: { ...downstream.meta, id: "art_bad_pointer" },
        provenance: [
          { path: "/content/missing", kind: "unknown", rationale: "unknown" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      store.create({
        ...downstream,
        meta: { ...downstream.meta, id: "art_bad_scope" },
        scope: { level: "organization", ownerId: "org_9uile" },
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("rejects forged approvals and preserves authorized approved snapshots", async () => {
    const { root, scopes, schemas, store } = await setup();
    const first = await fixture();
    const approved = {
      ...first,
      lifecycle: { status: "approved" as const, freshness: "valid" },
      approval: {
        status: "approved" as const,
        decisionId: "decision_1",
        actorId: "human_1",
        at: "2026-10-05T18:00:00Z",
      },
    };
    const signed = {
      ...approved,
      meta: { ...approved.meta, contentDigest: artifactDigest(approved) },
    };
    await expect(store.create(signed)).rejects.toMatchObject({
      code: "UNVERIFIED",
    });
    const trusted = new ArtifactStore(
      new FileSnapshotStorage(root),
      schemas,
      scopes,
      authorized,
    );
    await trusted.create(signed);
    expect(
      (await trusted.read(first.meta.id, 1)).artifact.lifecycle.status,
    ).toBe("approved");
    await expect(
      trusted.create({
        ...signed,
        content: { ...(signed.content as object), summary: "overwrite" },
        meta: {
          ...signed.meta,
          contentDigest: artifactDigest({
            ...signed,
            content: { ...(signed.content as object), summary: "overwrite" },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.read(first.meta.id, 1)).rejects.toMatchObject({
      code: "UNVERIFIED",
    });
    const forged = revision(signed, 2);
    await expect(
      trusted.create({
        ...forged,
        approval: { ...forged.approval, actorId: "forged" },
        meta: {
          ...forged.meta,
          contentDigest: artifactDigest({
            ...forged,
            approval: { ...forged.approval, actorId: "forged" },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test("verifier callbacks cannot mutate the admitted or returned snapshot", async () => {
    const mutate: AuthorityVerifier = {
      async verifyApproval(approval, artifact) {
        (approval as { actorId?: string }).actorId = "changed";
        (artifact.content as Record<string, unknown>).summary =
          "changed by approval";
        return true;
      },
      async verifyDecision(_decisionId, artifact) {
        (artifact.content as Record<string, unknown>).summary =
          "changed by decision";
        return true;
      },
    };
    const { store } = await setup(mutate);
    const first = await fixture();
    const approved = {
      ...first,
      lifecycle: { status: "approved" as const, freshness: "valid" },
      approval: {
        status: "approved" as const,
        decisionId: "decision_1",
        actorId: "human_1",
        at: "2026-10-05T18:00:00Z",
      },
      provenance: [
        { path: "/content", kind: "human-decision", decisionId: "decision_1" },
      ],
    };
    const signed = {
      ...approved,
      meta: { ...approved.meta, contentDigest: artifactDigest(approved) },
    };
    const saved = await store.create(signed);
    expect(saved.artifact.content).toEqual(first.content);
    expect(artifactDigest(saved.artifact)).toBe(saved.digest);
    const read = await store.read(first.meta.id, 1);
    expect(read.artifact.content).toEqual(first.content);
    expect(artifactDigest(read.artifact)).toBe(read.digest);
  });

  test("verifier rejection and outage on read remain UNVERIFIED", async () => {
    const { root, schemas, scopes, store } = await setup(authorized);
    const first = await fixture();
    const approved = {
      ...first,
      lifecycle: { status: "approved" as const, freshness: "valid" },
      approval: {
        status: "approved" as const,
        decisionId: "decision_1",
        actorId: "human_1",
        at: "2026-10-05T18:00:00Z",
      },
    };
    await store.create({
      ...approved,
      meta: { ...approved.meta, contentDigest: artifactDigest(approved) },
    });
    const outage: AuthorityVerifier = {
      async verifyApproval() {
        throw new Error("offline");
      },
      async verifyDecision() {
        throw new Error("offline");
      },
    };
    await expect(
      new ArtifactStore(
        new FileSnapshotStorage(root),
        schemas,
        scopes,
        outage,
      ).read(first.meta.id, 1),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
    const decision = {
      ...first,
      meta: { ...first.meta, id: "art_decision_reference" },
      provenance: [
        { path: "/content", kind: "human-decision", decisionId: "decision_1" },
      ],
    };
    await store.create(decision);
    await expect(
      new ArtifactStore(
        new FileSnapshotStorage(root),
        schemas,
        scopes,
        outage,
      ).read("art_decision_reference", 1),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });

  test("atomic publication gives one winner for concurrent conflicting writers", async () => {
    const { store } = await setup();
    const first = await fixture();
    const other = {
      ...first,
      content: { ...(first.content as object), summary: "other" },
    };
    const outcomes = await Promise.allSettled([
      store.create(first),
      store.create(other),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    expect(await store.history(first.meta.id)).toHaveLength(1);
  });

  test("identical concurrent creates remain idempotent when publication wins before history lookup", async () => {
    const { root, scopes, schemas } = await setup();
    const base = new FileSnapshotStorage(root);
    let publicationDone!: () => void;
    const published = new Promise<void>((resolve) => {
      publicationDone = resolve;
    });
    let initialReads = 0;
    let historyCalls = 0;
    const interleaved: SnapshotStorage = {
      async read(id, revision) {
        if (++initialReads <= 2) return undefined;
        return base.read(id, revision);
      },
      async revisions(id) {
        if (++historyCalls === 2) await published;
        return base.revisions(id);
      },
      async writeIfAbsent(id, revision, record) {
        const result = await base.writeIfAbsent(id, revision, record);
        publicationDone();
        return result;
      },
    };
    const store = new ArtifactStore(interleaved, schemas, scopes);
    const first = await fixture();
    const results = await Promise.all([
      store.create(first),
      store.create(first),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await store.history(first.meta.id)).toHaveLength(1);
  });

  test("an interrupted temporary write is invisible to readers and future publication", async () => {
    const { root, store } = await setup();
    const first = await fixture();
    const storage = new FileSnapshotStorage(root);
    await storage.revisions(first.meta.id);
    await mkdir(path.join(root, first.meta.id));
    await writeFile(
      path.join(root, first.meta.id, ".interrupted.pending"),
      "{incomplete",
    );
    expect(await store.history(first.meta.id)).toEqual([]);
    await store.create(first);
    expect(await store.history(first.meta.id)).toHaveLength(1);
  });
});
