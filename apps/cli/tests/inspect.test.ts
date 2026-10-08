import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
} from "@mimic/core";
import { runCli } from "../src/cli.js";
import { inspectRun, pointerExists } from "../src/inspect.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
const scopes = [{ level: "organization" as const, ownerId: "org_local" }];
const at = "2026-10-08T17:00:00Z";
const actor = { kind: "agent" as const, id: "inspector-test" };
const runId = "run_inspect";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function call(root: string, args: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await runCli([...args, "--root", root, "--json"], {
    out: (v) => out.push(v),
    err: (v) => err.push(v),
  });
  return { code, value: out.length ? JSON.parse(out.at(-1)!) : undefined, err };
}
async function files(
  root: string,
  relative = "",
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(root, name));
    else if (entry.isFile())
      result[name] = await readFile(path.join(root, name), "base64");
  }
  return result;
}
const ref = (a: ArtifactSnapshot) => ({
  artifactId: a.meta.id,
  revision: a.meta.revision,
  lockDigest: artifactDigest(a),
});
async function setup(sourceProposed = false, onChange = "revise") {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-inspect-"));
  roots.push(root);
  expect((await call(root, ["init"])).code).toBe(0);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, ".mimic/workspace.json")),
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    scopes,
    { verify: async () => false, allowCommit: async () => false },
  );
  const template = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/system-capability.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const source: ArtifactSnapshot = {
    ...template,
    meta: { ...template.meta, id: "art_inspect_source" },
    scope: scopes[0],
    lifecycle: {
      status: sourceProposed ? "proposed" : "provisional",
      freshness: "valid",
    },
    origin: { actorKind: "agent", actorId: actor.id, runId, createdAt: at },
    provenance: [
      {
        path: "/content/summary",
        kind: "fact",
        evidenceRefs: ["evidence.json#/value", "missing.json"],
      },
    ],
  };
  const productTemplate = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/product-definition.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const candidate: ArtifactSnapshot = {
    ...productTemplate,
    meta: { ...productTemplate.meta, id: "art_inspect_product" },
    scope: scopes[0],
    origin: source.origin,
    lifecycle: { status: "proposed", freshness: "valid" },
    dependencies: [{ ...ref(source), onChange }],
    provenance: [
      {
        path: "/content/summary",
        kind: "derived",
        inputRefs: [
          "art_inspect_source@1#/content/summary",
          "art_inspect_source@1#/content/missing",
        ],
      },
    ],
  };
  await writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify({ value: "synthetic evidence" }),
  );
  await runtime.registry.start({
    id: runId,
    scope: "org_local",
    entryMode: "system-first",
    base: [],
    reused: [],
    safeActions: ["more-work"],
    actor,
    at,
    reason: "Inspect fixture",
  });
  for (const artifact of [source, candidate]) {
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId,
      ref: ref(artifact),
      inputs: artifact.dependencies.map(
        ({ artifactId, revision, lockDigest }) => ({
          artifactId,
          revision,
          lockDigest,
        }),
      ),
      actor,
      at,
      reason: "Fixture output",
    });
  }
  await runtime.registry.submit({
    runId,
    packetId: "packet_inspect",
    proposals: [
      {
        id: "proposal_inspect",
        ref: ref(candidate),
        alternatives: ["Keep provisional"],
        rationale: "Review required",
        evidenceLimits: ["No live behavior evidence"],
        dependents: [],
      },
    ],
    actor,
    at,
    reason: "Review candidate",
  });
  return { root, runtime, source, candidate };
}

test("CLI inspect separates review readiness from exact dependency commit guards and preserves every file", async () => {
  const { root, source } = await setup();
  const before = await files(root);
  const inspected = await call(root, ["inspect", runId]);
  expect(inspected.code, inspected.err.join("\n")).toBe(0);
  const run = inspected.value.runs[0];
  expect(run.state).toBe("review-ready");
  expect(run.candidates[0]).toMatchObject({
    reviewReady: true,
    commitReadiness: "blocked",
    dependencies: [
      { ref: ref(source), status: "provisional", sourceProposals: [] },
    ],
  });
  expect(run.candidates[0].inputRefs[0]).toMatchObject(ref(source));
  expect(run.candidates[0].commitBlockers.join(" ")).toContain(
    "fresh approved exact revision",
  );
  expect(run.nextSteps.join(" ")).toContain("Safe generation");
  const findings = run.provenance.flatMap(
    (a: { findings: unknown[] }) => a.findings,
  );
  expect(findings).toHaveLength(2);
  expect(findings[0]).toMatchObject({
    verification: "verifier-not-connected",
    meaning: "not-checked",
    referenceResolution: "unresolved",
    status: "UNVERIFIED",
  });
  expect(
    findings[0].references.map((r: { resolved: boolean }) => r.resolved),
  ).toEqual([true, false]);
  expect(
    findings[1].references.map((r: { resolved: boolean }) => r.resolved),
  ).toEqual([true, false]);
  expect(await files(root)).toEqual(before);
  expect((await call(root, ["inspect"])).value.runs).toHaveLength(1);
  expect((await call(root, ["inspect", "unknown"])).code).toBe(3);
});

