import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { designInputs, startDesign } from "./9ui225-start-design.mjs";

const input = {
  model: "gpt-6.1-sol",
  systemContext:
    "利用者が候補を閲覧する既存のローカル画面がある。新しい公開機能は確認されていない。",
  brief: {
    audience: "保存済み Run を確認する利用者",
    purpose: "案を比べ、改善する案を選ぶ",
    primaryAction: "候補の差を見て作業用の案を選ぶ",
    requiredInformation: ["各案の主操作", "利点と失うもの", "未確定事項"],
    brandCharacter: "落ち着いた比較面。ブランド色は未確定",
    content: [
      { policy: "fixed-fact", text: "改訂は最大2回" },
      { policy: "fixed-copy", text: "候補を比較" },
      { policy: "confirm", text: "どの案がブランドに合うか" },
    ],
    references: [],
  },
};

test("a user brief starts one saved guided Run without generation or selection", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-225-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(folder, { recursive: true, force: true }),
    );
  });
  const workspace = path.join(folder, "design");
  const first = await startDesign(workspace, input);
  const second = await startDesign(workspace, input);
  assert.deepEqual(second, first);
  assert.equal(first.state, "run-saved");
  assert.equal(second.generation, "not-started-by-this-command");
  const config = JSON.parse(await readFile(first.config, "utf8"));
  const manifest = JSON.parse(
    await readFile(path.join(workspace, `trial-${first.runId}.json`), "utf8"),
  );
  const state = JSON.parse(
    await readFile(path.join(workspace, ".mimic/workspace.json"), "utf8"),
  );
  assert.equal(config.condition, "guided");
  assert.deepEqual(config.brief, input.brief);
  assert.equal(manifest.runId, first.runId);
  assert.ok(state.registry.runs[first.runId]);
  assert.equal(state.registry.runs[first.runId].selectedRef, undefined);
  assert.match(
    await readFile(path.join(workspace, "inputs/references.md"), "utf8"),
    /No references were supplied/,
  );
});

test("missing facts and system context fail before creating a workspace", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-225-invalid-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(folder, { recursive: true, force: true }),
    );
  });
  const workspace = path.join(folder, "design");
  await assert.rejects(
    startDesign(workspace, { ...input, systemContext: "" }),
    /system context/,
  );
  await assert.rejects(
    startDesign(workspace, {
      ...input,
      brief: { ...input.brief, content: [] },
    }),
    /No fixed fact or copy/,
  );
  await assert.rejects(readFile(workspace), { code: "ENOENT" });
});

test("an existing workspace or changed intake is not overwritten", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-225-existing-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(folder, { recursive: true, force: true }),
    );
  });
  const workspace = path.join(folder, "design");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "keep.txt"), "existing");
  await assert.rejects(startDesign(workspace, input), /ENOENT/);
  assert.equal(
    await readFile(path.join(workspace, "keep.txt"), "utf8"),
    "existing",
  );
  const other = path.join(folder, "new-design");
  await startDesign(other, input);
  await assert.rejects(
    startDesign(other, { ...input, systemContext: "different" }),
    /different input/,
  );
});

test("preparation can resume after a local interruption without changing inputs", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-225-resume-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(folder, { recursive: true, force: true }),
    );
  });
  const workspace = path.join(folder, "design");
  await assert.rejects(
    startDesign(workspace, input, {
      prepare: async () => {
        throw new Error("interrupted before plan");
      },
    }),
    /interrupted before plan/,
  );
  const resumed = await startDesign(workspace, input);
  assert.equal(resumed.state, "run-saved");
  assert.equal(
    JSON.parse(
      await readFile(path.join(workspace, "trial-config.json"), "utf8"),
    ).runId,
    resumed.runId,
  );
});

test("a self-consistent edited plan and manifest cannot replace the intake plan", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-225-plan-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(folder, { recursive: true, force: true }),
    );
  });
  const workspace = path.join(folder, "design");
  const { runId } = await startDesign(workspace, input);
  const planFile = path.join(workspace, `tasks-${runId}.json`);
  const manifestFile = path.join(workspace, `trial-${runId}.json`);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  plan[0].humanBrief += "\nUnapproved change";
  const editedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.planDigest = `sha256:${createHash("sha256").update(editedPlan).digest("hex")}`;
  await writeFile(planFile, editedPlan);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(startDesign(workspace, input), /differs from intake/);
});

test("design inputs preserve supplied references without adding any", () => {
  const files = designInputs(
    {
      ...input,
      brief: {
        ...input.brief,
        references: [
          {
            source: "example",
            reason: "comparison",
            appliesWhen: "options differ",
            doNotBorrow: "brand",
          },
        ],
      },
    },
    "/tmp/design",
  ).files;
  assert.match(files["inputs/references.md"], /Source: example/);
  assert.doesNotMatch(
    files["inputs/references.md"],
    /No references were supplied/,
  );
});
