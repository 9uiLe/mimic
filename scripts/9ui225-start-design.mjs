#!/usr/bin/env node
/** Start a new guided design Run from a person's brief without invoking a model. */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePlan, validateBrief } from "./9ui197-harness.mjs";

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const nonempty = (value) => typeof value === "string" && !!value.trim();
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function designInputs(input, workspace) {
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    "Invalid design input",
  );
  assert(nonempty(input.systemContext), "Missing user-supplied system context");
  assert(nonempty(input.model), "Missing selected model ID");
  assert(
    input.brief && typeof input.brief === "object",
    "Missing design brief",
  );
  validateBrief(input.brief);
  const generations = input.budget?.maxGenerations ?? 15;
  const timeoutMs = input.budget?.timeoutMs ?? 240000;
  assert(
    Number.isSafeInteger(generations) && generations > 0 && generations <= 20,
    "Invalid generation budget",
  );
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 900000,
    "Invalid timeout",
  );
  const normalized = {
    model: input.model.trim(),
    budget: { maxGenerations: generations, timeoutMs },
    systemContext: input.systemContext.trim(),
    brief: input.brief,
  };
  const runId = `run_design_${sha(JSON.stringify(normalized)).slice(7, 23)}`;
  const config = {
    workspace,
    runId,
    condition: "guided",
    model: normalized.model,
    budget: normalized.budget,
    revisionBudget: 2,
    referenceFile: "inputs/references.md",
    evidenceFiles: { s04: ["inputs/system.md"], s08: ["inputs/task.md"] },
    brief: normalized.brief,
  };
  const { brief } = normalized;
  const content = brief.content
    .map(({ policy, text }) => `- ${policy}: ${text}`)
    .join("\n");
  const references = brief.references.length
    ? brief.references
        .map(
          ({ source, reason, appliesWhen, doNotBorrow }) =>
            `- Source: ${source}\n  Reason: ${reason}\n  Applies when: ${appliesWhen}\n  Do not borrow: ${doNotBorrow}`,
        )
        .join("\n")
    : "No references were supplied. Do not infer or invent a source.";
  return {
    normalized,
    runId,
    files: {
      "intake-source.json": json(normalized),
      "trial-config.json": json(config),
      "inputs/system.md": `# System context included in the intake\n\n${normalized.systemContext}\n\nUnknown capabilities remain unverified.\n`,
      "inputs/task.md": `# Design request included in the intake\n\nAudience: ${brief.audience}\nPurpose: ${brief.purpose}\nPrimary action: ${brief.primaryAction}\nRequired information:\n${brief.requiredInformation.map((item) => `- ${item}`).join("\n")}\nBrand character: ${brief.brandCharacter}\n${(brief.brandColors ?? []).map((item) => `Brand color ${item.value}: ${item.source}`).join("\n")}\nContent policy:\n${content}\n\nDo not claim that an unresolved question was answered.\n`,
      "inputs/references.md": `# References supplied by the user\n\n${references}\n`,
    },
  };
}

