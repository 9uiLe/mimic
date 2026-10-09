import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bin = path.join(repo, "apps/cli/dist/main.js");
const skillModule = pathToFileURL(
  path.join(repo, "apps/cli/dist/skill/index.js"),
).href;
const roots: string[] = [];
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mimic-skill-test-"));
  roots.push(dir);
  return dir;
}
function invoke(...args: string[]) {
  return spawnSync(process.execPath, [bin, "skill", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}
function fixtureInvoke(source: string, ...args: string[]) {
  const script = `import { runSkillCli } from ${JSON.stringify(skillModule)}; process.exitCode = await runSkillCli(process.argv.slice(2), { out: console.log, err: console.error }, process.argv[1]);`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, source, ...args],
    { encoding: "utf8" },
  );
}
function snapshot(root: string): string {
  function walk(dir: string): unknown {
    return readdirSync(dir)
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        const stat = lstatSync(file);
        return [
          name,
          stat.isDirectory()
            ? walk(file)
            : stat.isSymbolicLink()
              ? "symlink"
              : readFileSync(file, "utf8"),
        ];
      });
  }
  return JSON.stringify(walk(root));
}
beforeAll(() => {
  const built = spawnSync(
    path.join(repo, "node_modules/.bin/tsc"),
    ["-b", "apps/cli"],
    { cwd: repo, encoding: "utf8" },
  );
  expect(built.status, built.stderr || built.stdout).toBe(0);
});
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("built CLI exposes compact canonical sources and explicit bodies", () => {
  const ready = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  expect(JSON.parse(ready.stdout)).toEqual({ name: "mimic", state: "ready" });
  const bootstrap = invoke("--json");
  expect(bootstrap.status, bootstrap.stderr).toBe(0);
  const list = JSON.parse(bootstrap.stdout);
  expect(
    list.skills.some(
      (item: { id: string }) => item.id === "mimic.s01.product-definition",
    ),
  ).toBe(true);
  for (const [shortId, id, skill] of [
    [
      "s08",
      "mimic.s08.design-problem-profiler",
      "skills/s08-design-problem-profiler/SKILL.md",
    ],
    [
      "s09",
      "mimic.s09.design-space-explorer",
      "skills/s09-design-space-explorer/SKILL.md",
    ],
  ]) {
    expect(list.skills.some((item: { id: string }) => item.id === id)).toBe(
      true,
    );
    const result = invoke("show", shortId, "--json");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).skill).toBe(skill);
  }
  const shown = JSON.parse(invoke("show", "s01", "--json").stdout);
  expect(shown.skill).toBe("skills/s01-product-definition/SKILL.md");
  expect(shown).not.toHaveProperty("body");
  const full = JSON.parse(invoke("show", "s01", "--full", "--json").stdout);
  expect(full.body).toContain("## Reasoning procedure");
  expect(
    JSON.parse(
      invoke("show", "s01", "--section", "Reasoning procedure", "--json")
        .stdout,
    ).body,
  ).toMatch(/^## Reasoning procedure/);
  expect(
    JSON.parse(invoke("schema", "product-definition", "--json").stdout),
  ).not.toHaveProperty("body");
  expect(
    JSON.parse(
      invoke("schema", "product-definition", "--print", "--json").stdout,
    ).body,
  ).toContain("$schema");
  expect(
    JSON.parse(invoke("artifact", "product-definition", "--json").stdout)
      .producers,
  ).toContain("mimic.s01.product-definition");
  expect(
    JSON.parse(invoke("flow", "--mode", "system-first", "--json").stdout)
      .startingContext,
  ).toBe("existing system commitments");
  expect(
    JSON.parse(invoke("flow", "--mode", "experience-first", "--json").stdout)
      .convergence,
  ).toBe("product-ui-contract");
  expect(
    JSON.parse(invoke("flow", "--mode", "hybrid", "--json").stdout).mode,
  ).toBe("hybrid");
  expect(
    JSON.parse(invoke("topic", "technical-baseline", "--json").stdout).path,
  ).toBe("docs/specifications/technical-baseline.md");
  expect(JSON.parse(invoke("locate", "s01", "--json").stdout).kind).toBe(
    "skill",
  );
  expect(
    JSON.parse(invoke("recommend", "define product", "--json").stdout)
      .suggestions[0].id,
  ).toBe("mimic.s01.product-definition");
}, 20_000);

test("built CLI rejects unavailable, ambiguous, and unsafe requests", () => {
  for (const args of [
    ["show", "mimic.s"],
    ["show", "../s01"],
    ["schema", "../../secrets"],
    ["topic", "missing-topic"],
    ["current", "--run", "nonexistent", "--root", temp()],
  ]) {
    const result = invoke(...args);
    expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^MIMIC_3:/);
  }
  expect(invoke("current").status).toBe(2);
  expect(invoke("flow", "--mode", "invalid").status).toBe(3);
}, 20_000);