test("resolved references stay UNVERIFIED and backend stops are diagnostics without effects", async () => {
  const { root, runtime, source, candidate } = await setup();
  const before = await files(root);
  const result = await inspectRun(runtime, runId, {
    resolveEvidence: async () => true,
    backendStops: [
      {
        reason: "quota",
        backend: "official-cli",
        message: "Subscription allowance exhausted",
      },
    ],
    revisionRecords: [
      {
        taskId: "request",
        path: ".mimic/submissions/bound.json",
        inputRefs: [ref(source)],
        requests: [
          {
            state: "pending-source-approval",
            request: {
              runId,
              source: ref(source),
              request: ref(candidate),
              affectedLocks: [ref(source)],
              evidenceRefs: [],
              reason: "Supply missing evidence",
            },
          },
        ],
      },
    ],
  });
  const fact = result.provenance[0].findings[0];
  expect(fact).toMatchObject({
    referenceResolution: "resolved",
    status: "UNVERIFIED",
    meaning: "not-checked",
  });
  expect(result.revisionRequests[0].source.sourceProposals).toEqual([]);
  expect(result.revisionRequests[0].nextSteps.join(" ")).toMatch(
    /new exact revision.*unchanged submit retry/,
  );
  expect(result.revisionRequests[0].nextSteps.join(" ")).toContain(
    "before approval",
  );
  expect(result.backendStops[0].reason).toBe("quota");
  expect(result.nextSteps.join(" ")).toContain("do not fall back");
  expect(await files(root)).toEqual(before);
});

test("authority read rejects a forged approved snapshot rather than granting commit readiness", async () => {
  const { root, source } = await setup();
  const file = path.join(root, ".mimic/workspace.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  const key = Object.keys(data.snapshots).find((k) =>
    k.includes(source.meta.id),
  )!;
  const record = JSON.parse(data.snapshots[key]);
  const snapshot = record.artifact;
  snapshot.lifecycle.status = "approved";
  snapshot.approval = {
    status: "approved",
    decisionId: "forged",
    actorId: "invented-human",
    at,
  };
  snapshot.meta.contentDigest = artifactDigest(snapshot);
  record.digest = artifactDigest(snapshot);
  data.snapshots[key] = JSON.stringify(record);
  await writeFile(file, JSON.stringify(data));
  const before = await files(root);
  const inspected = await call(root, ["inspect", runId]);
  expect(inspected.code, inspected.err.join("\n")).toBe(0);
  expect(inspected.value.runs[0].candidates[0]).toMatchObject({
    reviewReady: false,
    commitReadiness: "blocked",
  });
  expect(inspected.value.runs[0].provenance[0].status).toBe(
    "artifact-unavailable-or-unverified",
  );
  expect(await files(root)).toEqual(before);
});

test("evidence traversal/symlink escapes and invalid JSON pointers cannot resolve", async () => {
  const { root } = await setup();
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "mimic-inspect-outside-"),
  );
  roots.push(outside);
  await writeFile(path.join(outside, "evidence.json"), "{}");
  await symlink(
    path.join(outside, "evidence.json"),
    path.join(root, "missing.json"),
  );
  const inspected = await call(root, ["inspect", runId]);
  expect(inspected.code).toBe(0);
  expect(
    inspected.value.runs[0].provenance[0].findings[0].references[1].resolved,
  ).toBe(false);
  expect(pointerExists({ "a/b": [1] }, "/a~1b/0")).toBe(true);
  for (const pointer of ["/a~2b", "/a~1b/01", "/a~1b/-1", "bad"])
    expect(pointerExists({ "a/b": [1] }, pointer)).toBe(false);
});

test("joins dependency onChange objects to exact source proposals and freshness assessments", async () => {
  const { root, runtime, source } = await setup(true);
  await runtime.registry.submit({
    runId,
    packetId: "packet_source",
    proposals: [
      {
        id: "proposal_source",
        ref: ref(source),
        alternatives: ["Keep provisional"],
        rationale: "Source review",
        evidenceLimits: [],
        dependents: [],
      },
    ],
    actor,
    at,
    reason: "Review source",
  });
  await new FileWorkspaceStorage(
    path.join(root, ".mimic/workspace.json"),
  ).transact(async (state) => {
    state.freshness[source.meta.id] = {
      ref: ref(source),
      status: "blocked",
      reason: "Unresolved change",
    };
  });
  const before = await files(root);
  const inspected = await call(root, ["inspect", runId]);
  expect(inspected.code, inspected.err.join("\n")).toBe(0);
  const dep = inspected.value.runs[0].candidates.find(
    (c: { proposalId: string }) => c.proposalId === "proposal_inspect",
  ).dependencies[0];
  expect(dep.registryFreshness).toBe("blocked");
  expect(dep.sourceProposals).toEqual([
    {
      runId,
      proposalId: "proposal_source",
      packetId: "packet_source",
      status: "pending",
      readiness: "ready",
    },
  ]);
  expect(await files(root)).toEqual(before);
});

test.each(["revise", "invalidate", "validate", "none"])(
  "reports changed canonical dependency policy %s without claiming commit authority",
  async (onChange) => {
    const { root, source } = await setup(false, onChange);
    const canonical = {
      ...ref(source),
      revision: 2,
      lockDigest: `sha256:${"a".repeat(64)}`,
    };
    await new FileWorkspaceStorage(
      path.join(root, ".mimic/workspace.json"),
    ).transact(async (state) => {
      state.canonical[source.meta.id] = { ref: canonical };
    });
    const result = await call(root, ["inspect", runId]);
    expect(result.code, result.err.join("\n")).toBe(0);
    const dep = result.value.runs[0].candidates[0].dependencies[0];
    expect(dep).toMatchObject({
      canonicalChanged: true,
      canonical,
      onChange,
      ref: ref(source),
    });
    if (onChange === "validate")
      expect(dep.commitBlocker).toContain(
        "verified impact evidence is required for onChange validate",
      );
    else if (onChange === "none")
      expect(dep.commitBlocker).not.toContain("Canonical dependency changed");
    else
      expect(dep.commitBlocker).toContain(
        "explicitly rebind and revise or invalidate",
      );
  },
);
