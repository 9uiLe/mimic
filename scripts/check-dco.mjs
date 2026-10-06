import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(base ?? "")) {
  throw new Error(
    "Pass the pull request base commit SHA as a 40-character hex value",
  );
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const mergeBase = git("merge-base", base, "HEAD");
const commits = git("rev-list", "--reverse", `${mergeBase}..HEAD`)
  .split("\n")
  .filter(Boolean);

if (commits.length === 0) {
  throw new Error("No pull request commits found to check");
}

let invalid = false;
for (const commit of commits) {
  const [author, email, message] = execFileSync(
    "git",
    ["show", "-s", "--format=%an%x00%ae%x00%B", commit],
    { encoding: "utf8" },
  ).split("\0");
  const allSignoffs = message
    .split(/\r?\n/)
    .filter((line) => /^Signed-off-by:/i.test(line));
  const signoffs = execFileSync("git", ["interpret-trailers", "--parse"], {
    encoding: "utf8",
    input: message,
  })
    .split(/\r?\n/)
    .filter((line) => /^Signed-off-by:/i.test(line));
  const parsed = signoffs.map((line) =>
    /^Signed-off-by: ([^<>\s](?:.*[^<>\s])?) <([^<>\s]+@[^<>\s]+)>$/i.exec(
      line,
    ),
  );
  if (
    signoffs.length === 0 ||
    signoffs.length !== allSignoffs.length ||
    parsed.some((match) => match === null) ||
    !parsed.some((match) => match?.[1] === author && match?.[2] === email)
  ) {
    console.error(`${commit}: missing or invalid author Signed-off-by trailer`);
    invalid = true;
  }
}

if (invalid) process.exitCode = 1;
else console.log(`DCO sign-off verified for ${commits.length} PR commit(s)`);
