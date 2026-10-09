import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const documentation = (path) =>
  path === "README.md" ||
  path === "ci/README.md" ||
  /^docs\/(dogfood|onboarding)\/.+\.md$/.test(path);
const inPaths = (path, prefixes) =>
  prefixes.some((prefix) => path.startsWith(prefix));

export function selectCi(paths) {
  if (paths.length === 0) return { scope: "full", reason: "empty diff" };
  if (paths.every(documentation))
    return { scope: "docs", reason: "Markdown documentation only" };
  if (
    paths.every((path) =>
      inPaths(path, [
        "apps/demo-lab/src/",
        "apps/demo-lab/public/",
        "apps/demo-lab/tests/",
      ]),
    )
  )
    return { scope: "ui", reason: "Demo Lab only" };
  if (
    paths.every((path) => inPaths(path, ["apps/cli/src/", "apps/cli/tests/"]))
  )
    return { scope: "cli", reason: "CLI only" };
  if (paths.every((path) => path.startsWith("packages/core/src/")))
    return { scope: "core", reason: "Core only" };
  return { scope: "full", reason: "mixed, shared, or unknown paths" };
}

export function changedPaths(base, head) {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head))
    throw new Error("Invalid commit SHA");
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let result;
  try {
    result = selectCi(changedPaths(process.argv[2], process.argv[3]));
  } catch (error) {
    console.warn(`CI selection diff failed: ${error.message}`);
    result = { scope: "full", reason: "diff unavailable" };
  }
  const lines = [`scope=${result.scope}`, `reason=${result.reason}`];
  console.log(`CI selection: ${result.scope} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `CI selection: **${result.scope}** — ${result.reason}\n`,
    );
}