test("a fixture catalog rejects valid Skills that are not installed there", () => {
  const root = temp();
  mkdirSync(path.join(root, "skills"));
  cpSync(path.join(repo, "schemas"), path.join(root, "schemas"), {
    recursive: true,
  });
  cpSync(
    path.join(repo, "skills/s01-product-definition"),
    path.join(root, "skills/s01-product-definition"),
    { recursive: true },
  );
  const list = fixtureInvoke(root, "list", "--json");
  expect(list.status, list.stderr).toBe(0);
  expect(
    JSON.parse(list.stdout).skills.map((item: { id: string }) => item.id),
  ).toEqual(["mimic.s01.product-definition"]);
  for (const id of [
    "s08",
    "mimic.s08.design-problem-profiler",
    "s09",
    "mimic.s09.design-space-explorer",
  ]) {
    const result = fixtureInvoke(root, "show", id);
    expect(result.status, `${id}: ${result.stderr}`).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^MIMIC_3:/);
  }
});

test("built CLI reads current Run without changing any workspace bytes", () => {
  const root = temp();
  const empty = snapshot(root);
  for (const args of [
    [],
    ["list"],
    ["show", "s01"],
    ["flow"],
    ["topic", "technical-baseline"],
    ["artifact", "product-definition"],
    ["schema", "product-definition"],
    ["locate", "s01"],
    ["recommend", "product definition"],
  ])
    expect(invoke(...args, "--root", root).status, args.join(" ")).toBe(0);
  expect(snapshot(root)).toBe(empty);
  const init = spawnSync(process.execPath, [bin, "init", "--root", root], {
    encoding: "utf8",
  });
  expect(init.status, init.stderr).toBe(0);
  const tasks = [
    {
      id: "task_a",
      skillId: "mimic.s01.product-definition",
      outputType: "product-definition",
      scopeOwnerId: "org_local",
      intent: "create",
      authority: "AUTONOMOUS",
      humanBrief: "A product",
      inputs: { required: [], optional: [], alternatives: [] },
    },
  ];
  writeFileSync(path.join(root, "tasks.json"), JSON.stringify(tasks));
  const run = spawnSync(
    process.execPath,
    [
      bin,
      "run",
      "--root",
      root,
      "--tasks",
      "tasks.json",
      "--id",
      "run_bootstrap",
    ],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  const before = snapshot(root);
  const current = invoke(
    "current",
    "--run",
    "run_bootstrap",
    "--root",
    root,
    "--json",
  );
  expect(current.status, current.stderr).toBe(0);
  expect(JSON.parse(current.stdout)).toMatchObject({
    runId: "run_bootstrap",
    statePath: ".mimic/workspace.json",
  });
  expect(invoke("current", "--run", "constructor", "--root", root).status).toBe(
    3,
  );
  expect(snapshot(root)).toBe(before);
}, 20_000);

test("built source reader rejects symlinked Skill and schema ancestors", () => {
  const root = temp();
  cpSync(path.join(repo, "schemas"), path.join(root, "schemas"), {
    recursive: true,
  });
  symlinkSync(path.join(repo, "skills"), path.join(root, "skills"));
  for (const args of [["list"], ["show", "s01", "--full"]]) {
    const result = fixtureInvoke(root, ...args);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Source symlink is not allowed/);
  }
  unlinkSync(path.join(root, "skills"));
  mkdirSync(path.join(root, "skills"));
  cpSync(
    path.join(repo, "skills/s01-product-definition"),
    path.join(root, "skills/s01-product-definition"),
    { recursive: true },
  );
  rmSync(path.join(root, "schemas"), { recursive: true });
  symlinkSync(path.join(repo, "schemas"), path.join(root, "schemas"));
  const schemaAncestor = fixtureInvoke(root, "show", "s01", "--full");
  expect(schemaAncestor.status, schemaAncestor.stderr).toBe(3);
  expect(schemaAncestor.stdout).toBe("");
  expect(schemaAncestor.stderr).toMatch(/Source symlink is not allowed/);
});

test("built source reader fails closed for malformed packages, symlinks, and large sources", () => {
  const root = temp();
  mkdirSync(path.join(root, "skills"));
  cpSync(path.join(repo, "schemas"), path.join(root, "schemas"), {
    recursive: true,
  });
  cpSync(
    path.join(repo, "skills/s01-product-definition"),
    path.join(root, "skills/s01-product-definition"),
    { recursive: true },
  );
  const manifest = path.join(
    root,
    "skills/s01-product-definition/manifest.yaml",
  );
  const original = readFileSync(manifest, "utf8");
  writeFileSync(manifest, "invalid: [");
  expect(fixtureInvoke(root, "list").status).toBe(3);
  writeFileSync(manifest, original);
  const skillFile = path.join(root, "skills/s01-product-definition/SKILL.md");
  rmSync(skillFile);
  symlinkSync(
    path.join(repo, "skills/s01-product-definition/SKILL.md"),
    skillFile,
  );
  expect(fixtureInvoke(root, "list").status).toBe(3);
  rmSync(skillFile);
  writeFileSync(skillFile, `# Product Definition\n${"x".repeat(256_001)}`);
  const oversized = fixtureInvoke(root, "show", "s01", "--full");
  expect(oversized.status).toBe(3);
  expect(oversized.stdout).toBe("");
});
