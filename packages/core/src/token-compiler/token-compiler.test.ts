import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest, type JsonValue } from "../artifact-canonical.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
} from "../artifact-store.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { compileApprovedTokenAssets } from "./index.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-tokens-"));
  roots.push(root);
  const schema = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const store = new ArtifactStore(
    new FileSnapshotStorage(root),
    schema,
    [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
    ],
    {
      async verifyApproval(approval) {
        return (
          approval.status === "approved" &&
          approval.decisionId === "decision_verified" &&
          approval.actorId === "human_1"
        );
      },
      async verifyDecision() {
        return false;
      },
    },
  );
  const template = JSON.parse(
    await readFile(
      path.join(
        repository,
        "fixtures/artifacts/valid/design-system-asset.json",
      ),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  async function add(
    id: string,
    tokens: unknown,
    options: {
      approved?: boolean;
      references?: string[];
      modes?: string[];
    } = {},
  ) {
    const approved = options.approved ?? true;
    const bare: ArtifactSnapshot = {
      ...template,
      meta: { ...template.meta, id },
      lifecycle: {
        status: approved ? "approved" : "proposed",
        freshness: "valid",
      },
      approval: approved
        ? {
            status: "approved",
            decisionId: "decision_verified",
            actorId: "human_1",
            at: "2026-10-06T12:00:00Z",
          }
        : { status: "pending" },
      provenance: template.provenance,
      content: {
        summary: "Approved tokens",
        assetKind: "dtcg-tokens",
        name: id,
        definition: {
          tokens: tokens as JsonValue,
          ...(options.references ? { references: options.references } : {}),
          ...(options.modes ? { modes: options.modes } : {}),
        },
        usageRules: ["Use for this product"],
        antiUsageRules: ["Do not infer direction"],
      },
    };
    const artifact = approved
      ? { ...bare, meta: { ...bare.meta, contentDigest: artifactDigest(bare) } }
      : bare;
    const result = await store.create(artifact);
    return {
      artifact,
      ref: { artifactId: id, revision: 1, lockDigest: result.digest },
    };
  }
  return { store, add };
}

const foundation = {
  primitive: {
    color: {
      navy: {
        $type: "color",
        $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3] },
      },
    },
    space: { base: { $type: "dimension", $value: { value: 1, unit: "rem" } } },
  },
  semantic: { color: { text: { $value: "{primitive.color.navy}" } } },
  component: {
    button: { foreground: { $type: "color", $value: "{semantic.color.text}" } },
  },
};

test("compiles exact approved layers with stable names and live CSS aliases", async () => {
  const { store, add } = await setup();
  const { ref } = await add("art_tokens", foundation, {
    references: ["primitive.color.navy"],
    modes: ["light"],
  });
  const first = await compileApprovedTokenAssets(store, [ref]);
  const second = await compileApprovedTokenAssets(store, [ref]);
  expect(second).toEqual(first);
  expect(first.css).toBe(
    `:root {\n  --mimic-component-button-foreground: var(--mimic-semantic-color-text);\n  --mimic-primitive-color-navy: color(srgb 0.1 0.2 0.3);\n  --mimic-primitive-space-base: 1rem;\n  --mimic-semantic-color-text: var(--mimic-primitive-color-navy);\n}\n`,
  );
  expect(
    first.tokens.find((token) => token.path === "component.button.foreground")
      ?.reference,
  ).toBe("semantic.color.text");
});

test("preserves approved prior paths and stable names when an approved revision adds a token", async () => {
  const { store, add } = await setup();
  const old = await add("art_old", {
    primitive: {
      space: { base: { $type: "dimension", $value: { value: 8, unit: "px" } } },
    },
  });
  const next = await add("art_next", {
    semantic: {
      space: { gap: { $type: "dimension", $value: "{primitive.space.base}" } },
    },
  });
  const result = await compileApprovedTokenAssets(store, [next.ref], old.ref);
  expect(result.css).toContain("--mimic-primitive-space-base: 8px;");
  expect(result.css).toContain(
    "--mimic-semantic-space-gap: var(--mimic-primitive-space-base);",
  );
});

test("orders output by path and replaces only explicitly repeated prior paths", async () => {
  const { store, add } = await setup();
  const old = await add("art_old", {
    primitive: {
      space: { base: { $type: "dimension", $value: { value: 8, unit: "px" } } },
    },
    semantic: { amount: { $type: "number", $value: 1 } },
  });
  const next = await add("art_next", {
    semantic: { amount: { $type: "number", $value: 2 } },
  });
  const output = await compileApprovedTokenAssets(store, [next.ref], old.ref);
  expect(output.css).toBe(
    ":root {\n  --mimic-primitive-space-base: 8px;\n  --mimic-semantic-amount: 2;\n}\n",
  );
  expect(output.tokens.map((token) => token.source.artifactId)).toEqual([
    "art_old",
    "art_next",
  ]);
  const reordered = await add("art_reordered", {
    semantic: { amount: { $type: "number", $value: 2 } },
    primitive: {
      space: { base: { $type: "dimension", $value: { value: 8, unit: "px" } } },
    },
  });
  expect((await compileApprovedTokenAssets(store, [reordered.ref])).css).toBe(
    output.css,
  );
});

