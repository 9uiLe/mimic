import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const checker = resolve("scripts/check-dco.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, text, message) {
  writeFileSync(resolve(cwd, "file.txt"), text);
  git(cwd, "add", "file.txt");
  git(cwd, "commit", "-m", message);
}

function fixture(run) {
  const cwd = mkdtempSync(resolve(tmpdir(), "mimic-dco-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Test Author");
    git(cwd, "config", "user.email", "test@example.com");
    commit(cwd, "base", "Unsigned base commit");
    run(cwd, git(cwd, "rev-parse", "HEAD"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function check(cwd, base) {
  return spawnSync(process.execPath, [checker, base], {
    cwd,
    encoding: "utf8",
  });
}

test("accepts every signed PR commit while excluding the unsigned base", () => {
  fixture((cwd, base) => {
    commit(
      cwd,
      "one",
      "First\n\nSigned-off-by: Test Author <test@example.com>",
    );
    commit(
      cwd,
      "two",
      "Second\n\nSigned-off-by: Test Author <test@example.com>",
    );
    const result = check(cwd, base);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 PR commit/);
  });
});

test("rejects a missing sign-off on an earlier commit in a multi-commit PR", () => {
  fixture((cwd, base) => {
    commit(cwd, "one", "Missing sign-off");
    commit(
      cwd,
      "two",
      "Second\n\nSigned-off-by: Test Author <test@example.com>",
    );
    assert.equal(check(cwd, base).status, 1);
  });
});

test("rejects malformed and other-author sign-offs", () => {
  for (const trailer of [
    "Signed-off-by: Test Author test@example.com",
    "Signed-off-by: Another Author <another@example.com>",
  ]) {
    fixture((cwd, base) => {
      commit(cwd, "one", `Invalid\n\n${trailer}`);
      assert.equal(check(cwd, base).status, 1);
    });
  }
});

test("checks the PR commits when the base branch advances independently", () => {
  fixture((cwd, originalBase) => {
    git(cwd, "checkout", "-q", "-b", "base");
    commit(cwd, "base update", "Unsigned update to base branch");
    const advancedBase = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-q", "-b", "feature", originalBase);
    commit(
      cwd,
      "feature",
      "Feature\n\nSigned-off-by: Test Author <test@example.com>",
    );
    const result = check(cwd, advancedBase);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 PR commit/);
  });
});
