import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const roots: string[] = [];
const task = {
  id: "task_a",
  skillId: "skill.a",
  outputType: "design-system-asset",
  scopeOwnerId: "org_local",
  inputs: { required: [], optional: [], alternatives: [] },
  intent: "create",
  authority: "AUTONOMOUS",
};
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mimic-cli-process-"));
  roots.push(dir);
  return dir;
}
function invoke(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    input: "untrusted stdin; never interpreted",
  });
}
beforeAll(() => {
  for (const target of ["@mimic/core", "@mimic/cli"]) {
    const built = spawnSync("pnpm", ["--filter", target, "build"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(built.status, `${target}: ${built.stdout}\n${built.stderr}`).toBe(0);
  }
});
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("built executable uses compact stdout and file-backed detail across processes", () => {
  const dir = root();
  const ready = invoke();
  expect(ready.status).toBe(0);
  expect(JSON.parse(ready.stdout)).toEqual({ name: "mimic", state: "ready" });
  const init = invoke("init", "--root", dir, "--json");
  expect(init.status).toBe(0);
  expect(init.stderr).toBe("");
  const shellText = "$(touch should-not-exist)";
  writeFileSync(
    path.join(dir, "tasks.json"),
    JSON.stringify([
      {
        ...task,
        humanBrief: shellText,
        inputs: {
          required: [{ kind: "human-brief", name: "brief" }],
          optional: [],
          alternatives: [],
        },
      },
    ]),
  );
  const run = invoke(
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_process",
    "--json",
  );
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toBe("");
  const summary = JSON.parse(run.stdout);
  expect(summary).toMatchObject({
    runId: "run_process",
    state: "active",
    actions: [{ taskId: "task_a", action: "GENERATE" }],
  });
  expect(summary).not.toHaveProperty("invocation");
  const detail = JSON.parse(readFileSync(path.join(dir, summary.path), "utf8"));
  expect(detail.actions[0].invocation.humanBrief).toBe(shellText);
  expect(existsSync(path.join(dir, "should-not-exist"))).toBe(false);
  expect(
    JSON.parse(invoke("status", "--root", dir, "--json").stdout).runs,
  ).toEqual([{ id: "run_process", state: "active" }]);
  expect(
    JSON.parse(invoke("next", "run_process", "--root", dir, "--json").stdout)
      .actions[0].action,
  ).toBe("GENERATE");
});

test("built executable rejects malformed plans before state, permits correction, and reports errors on stderr", () => {
  const dir = root();
  expect(invoke("init", "--root", dir).status).toBe(0);
  writeFileSync(
    path.join(dir, "tasks.json"),
    JSON.stringify([{ ...task, skillId: "Bad Skill" }]),
  );
  const args = [
    "run",
    "--root",
    dir,
    "--tasks",
    "tasks.json",
    "--id",
    "run_retry",
    "--json",
  ];
  const invalid = invoke(...args);
  expect(invalid.status).toBe(3);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toMatch(/^MIMIC_3:/);
  expect(existsSync(path.join(dir, ".mimic/runs/run_retry.json"))).toBe(false);
  expect(existsSync(path.join(dir, ".mimic/workspace.json"))).toBe(false);
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([task]));
  expect(invoke(...args).status).toBe(0);
  expect(invoke(...args).status).toBe(0);
  const unsupported = invoke("preview", "--root", dir, "--json");
  expect(unsupported.status).toBe(4);
  expect(unsupported.stdout).toBe("");
  expect(unsupported.stderr).toMatch(/^MIMIC_4:/);
  const invalidSchema = invoke(
    "validate",
    "--root",
    dir,
    "--file",
    "tasks.json",
    "--json",
  );
  expect(invalidSchema.status).toBe(3);
  expect(JSON.parse(invalidSchema.stdout).path).toMatch(/^\.mimic\/outputs\//);
  expect(invalidSchema.stderr).toMatch(/^MIMIC_3:/);
  writeFileSync(path.join(dir, ".mimic/workspace.json"), "{bad");
  const corrupt = invoke("status", "--root", dir, "--json");
  expect(corrupt.status).toBe(6);
  expect(corrupt.stdout).toBe("");
  expect(corrupt.stderr).toMatch(/^MIMIC_6:/);
});
