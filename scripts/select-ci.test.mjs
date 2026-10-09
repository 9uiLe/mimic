import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedPaths, selectCi } from "./select-ci.mjs";

test("selects only safe, explainable scopes", () => {
  const examples = [
    [["README.md", "docs/dogfood/report.md", "ci/README.md"], "docs"],
    [["docs/development/skill-package.md"], "full"],
    [["docs/specifications/technical-baseline.md"], "full"],
    [["apps/demo-lab/src/main.js"], "ui"],
    [["apps/cli/src/monitor.ts"], "cli"],
    [["packages/core/src/index.ts"], "core"],
    [["apps/demo-lab/src/main.js", "packages/core/src/index.ts"], "full"],
    [["docs/dogfood/preview.html"], "full"],
    [["pnpm-lock.yaml"], "full"],
    [["apps/demo-lab/package.json"], "full"],
    [["apps/cli/tsconfig.json"], "full"],
    [["packages/core/package.json"], "full"],
    [[".github/workflows/pre-release.yml"], "full"],
    [["scripts/select-ci.mjs"], "full"],
    [["apps/cli/src/main.ts", "docs/README.md"], "full"],
    [[], "full"],
  ];
  for (const [paths, expected] of examples)
    assert.equal(selectCi(paths).scope, expected, paths.join(", "));
});

test("unavailable diff cannot choose a reduced scope", () => {
  assert.throws(() => changedPaths("missing", "missing"), /Invalid commit SHA/);
  const output = join(
    mkdtempSync(join(tmpdir(), "mimic-ci-select-")),
    "output",
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/select-ci.mjs", "missing", "missing"],
    { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
  );
  assert.equal(result.status, 0);
  assert.match(
    readFileSync(output, "utf8"),
    /scope=full\nreason=diff unavailable\n/,
  );
  const missingCommits = spawnSync(
    process.execPath,
    ["scripts/select-ci.mjs", "0".repeat(40), "1".repeat(40)],
    { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
  );
  assert.equal(missingCommits.status, 0);
  assert.match(
    readFileSync(output, "utf8"),
    /scope=full\nreason=diff unavailable\n$/,
  );
});
