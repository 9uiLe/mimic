import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, jsonCopy } from "../artifact-canonical.js";
import { parseArtifactYaml } from "../artifact-codec.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import type {
  Orchestrator,
  RoutedTask,
  SkillInvocation,
  SkillResult,
  UpstreamRevisionRequest,
} from "../orchestrator/router.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";

type Input =
  | {
      readonly name: string;
      readonly kind: "artifact";
      readonly artifactType: string;
      readonly schemaVersion: string;
    }
  | { readonly name: string; readonly kind: "human-brief" | "evidence-file" };
export interface SkillManifest {
  readonly skillId: string;
  readonly manifestVersion: string;
  readonly packageVersion: string;
  readonly skillFile: string;
  readonly inputs: {
    readonly required: readonly Input[];
    readonly optional: readonly Input[];
    readonly alternatives: readonly {
      readonly name: string;
      readonly oneOf: readonly Input[];
    }[];
  };
  readonly outputs: readonly string[];
  readonly forbiddenResponsibilities: readonly string[];
  readonly humanGates: readonly {
    readonly decision: string;
    readonly authority: "PROPOSE_ONLY";
  }[];
  readonly supportedArtifactSchemas: readonly {
    readonly artifactType: string;
    readonly schemaVersion: string;
  }[];
  readonly examples: readonly string[];
  readonly tests: readonly string[];
}
export interface SkillPackage {
  readonly directory: string;
  readonly manifest: SkillManifest;
  readonly instructions: string;
  readonly examples: Readonly<Record<string, string>>;
  readonly tests: Readonly<Record<string, string>>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected schema object",
  );
  return value as Record<string, unknown>;
}
async function regularInside(root: string, reference: string): Promise<string> {
  assert(
    path.posix.normalize(reference) === reference,
    `Non-canonical package path: ${reference}`,
  );
  const target = path.resolve(root, reference);
  assert(
    target.startsWith(`${root}${path.sep}`),
    `Path escapes package: ${reference}`,
  );
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    assert(
      !(await lstat(current)).isSymbolicLink(),
      `Symlink in package path: ${reference}`,
    );
  }
  assert(
    (await lstat(target)).isFile(),
    `Package reference is not a file: ${reference}`,
  );
  assert(
    (await realpath(target)).startsWith(`${await realpath(root)}${path.sep}`),
    `Real path escapes package: ${reference}`,
  );
  return target;
}

