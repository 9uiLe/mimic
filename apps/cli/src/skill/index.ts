import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveRunState,
  FileWorkspaceStorage,
  loadSkillPackage,
  type SkillManifest,
} from "@mimic/core";

type IO = { out(value: string): void; err(value: string): void };
type Skill = {
  id: string;
  slug: string;
  manifest: SkillManifest;
  instructions: string;
  manifestPath: string;
  skillPath: string;
};
const MAX_BODY = 256_000;
const MODES = ["system-first", "experience-first", "hybrid"] as const;
class SkillError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function validId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id))
    throw new SkillError(3, "Invalid identifier");
  return id;
}
function parse(args: readonly string[]) {
  const command = args[0]?.startsWith("--") ? "" : (args[0] ?? "");
  const rest = command ? args.slice(1) : args;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const valued = new Set(["root", "section", "mode", "run"]);
  const flags = new Set(["json", "full", "print"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (options[name] !== undefined)
      throw new SkillError(2, `Duplicate option ${arg}`);
    if (flags.has(name)) options[name] = true;
    else if (valued.has(name)) {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new SkillError(2, `Missing value for ${arg}`);
      options[name] = value;
    } else throw new SkillError(2, `Unknown option ${arg}`);
  }
  const required: Record<string, [number, number]> = {
    "": [0, 0],
    list: [0, 0],
    show: [1, 1],
    flow: [0, 0],
    topic: [1, 1],
    artifact: [1, 1],
    schema: [1, 1],
    locate: [1, 1],
    current: [0, 0],
    recommend: [1, Infinity],
  };
  const count = required[command];
  if (!count || positionals.length < count[0] || positionals.length > count[1])
    throw new SkillError(
      2,
      "Usage: mimic skill [list|show <id>|flow|topic <topic>|artifact <type>|schema <type>|locate <id>|current --run <id>|recommend <intent>] [options]",
    );
  const allowed: Record<string, string[]> = {
    "": ["root", "json"],
    list: ["root", "json"],
    show: ["root", "json", "full", "section"],
    flow: ["root", "json", "mode", "full"],
    topic: ["root", "json", "full", "section"],
    artifact: ["root", "json"],
    schema: ["root", "json", "print"],
    locate: ["root", "json"],
    current: ["root", "json", "run"],
    recommend: ["root", "json"],
  };
  for (const name of Object.keys(options))
    if (!allowed[command]!.includes(name))
      throw new SkillError(
        2,
        `--${name} is not valid for skill ${command || "(default)"}`,
      );
  if (command === "current" && !options.run)
    throw new SkillError(2, "current requires --run <id>");
  if (options.full && options.section)
    throw new SkillError(2, "Use --full or --section");
  if (options.mode && !MODES.includes(options.mode as (typeof MODES)[number]))
    throw new SkillError(3, "Invalid entry mode");
  return { command, options, positionals };
}
function relative(repo: string, file: string) {
  return path.relative(repo, file).split(path.sep).join("/");
}
async function safeSource(
  repo: string,
  file: string,
  kind: "file" | "directory",
): Promise<string> {
  const resolved = path.resolve(repo, file);
  const rel = path.relative(repo, resolved);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  )
    throw new SkillError(3, "Source path escapes repository");
  let cursor = repo;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new SkillError(3, "Source symlink is not allowed");
  }
  const stat = await lstat(resolved);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    throw new SkillError(3, `Source is not a ${kind}`);
  return resolved;
}
async function safeFile(repo: string, file: string): Promise<string> {
  return safeSource(repo, file, "file");
}
async function safeDirectory(repo: string, file: string): Promise<string> {
  return safeSource(repo, file, "directory");
}
async function readBounded(repo: string, file: string): Promise<string> {
  const target = await safeFile(repo, file);
  if ((await lstat(target)).size > MAX_BODY)
    throw new SkillError(3, "Source exceeds output limit");
  return readFile(target, "utf8");
}
function section(body: string, name: string): string {
  const lines = body.split("\n");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const start = lines.findIndex(
    (line) =>
      /^#{1,6} /.test(line) &&
      line
        .replace(/^#+ /, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") === slug,
  );
  if (start < 0) throw new SkillError(3, `Unknown section: ${name}`);
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = start + 1;
  while (end < lines.length) {
    const heading = lines[end]!.match(/^(#+) /);
    if (heading && heading[1]!.length <= level) break;
    end++;
  }
  return lines.slice(start, end).join("\n").trim();
}
async function catalog(repo: string): Promise<Skill[]> {
  const skillsRoot = await safeDirectory(repo, "skills");
  const schemasRoot = await safeDirectory(repo, "schemas");
  await safeFile(repo, "schemas/skills/skill-package.schema.json");
  await safeFile(repo, "schemas/artifacts/common.schema.json");
  await schemas(repo);
  const entries = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills: Skill[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const dir = await safeDirectory(repo, path.join("skills", entry.name));
    const names = await readdir(dir);
    if (!names.includes("manifest.yaml") && !names.includes("manifest.json"))
      continue;
    let pack;
    try {
      pack = await loadSkillPackage(dir, schemasRoot);
    } catch (error) {
      throw new SkillError(
        3,
        `Malformed Skill package ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (ids.has(pack.manifest.skillId))
      throw new SkillError(3, `Duplicate Skill ID: ${pack.manifest.skillId}`);
    ids.add(pack.manifest.skillId);
    skills.push({
      id: pack.manifest.skillId,
      slug: entry.name,
      manifest: pack.manifest,
      instructions: pack.instructions,
      manifestPath: relative(
        repo,
        path.join(
          dir,
          names.includes("manifest.yaml") ? "manifest.yaml" : "manifest.json",
        ),
      ),
      skillPath: relative(repo, path.join(dir, pack.manifest.skillFile)),
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}
function resolveSkill(skills: readonly Skill[], input: string): Skill {
  const id = validId(input).toLowerCase();
  const exact = skills.filter((skill) =>
    [skill.id, skill.slug].some((value) => value.toLowerCase() === id),
  );
  const matches = exact.length
    ? exact
    : skills.filter(
        (skill) =>
          skill.id.toLowerCase().startsWith(id) ||
          skill.slug.toLowerCase().startsWith(id) ||
          skill.slug.split("-")[0]?.toLowerCase() === id,
      );
  if (!matches.length) throw new SkillError(3, `Skill not installed: ${input}`);
  if (matches.length > 1)
    throw new SkillError(
      3,
      `Ambiguous Skill ID ${input}: ${matches.map((item) => item.id).join(", ")}`,
    );
  return matches[0]!;
}
async function schemas(repo: string) {
  const directory = await safeDirectory(repo, "schemas/artifacts/types");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  for (const file of files)
    await safeFile(repo, path.join("schemas/artifacts/types", file));
  return files.map((name) => name.slice(0, -".schema.json".length));
}
async function documents(repo: string) {
  const files: string[] = [];
  for (const folder of ["docs/specifications", "docs/development"])
    for (const name of await readdir(await safeDirectory(repo, folder)))
      if (name.endsWith(".md")) files.push(`${folder}/${name}`);
  return files.sort();
}
async function topic(repo: string, input: string) {
  const id = validId(input).toLowerCase();
  const matched: { path: string; heading?: string }[] = [];
  for (const file of await documents(repo)) {
    if (path.basename(file, ".md") === id) {
      matched.push({ path: file });
      continue;
    }
    for (const line of (await readBounded(repo, file)).split("\n")) {
      if (!/^#{1,3} /.test(line)) continue;
      const heading = line.replace(/^#+ /, "").trim();
      if (
        heading
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") === id
      )
        matched.push({ path: file, heading });
    }
  }
  if (!matched.length) throw new SkillError(3, `Unknown topic: ${input}`);
  if (matched.length > 1)
    throw new SkillError(
      3,
      `Ambiguous topic ${input}: ${matched.map((item) => item.path).join(", ")}`,
    );
  return matched[0]!;
}
function output(
  io: IO,
  data: Record<string, unknown>,
  json: boolean,
  body?: string,
) {
  if (json)
    io.out(JSON.stringify(body === undefined ? data : { ...data, body }));
  else
    io.out(
      [
        ...Object.entries(data).map(
          ([key, value]) =>
            `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        ),
        ...(body === undefined ? [] : ["", body]),
      ].join("\n"),
    );
}
export async function runSkillCli(
  args: readonly string[],
  io: IO,
  sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  ),
): Promise<number> {
  try {
    const { command, options, positionals } = parse(args);
    const repo = await realpath(sourceRoot);
    const json = options.json === true;
    if (command === "" || command === "list") {
      const items = (await catalog(repo)).map((skill) => ({
        id: skill.id,
        manifest: skill.manifestPath,
        skill: skill.skillPath,
      }));
      output(
        io,
        command === ""
          ? {
              command: "skill",
              installed: items.length,
              skills: items,
              next: [
                "skill show <id>",
                "skill flow",
                "skill topic <topic>",
                "skill schema <type>",
              ],
            }
          : { skills: items },
        json,
      );
    } else if (command === "show") {
      const skill = resolveSkill(await catalog(repo), positionals[0]!);
      const body = options.full
        ? skill.instructions
        : options.section
          ? section(skill.instructions, String(options.section))
          : undefined;
      if (body && Buffer.byteLength(body) > MAX_BODY)
        throw new SkillError(3, "Output exceeds limit");
      output(
        io,
        {
          id: skill.id,
          version: skill.manifest.packageVersion,
          manifest: skill.manifestPath,
          skill: skill.skillPath,
          inputs: skill.manifest.inputs,
          outputs: skill.manifest.outputs,
          humanGates: skill.manifest.humanGates,
        },
        json,
        body,
      );
    } else if (command === "flow") {
      const mode = options.mode ? String(options.mode) : undefined;
      const source = "docs/specifications/design-space-exploration.md";
      await safeFile(repo, source);
      await safeFile(repo, "docs/specifications/orchestrator-runs.md");
      const body = options.full
        ? section(await readBounded(repo, source), "Place in the design flow")
        : undefined;
      output(
        io,
        {
          modes: mode ? [mode] : MODES,
          mode: mode ?? "all",
          flow: source,
          entryModes: "docs/specifications/orchestrator-runs.md",
          convergence: "product-ui-contract",
          ...(mode === "system-first"
            ? { startingContext: "existing system commitments" }
            : {}),
          ...(mode === "experience-first"
            ? { startingContext: "tasks and journeys" }
            : {}),
          ...(mode === "hybrid"
            ? { startingContext: "system and experience context" }
            : {}),
        },
        json,
        body,
      );
    } else if (command === "topic") {
      const found = await topic(repo, positionals[0]!);
      const body = options.full
        ? await readBounded(repo, found.path)
        : options.section
          ? section(
              await readBounded(repo, found.path),
              String(options.section),
            )
          : undefined;
      output(
        io,
        {
          topic: positionals[0],
          path: found.path,
          ...(found.heading ? { heading: found.heading } : {}),
        },
        json,
        body,
      );
    } else if (command === "schema" || command === "artifact") {
      const type = validId(positionals[0]!);
      if (!(await schemas(repo)).includes(type))
        throw new SkillError(3, `Unknown artifact type: ${type}`);
      const file = `schemas/artifacts/types/${type}.schema.json`;
      const raw = await readBounded(repo, file);
      const schema = JSON.parse(raw) as { $id?: string };
      if (schema.$id !== `urn:mimic:artifact:v1:type:${type}`)
        throw new SkillError(3, `Invalid canonical schema: ${type}`);
      if (command === "schema")
        output(
          io,
          { type, path: file, schemaId: schema.$id },
          json,
          options.print ? raw : undefined,
        );
      else {
        const skills = await catalog(repo);
        output(
          io,
          {
            type,
            schema: file,
            producers: skills
              .filter((item) => item.manifest.outputs.includes(type))
              .map((item) => item.id),
            consumers: skills
              .filter((item) =>
                [
                  ...item.manifest.inputs.required,
                  ...item.manifest.inputs.optional,
                  ...item.manifest.inputs.alternatives.flatMap(
                    (group) => group.oneOf,
                  ),
                ].some(
                  (input) =>
                    input.kind === "artifact" && input.artifactType === type,
                ),
              )
              .map((item) => item.id),
          },
          json,
        );
      }
    } else if (command === "locate") {
      const id = validId(positionals[0]!);
      try {
        const skill = resolveSkill(await catalog(repo), id);
        output(
          io,
          {
            id: skill.id,
            kind: "skill",
            manifest: skill.manifestPath,
            skill: skill.skillPath,
          },
          json,
        );
      } catch (error) {
        if (
          !(error instanceof SkillError) ||
          !error.message.startsWith("Skill not installed")
        )
          throw error;
        if ((await schemas(repo)).includes(id))
          output(
            io,
            {
              id,
              kind: "artifact",
              path: `schemas/artifacts/types/${id}.schema.json`,
            },
            json,
          );
        else
          output(
            io,
            { id, kind: "topic", path: (await topic(repo, id)).path },
            json,
          );
      }
    } else if (command === "current") {
      const root = await realpath(
        path.resolve(String(options.root ?? process.cwd())),
      );
      const runId = validId(String(options.run));
      const state = path.join(root, ".mimic/workspace.json");
      try {
        await safeFile(root, state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new SkillError(3, `Run not found: ${runId}`);
        throw error;
      }
      const registry = await new FileWorkspaceStorage(state).read();
      if (!Object.hasOwn(registry.runs, runId))
        throw new SkillError(3, `Run not found: ${runId}`);
      const run = registry.runs[runId]!;
      output(
        io,
        {
          runId,
          state: deriveRunState(run),
          mode: run.entryMode,
          scope: run.scope,
          artifacts: run.artifacts.map(
            (ref) => `${ref.artifactId}@${ref.revision}`,
          ),
          proposals: Object.keys(run.proposals).sort(),
          blockerIds: Object.keys(run.blockers).sort(),
          statePath: ".mimic/workspace.json",
        },
        json,
      );
    } else if (command === "recommend") {
      const intent = positionals.join(" ");
      const tokens = [
        ...new Set(intent.toLowerCase().match(/[a-z0-9]+/g) ?? []),
      ].filter((item) => item.length > 2);
      if (!tokens.length || intent.length > 1000)
        throw new SkillError(3, "Invalid intent");
      const ranked = (await catalog(repo))
        .map((skill) => {
          const name = skill.slug.replace(/^s\d+-/, "").replaceAll("-", " ");
          const heading =
            skill.instructions.split("\n")[0]?.replace(/^# /, "") ?? "";
          const haystack =
            `${name} ${heading} ${skill.manifest.outputs.join(" ")}`.toLowerCase();
          return {
            skill,
            score: tokens.reduce(
              (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
              0,
            ),
          };
        })
        .filter((item) => item.score > 0)
        .sort(
          (a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id),
        );
      output(
        io,
        {
          intent,
          suggestions: ranked
            .slice(0, 5)
            .map(({ skill }) => ({ id: skill.id, skill: skill.skillPath })),
          note: "Suggestions only; no Skill was invoked or approved.",
        },
        json,
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof SkillError ? error.code : 6;
    io.err(
      `MIMIC_${code}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return code;
  }
}