test("rejects unresolved, cyclic, forward and mismatched aliases", async () => {
  const cases = [
    [
      {
        semantic: {
          color: {
            text: { $type: "color", $value: "{primitive.color.missing}" },
          },
        },
      },
      /Unresolved/,
    ],
    [
      {
        primitive: {
          a: { $type: "number", $value: "{primitive.b}" },
          b: { $type: "number", $value: "{primitive.a}" },
        },
      },
      /Cyclic/,
    ],
    [
      {
        primitive: { a: { $value: "{semantic.b}" } },
        semantic: { b: { $type: "number", $value: 1 } },
      },
      /Forward layer/,
    ],
    [
      {
        primitive: { a: { $type: "number", $value: 1 } },
        semantic: { b: { $type: "color", $value: "{primitive.a}" } },
      },
      /type mismatch/,
    ],
  ] as const;
  for (const [tokens, message] of cases) {
    const { store, add } = await setup();
    const { ref } = await add("art_bad", tokens);
    await expect(compileApprovedTokenAssets(store, [ref])).rejects.toThrow(
      message,
    );
  }
});

test("rejects name collisions, unsafe names, unsupported values and modes", async () => {
  const cases = [
    [
      {
        primitive: {
          "foo-bar": { baz: { $type: "number", $value: 1 } },
          foo: { "bar-baz": { $type: "number", $value: 2 } },
        },
      },
      /collision/,
    ],
    [
      { primitive: { "x;}body{color:red": { $type: "number", $value: 1 } } },
      /name segment/,
    ],
    [
      { primitive: { size: { $type: "dimension", $value: "1rem" } } },
      /Unsupported reference or legacy value|must be an object/,
    ],
    [
      {
        primitive: {
          color: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [2, 0, 0] },
          },
        },
      },
      /out of range/,
    ],
    [
      { primitive: { shadow: { $type: "shadow", $value: {} } } },
      /[Uu]nsupported type/,
    ],
    [
      { primitive: { amount: { $type: "number", $value: "1; color: red" } } },
      /finite safe number/,
    ],
    [
      {
        primitive: {
          amount: { $type: "number", $ref: "#/primitive/base/$value" },
        },
      },
      /unsupported property/,
    ],
  ] as const;
  for (const [tokens, message] of cases) {
    const { store, add } = await setup();
    const { ref } = await add("art_bad", tokens);
    await expect(compileApprovedTokenAssets(store, [ref])).rejects.toThrow(
      message,
    );
  }
  const { store, add } = await setup();
  const { ref } = await add("art_modes", foundation, {
    modes: ["light", "dark"],
  });
  await expect(compileApprovedTokenAssets(store, [ref])).rejects.toThrow(
    /Only the light mode/,
  );
});

test("requires the real store's verified approval and exact digest", async () => {
  const { store, add } = await setup();
  const pending = await add("art_pending", foundation, { approved: false });
  await expect(
    compileApprovedTokenAssets(store, [pending.ref]),
  ).rejects.toThrow(/not fresh and approved/);
  const approved = await add("art_approved", foundation);
  await expect(
    compileApprovedTokenAssets(store, [
      { ...approved.ref, lockDigest: `sha256:${"0".repeat(64)}` },
    ]),
  ).rejects.toThrow(/lock mismatch/);
});

test("snapshots caller-owned exact refs before awaited reads and isolates returned provenance", async () => {
  const { store, add } = await setup();
  const prior = await add("art_prior", {
    primitive: { base: { $type: "number", $value: 3 } },
  });
  const current = await add("art_current", {
    semantic: { amount: { $type: "number", $value: "{primitive.base}" } },
  });
  const priorRef = { ...prior.ref };
  const currentRef = { ...current.ref };
  let releaseRead!: () => void;
  let signalEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const realRead = store.read.bind(store);
  let firstRead = true;
  store.read = async (id, revision) => {
    if (firstRead) {
      firstRead = false;
      signalEntered();
      await gate;
    }
    return realRead(id, revision);
  };
  const pending = compileApprovedTokenAssets(store, [currentRef], priorRef);
  await entered;
  Object.assign(priorRef, {
    artifactId: "art_other",
    revision: 7,
    lockDigest: `sha256:${"0".repeat(64)}`,
  });
  Object.assign(currentRef, {
    artifactId: "art_other",
    revision: 7,
    lockDigest: `sha256:${"0".repeat(64)}`,
  });
  releaseRead();
  const result = await pending;
  expect(result.css).toContain("--mimic-primitive-base: 3;");
  expect(result.css).toContain(
    "--mimic-semantic-amount: var(--mimic-primitive-base);",
  );
  expect(result.sources).toEqual([prior.ref, current.ref]);
  expect(result.tokens.map((token) => token.source.artifactId)).toEqual([
    "art_prior",
    "art_current",
  ]);
  currentRef.lockDigest = `sha256:${"f".repeat(64)}`;
  priorRef.lockDigest = `sha256:${"f".repeat(64)}`;
  expect(result.sources).toEqual([prior.ref, current.ref]);
  expect(result.tokens.map((token) => token.source.lockDigest)).toEqual([
    prior.ref.lockDigest,
    current.ref.lockDigest,
  ]);
  expect(Object.isFrozen(result.sources)).toBe(true);
  expect(result.sources.every(Object.isFrozen)).toBe(true);
});