/** Load one static package against the merged 9UI-136 manifest and canonical artifact schemas. */
export async function loadSkillPackage(
  directory: string,
  schemasRoot: string,
): Promise<SkillPackage> {
  const root = path.resolve(directory);
  assert(
    (await lstat(root)).isDirectory(),
    "Skill package root is not a directory",
  );
  const manifests = ["manifest.yaml", "manifest.json"];
  const present = (await readdir(root)).filter((name) =>
    manifests.includes(name),
  );
  assert(
    present.length === 1,
    "Skill package requires exactly one manifest.yaml or manifest.json",
  );
  const manifestPath = await regularInside(root, present[0]!);
  const source = await readFile(manifestPath, "utf8");
  const value =
    present[0] === "manifest.json"
      ? JSON.parse(source)
      : parseArtifactYaml(source);
  const manifest = jsonCopy(value) as unknown as SkillManifest;
  const schema = JSON.parse(
    await readFile(
      path.join(schemasRoot, "skills/skill-package.schema.json"),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  const validate = ajv.compile(schema);
  assert(
    validate(manifest),
    `Manifest shape: ${ajv.errorsText(validate.errors)}`,
  );

  const common = record(
    JSON.parse(
      await readFile(
        path.join(schemasRoot, "artifacts/common.schema.json"),
        "utf8",
      ),
    ),
  );
  const version = record(record(record(common.properties).meta).properties)
    .schemaVersion as { const: string };
  const supported = new Map<string, string>();
  for (const file of await readdir(path.join(schemasRoot, "artifacts/types"))) {
    if (!file.endsWith(".schema.json")) continue;
    const typeSchema = record(
      JSON.parse(
        await readFile(path.join(schemasRoot, "artifacts/types", file), "utf8"),
      ),
    );
    const allOf = typeSchema.allOf as Record<string, unknown>[];
    const type = record(record(record(allOf[1]).properties).meta)
      .properties as { type: { const: string } };
    const name = type.type.const;
    assert(
      typeSchema.$id === `urn:mimic:artifact:v1:type:${name}` &&
        !supported.has(name),
      `Invalid canonical artifact schema: ${file}`,
    );
    supported.set(name, version.const);
  }
  assert(supported.size > 0, "No canonical artifact schemas");
  const declared = new Map<string, string>();
  for (const item of manifest.supportedArtifactSchemas) {
    assert(
      !declared.has(item.artifactType),
      `Duplicate artifact compatibility: ${item.artifactType}`,
    );
    assert(
      supported.get(item.artifactType) === item.schemaVersion,
      `Unsupported artifact type/version: ${item.artifactType}`,
    );
    declared.set(item.artifactType, item.schemaVersion);
  }
  const names = new Set<string>();
  const artifactInputs = new Set<string>();
  for (const group of manifest.inputs.alternatives) {
    assert(!names.has(group.name), `Duplicate input name: ${group.name}`);
    names.add(group.name);
  }
  for (const item of [
    ...manifest.inputs.required,
    ...manifest.inputs.optional,
    ...manifest.inputs.alternatives.flatMap((group) => group.oneOf),
  ]) {
    assert(!names.has(item.name), `Duplicate input name: ${item.name}`);
    names.add(item.name);
    if (item.kind === "artifact") {
      assert(
        !artifactInputs.has(item.artifactType),
        `Conflicting artifact input declarations: ${item.artifactType}`,
      );
      artifactInputs.add(item.artifactType);
      assert(
        declared.get(item.artifactType) === item.schemaVersion,
        `Undeclared artifact input type/version: ${item.artifactType}`,
      );
    }
  }
  for (const type of manifest.outputs)
    assert(declared.has(type), `Undeclared output artifact type: ${type}`);
  assert(
    path.basename(manifest.skillFile) === "SKILL.md",
    "skillFile must reference SKILL.md",
  );
  const references = [
    manifest.skillFile,
    ...manifest.examples,
    ...manifest.tests,
  ];
  assert(
    new Set(references).size === references.length,
    "Duplicate package file reference",
  );
  const files = new Map<string, string>();
  for (const reference of references)
    files.set(
      reference,
      await readFile(await regularInside(root, reference), "utf8"),
    );
  const select = (
    references: readonly string[],
  ): Readonly<Record<string, string>> =>
    Object.fromEntries(
      references.map((reference) => [reference, files.get(reference)!]),
    );
  return {
    directory: root,
    manifest,
    instructions: files.get(manifest.skillFile)!,
    examples: select(manifest.examples),
    tests: select(manifest.tests),
  };
}

export interface SkillContext {
  readonly invocation: SkillInvocation;
  readonly inputs: readonly {
    readonly name: string;
    readonly ref: ExactArtifactRef;
    readonly artifact: ArtifactSnapshot;
  }[];
  readonly package: SkillPackage;
  readonly gaps: readonly string[];
}
export interface SkillFinding {
  readonly claim: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "PASS" | "CONCERN" | "FAIL" | "UNVERIFIED" | "N/A";
}
export interface SkillUnknown {
  readonly question: string;
  readonly affectedTaskIds: readonly string[];
}
export interface SkillWork {
  readonly result: SkillResult;
  readonly findings?: readonly SkillFinding[];
  readonly unknowns?: readonly SkillUnknown[];
  readonly revisionRequests?: readonly UpstreamRevisionRequest[];
}
export type SkillExecutor = (context: SkillContext) => Promise<SkillWork>;

function declaredInput(value: RoutedTask["inputs"]["required"][number]): Input {
  return value.kind === "artifact"
    ? {
        name: value.name,
        kind: value.kind,
        artifactType: value.artifactType,
        schemaVersion: value.schemaVersion ?? "",
      }
    : { name: value.name, kind: value.kind };
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function checkTask(task: RoutedTask, manifest: SkillManifest): void {
  assert(
    task.skillId === manifest.skillId,
    "Task Skill ID differs from package",
  );
  assert(
    [task.outputType, ...(task.additionalOutputTypes ?? [])].every((type) =>
      manifest.outputs.includes(type),
    ),
    "Task requests undeclared output type",
  );
  for (const key of ["required", "optional"] as const)
    assert(
      same(task.inputs[key].map(declaredInput), manifest.inputs[key]),
      `Task ${key} inputs differ from manifest`,
    );
  assert(
    same(
      task.inputs.alternatives.map((group) => group.oneOf.map(declaredInput)),
      manifest.inputs.alternatives.map((group) => group.oneOf),
    ),
    "Task alternatives differ from manifest",
  );
}

/** The executor is trusted injected code. This function constrains its data and accepted result, not its OS privileges. */
export async function runSkillPackage(input: {
  readonly orchestrator: Orchestrator;
  readonly package: SkillPackage;
  readonly runId: string;
  readonly tasks: readonly RoutedTask[];
  readonly taskId: string;
  readonly at: string;
  readonly executor: SkillExecutor;
}): Promise<Omit<SkillWork, "result"> & { readonly result: SkillResult }> {
  const task = input.tasks.find((item) => item.id === input.taskId);
  assert(task, "Skill task not found");
  checkTask(task, input.package.manifest);
  let work: SkillWork | undefined;
  await input.orchestrator.invoke(
    input.runId,
    input.tasks,
    input.taskId,
    async (invocation) => {
      assert(
        invocation.skillId === input.package.manifest.skillId,
        "Invocation Skill ID differs from package",
      );
      assert(
        invocation.allowedOutputTypes.every((type) =>
          input.package.manifest.outputs.includes(type),
        ),
        "Invocation permits undeclared output",
      );
      const resolved: SkillContext["inputs"][number][] = [];
      for (const binding of invocation.inputBindings)
        for (const ref of binding.refs) {
          const stored = await input.orchestrator.artifacts.read(
            ref.artifactId,
            ref.revision,
          );
          assert(stored.digest === ref.lockDigest, "Input exact lock mismatch");
          resolved.push({
            name: binding.name,
            ref: jsonCopy(ref),
            artifact: jsonCopy(stored.artifact),
          });
        }
      const bound = new Set(
        invocation.inputBindings.map((binding) => binding.name),
      );
      const gaps = input.package.manifest.inputs.optional
        .filter((need) =>
          need.kind === "artifact"
            ? !bound.has(need.name)
            : need.kind === "human-brief"
              ? !invocation.humanBrief
              : invocation.evidenceFiles.length === 0,
        )
        .map((need) => need.name);
      work = jsonCopy(
        await input.executor(
          jsonCopy({
            invocation,
            inputs: resolved,
            package: input.package,
            gaps,
          }),
        ),
      );
      assert(
        work &&
          Object.keys(work).every((key) =>
            ["result", "findings", "unknowns", "revisionRequests"].includes(
              key,
            ),
          ),
        "Unexpected Skill work effect",
      );
      assert(
        work.result &&
          work.result.outputRefs.every((ref) => {
            assert(
              ref &&
                typeof ref.artifactId === "string" &&
                Number.isSafeInteger(ref.revision) &&
                typeof ref.lockDigest === "string",
              "Malformed output reference",
            );
            return true;
          }),
        "Malformed Skill result",
      );
      for (const finding of work.findings ?? []) {
        assert(
          finding.claim.trim() &&
            ["PASS", "CONCERN", "FAIL", "UNVERIFIED", "N/A"].includes(
              finding.status,
            ),
          "Invalid finding",
        );
        assert(
          finding.status === "UNVERIFIED" ||
            finding.status === "N/A" ||
            finding.evidenceRefs.length > 0,
          "Finding lacks evidence reference",
        );
      }
      for (const unknown of work.unknowns ?? [])
        assert(
          unknown.question.trim() &&
            unknown.affectedTaskIds.includes(input.taskId),
          "Invalid unknown",
        );
      for (const request of work.revisionRequests ?? []) {
        assert(
          request.runId === invocation.runId &&
            request.reason.trim() &&
            request.evidenceRefs.length > 0,
          "Invalid revision request",
        );
        assert(
          invocation.inputRefs.some((ref) => same(ref, request.source)),
          "Revision source outside context",
        );
        assert(
          request.affectedLocks.some((ref) => same(ref, request.source)),
          "Revision request omits source lock",
        );
        assert(
          work.result.outputRefs.some((ref) => same(ref, request.request)),
          "Revision request output not returned",
        );
      }
      return work.result;
    },
    input.at,
  );
  return work!;
}
