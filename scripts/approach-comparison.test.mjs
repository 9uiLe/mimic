import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { preflightPlan } from "../apps/cli/dist/plan.js";
import { prepare, report } from "./approach-comparison.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repo, "docs/dogfood/9ui183/plan-template.json");

test("matched comparison freezes one common upstream and three isolated branches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-approach-test-"));
  await mkdir(path.join(root, ".mimic"));
  await mkdir(path.join(root, "inputs"));
  await writeFile(path.join(root, ".mimic/config.json"), "{}\n");
  await writeFile(
    path.join(root, ".mimic/workspace.json"),
    JSON.stringify({
      registry: { events: [], runs: {} },
      snapshots: {},
    }),
  );
  await writeFile(
    path.join(root, "inputs/page.html"),
    "<main>Fixed snapshot</main>\n",
  );
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {
    recursive: true,
  });
  const cfg = {
    workspace: root,
    cohortId: "test_compare",
    planTemplate: template,
    model: "gpt-6-luna",
    reasoningEffort: "low",
    brief: "Compare three structures.",
    pageEvidenceFiles: ["inputs/page.html"],
    traitIds: ["trait:smarthr-table"],
    assessments: [
      {
        caseId: "case:smarthr-table",
        role: "near",
        structuralFit: "high",
        contextDistance: "low",
        rationale: "A fixed attribute table may support a choice.",
        evidenceRefs: ["obs:smarthr-table", "hyp:smarthr-table"],
      },
    ],
  };
  const manifest = await prepare(cfg);
  const plan = JSON.parse(
    await readFile(path.join(root, manifest.planPath), "utf8"),
  );
  assert.equal(plan.length, 15);
  assert.equal(
    preflightPlan(
      plan,
      [{ level: "organization", ownerId: "org_local" }],
      "org_local",
    ).length,
    15,
  );
  const task = (id) => plan.find((entry) => entry.id === id);
  for (const arm of ["b0", "c1", "c2"]) {
    assert.ok(task(`s09_${arm}`).dependsOn.includes("s08"));
    assert.ok(
      task(`s10_${arm}`).inputs.required.some(
        (need) => need.refsFromTask === `s09_${arm}`,
      ),
    );
    assert.ok(
      task(`s11_${arm}`).inputs.required.some(
        (need) => need.refsFromTask === `s10_${arm}`,
      ),
    );
  }
  assert.deepEqual(task("s11_c2").evidenceFiles, [
    "inputs/page.html",
    "inputs/test_compare-c2-s11.md",
  ]);
  assert.equal(manifest.retrieval.status, "ready");
  const c1 = await readFile(
    path.join(root, manifest.arms.C1.evidencePath),
    "utf8",
  );
  assert.match(c1, /case:smarthr-table/);
  assert.match(c1, /https:\/\/smarthr\.design/);
  const b0 = await readFile(
    path.join(root, manifest.arms.B0.evidencePath),
    "utf8",
  );
  assert.match(b0, /Purpose and information amount/);
  assert.doesNotMatch(b0, /Host graph retrieval/);
  await report(cfg);
  await writeFile(path.join(root, manifest.arms.B0.evidencePath), "changed\n");
  await assert.rejects(report(cfg), /Changed frozen file/);
});