async function treeHash(folder) {
  const entries = [];
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      assert(!entry.isSymbolicLink(), "Package tree contains a symlink");
      if (entry.isDirectory()) await visit(file);
      else {
        assert(entry.isFile(), "Package tree contains a non-file");
        entries.push([path.relative(folder, file), sha(await readFile(file))]);
      }
    }
  }
  await visit(folder);
  return sha(
    JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

async function verifyPrepared(workspace, files) {
  assert((await realpath(workspace)) === workspace, "Workspace path changed");
  for (const [name, expected] of Object.entries(files)) {
    const file = path.join(workspace, name);
    const info = await lstat(file);
    assert(
      info.isFile() && (await realpath(file)) === file,
      `Prepared file changed: ${name}`,
    );
    assert(
      (await readFile(file, "utf8")) === expected,
      `Prepared file differs: ${name}`,
    );
  }
  for (const name of ["skills", "schemas"])
    assert(
      (await treeHash(path.join(workspace, name))) ===
        (await treeHash(path.join(repo, name))),
      `Prepared ${name} changed`,
    );
}

async function writeSame(file, expected) {
  try {
    await writeFile(file, expected, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(file);
    assert(
      info.isFile() && (await realpath(file)) === file,
      `Prepared file changed: ${file}`,
    );
    assert(
      (await readFile(file)).equals(
        Buffer.isBuffer(expected) ? expected : Buffer.from(expected),
      ),
      `Prepared file differs: ${file}`,
    );
  }
}

async function ensureDirectory(folder) {
  try {
    await mkdir(folder);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(folder);
  assert(
    info.isDirectory() && (await realpath(folder)) === folder,
    `Directory changed: ${folder}`,
  );
}

async function copyPackage(source, destination) {
  await ensureDirectory(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    assert(!entry.isSymbolicLink(), "Package tree contains a symlink");
    if (entry.isDirectory()) await copyPackage(from, to);
    else {
      assert(entry.isFile(), "Package tree contains a non-file");
      await writeSame(to, await readFile(from));
    }
  }
}

async function cli(args) {
  const binary = path.join(repo, "apps/cli/dist/main.js");
  const { stdout } = await execFile(
    process.execPath,
    [binary, ...args, "--json"],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function readPreparedPlan(workspace, config) {
  const { runId } = config;
  const planFile = path.join(workspace, `tasks-${runId}.json`);
  const manifestFile = path.join(workspace, `trial-${runId}.json`);
  for (const file of [planFile, manifestFile]) {
    const info = await lstat(file);
    assert(
      info.isFile() && (await realpath(file)) === file,
      "Prepared Run file changed",
    );
  }
  const templateFile = path.join(
    repo,
    "docs/dogfood/9ui183/plan-template.json",
  );
  const templateText = await readFile(templateFile, "utf8");
  const expectedPlan = json(makePlan(JSON.parse(templateText), config));
  const evidenceDigests = {};
  for (const name of Object.values(config.evidenceFiles).flat())
    evidenceDigests[name] = sha(await readFile(path.join(workspace, name)));
  const expectedManifest = json({
    ...config,
    referenceDigest: sha(
      await readFile(path.join(workspace, config.referenceFile)),
    ),
    evidenceDigests,
    templateDigest: sha(templateText),
    skillTreeDigest: await treeHash(path.join(workspace, "skills")),
    schemaTreeDigest: await treeHash(path.join(workspace, "schemas")),
    revisionBudget: config.revisionBudget ?? 2,
    planDigest: sha(expectedPlan),
  });
  const plan = await readFile(planFile, "utf8");
  const manifest = await readFile(manifestFile, "utf8");
  assert(
    plan === expectedPlan && manifest === expectedManifest,
    "Prepared Run differs from intake and source evidence",
  );
}

export async function startDesign(workspacePath, input, operations = {}) {
  const parent = await realpath(path.dirname(path.resolve(workspacePath)));
  const workspace = path.join(
    parent,
    path.basename(path.resolve(workspacePath)),
  );
  assert(
    workspace !== parent && ![".", ".."].includes(path.basename(workspace)),
    "Invalid workspace path",
  );
  const { runId, files } = designInputs(input, workspace);
  let created = false;
  try {
    await mkdir(workspace);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!created) {
    const marker = path.join(workspace, "intake-source.json");
    const info = await lstat(marker);
    assert(
      info.isFile() && (await realpath(marker)) === marker,
      "Existing workspace is not an intake workspace",
    );
    assert(
      (await readFile(marker, "utf8")) === files["intake-source.json"],
      "Existing workspace has different input",
    );
  }
  await writeSame(
    path.join(workspace, "intake-source.json"),
    files["intake-source.json"],
  );
  for (const name of ["skills", "schemas"])
    await copyPackage(path.join(repo, name), path.join(workspace, name));
  await ensureDirectory(path.join(workspace, "inputs"));
  for (const [name, contents] of Object.entries(files))
    if (name !== "intake-source.json")
      await writeSame(path.join(workspace, name), contents);
  await verifyPrepared(workspace, files);
  await (operations.cli ?? cli)(["init", "--root", workspace]);
  let runPlanExists = false;
  try {
    await lstat(path.join(workspace, ".mimic/runs", `${runId}.json`));
    runPlanExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!runPlanExists)
    await (
      operations.prepare ??
      (() =>
        execFile(
          process.execPath,
          [
            path.join(repo, "scripts/9ui197-harness.mjs"),
            "prepare",
            path.join(workspace, "trial-config.json"),
          ],
          { maxBuffer: 1024 * 1024 },
        ))
    )();
  await readPreparedPlan(workspace, JSON.parse(files["trial-config.json"]));
  const started = await (operations.cli ?? cli)([
    "run",
    "--root",
    workspace,
    "--id",
    runId,
    "--tasks",
    `tasks-${runId}.json`,
  ]);
  assert(
    started.runId === runId || started.id === runId,
    "Run start did not confirm its ID",
  );
  return {
    workspace,
    runId,
    state: "run-saved",
    generation: "not-started-by-this-command",
    config: path.join(workspace, "trial-config.json"),
    next: "If generation is pending, use a new, valid official subscription authorization to execute this Run; then use the existing review, exact selection and prepare-next flow.",
  };
}

async function interactiveInput() {
  assert(
    process.stdin.isTTY && process.stdout.isTTY,
    "Interactive input requires a terminal; provide an input JSON file otherwise",
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = async (label) => (await prompt.question(`${label}: `)).trim();
  try {
    const model = await ask("選択する公式サブスクリプションのモデルID");
    const systemContext = await ask(
      "対象システムについて確認済みの情報（不明な能力は書かない）",
    );
    const audience = await ask("利用者");
    const purpose = await ask("目的");
    const primaryAction = await ask("主要操作");
    const requiredInformation = (await ask("必須情報（; 区切り）"))
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean);
    const brandCharacter = await ask("ブランドの特徴（未確定ならその旨）");
    const fixedFact = await ask("変更不可の事実または数値（少なくとも1つ）");
    const fixedCopy = await ask("変更不可の文言（なければ空欄）");
    const confirm = await ask("人に確認が必要な重要事項（なければ空欄）");
    return {
      model,
      systemContext,
      brief: {
        audience,
        purpose,
        primaryAction,
        requiredInformation,
        brandCharacter,
        content: [
          { policy: "fixed-fact", text: fixedFact },
          ...(fixedCopy ? [{ policy: "fixed-copy", text: fixedCopy }] : []),
          ...(confirm ? [{ policy: "confirm", text: confirm }] : []),
        ],
        references: [],
      },
    };
  } finally {
    prompt.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , workspacePath, inputFile] = process.argv;
  if (!workspacePath || process.argv.length > 4) {
    console.error(
      "Usage: node scripts/9ui225-start-design.mjs <new-workspace> [intake.json]",
    );
    process.exitCode = 2;
  } else {
    try {
      const input = inputFile
        ? JSON.parse(await readFile(inputFile, "utf8"))
        : await interactiveInput();
      console.log(json(await startDesign(workspacePath, input)));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
