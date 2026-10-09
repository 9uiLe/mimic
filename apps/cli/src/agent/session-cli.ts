import { constants } from "node:fs";
import { mkdir, open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import {
  artifactDigest,
  loadSkillPackage,
  type ExactArtifactRef,
} from "@mimic/core";
import { runCli, EXIT } from "../cli.js";
import { atomicCreateJson } from "../atomic-file.js";
import {
  sessionDigest,
  SessionQuestion,
  SessionBindingChanged,
  type SessionBinding,
  type SessionPlan,
  type SessionPorts,
  type TaskBinding,
  type SavedWork,
} from "./session.js";

export interface StaticSessionConfiguration {
  workspace: string;
  sessionId: string;
  schemasRoot: string;
  binding(): Promise<SessionBinding>;
  next(): Promise<SessionPlan>;
  /** Validate against saved exact invocation/input/context, including on recovery. */
  validateTask(binding: TaskBinding): Promise<void>;
  packagePath(binding: TaskBinding): string;
  /** Check accepted Run production with authority-validating Core artifact reads. */
  verifyAccepted(
    binding: TaskBinding,
    refs: readonly ExactArtifactRef[],
  ): Promise<void>;
}

/** This marker is accepted only in references to newly emitted artifacts. It
 * cannot change an input lock, artifact bytes, or a concrete supplied digest. */
export const HOST_DERIVED_DIGEST = "host-derived";
function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid generated work mapping");
  return value as Record<string, unknown>;
}
function refKey(value: Record<string, unknown>): string {
  if (
    typeof value.artifactId !== "string" ||
    !value.artifactId ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw new Error("Invalid generated reference identity");
  return JSON.stringify([value.artifactId, value.revision]);
}
/** Derive only fresh output-reference hashes before the immutable reservation.
 * The ordinary static CLI remains responsible for schema, origin and authority. */
function deriveOutputDigests(value: unknown, task: TaskBinding): unknown {
  const envelope = mapping(value);
  const work = mapping(envelope.work);
  const result = mapping(work.result);
  if (!Array.isArray(envelope.artifacts) || !Array.isArray(result.outputRefs))
    throw new Error("Invalid generated artifact envelope");
  const inputs = new Set(task.inputRefs.map((ref) => refKey({ ...ref })));
  const fresh = new Map<string, string>();
  for (const value of envelope.artifacts) {
    const artifact = mapping(value);
    const meta = mapping(artifact.meta);
    const key = refKey({ artifactId: meta.id, revision: meta.revision });
    if (fresh.has(key) || inputs.has(key))
      throw new Error("Duplicate artifact or attempted input replacement");
    const digest = artifactDigest(artifact);
    if (meta.contentDigest !== undefined && meta.contentDigest !== digest)
      throw new Error("Generated artifact content digest differs");
    fresh.set(key, digest);
  }
  const outputs = new Map<string, Record<string, unknown>>();
  const bind = (value: unknown): string => {
    const ref = mapping(value);
    const key = refKey(ref);
    const digest = fresh.get(key);
    if (digest) {
      if (
        ref.lockDigest !== undefined &&
        ref.lockDigest !== HOST_DERIVED_DIGEST &&
        ref.lockDigest !== digest
      )
        throw new Error("Generated output digest differs");
      ref.lockDigest = digest;
    } else if (
      typeof ref.lockDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(ref.lockDigest)
    )
      throw new Error("Only fresh artifact references may derive digests");
    return key;
  };
  for (const value of result.outputRefs) {
    const ref = mapping(value);
    const key = bind(ref);
    if (outputs.has(key))
      throw new Error("Duplicate generated output reference");
    outputs.set(key, ref);
  }
  for (const key of fresh.keys()) {
    if (!outputs.has(key))
      throw new Error("Generated artifact has no output reference");
  }
  const bindOutput = (value: unknown): string => {
    const key = bind(value);
    const output = outputs.get(key);
    if (!output || sessionDigest(value) !== sessionDigest(output))
      throw new Error("Generated handoff does not match an output reference");
    return key;
  };
  if (result.proposal !== undefined) {
    const proposal = mapping(result.proposal);
    if (!Array.isArray(proposal.items))
      throw new Error("Invalid generated proposal items");
    const seen = new Set<string>();
    for (const value of proposal.items) {
      const key = bindOutput(mapping(value).ref);
      if (seen.has(key))
        throw new Error("Duplicate generated proposal reference");
      seen.add(key);
    }
  }
  if (work.revisionRequests !== undefined) {
    if (!Array.isArray(work.revisionRequests))
      throw new Error("Invalid generated revision requests");
    const seen = new Set<string>();
    for (const value of work.revisionRequests) {
      const key = bindOutput(mapping(value).request);
      if (seen.has(key))
        throw new Error("Duplicate generated revision request");
      seen.add(key);
    }
  }
  return envelope;
}
async function contained(root: string, relative: string): Promise<string> {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => part === "..")
  )
    throw new Error("Uncontained session path");
  const directory = await realpath(root);
  let current = directory;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Session path contains a link");
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${directory}${path.sep}`))
    throw new Error("Uncontained session path");
  return resolved;
}
/** No executeSkill host: the public CLI retains static package checks, immutable
 * work reservations, acceptance reconciliation and revision-request handoff. */
export function createStaticSessionPorts(
  config: StaticSessionConfiguration,
): SessionPorts {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(config.sessionId))
    throw new Error("Invalid session ID");
  const invoke = async (args: string[]) => {
    const values: string[] = [];
    const code = await runCli([...args, "--root", config.workspace, "--json"], {
      out: (value) => values.push(value),
      err: () => {},
    });
    if (code !== EXIT.OK)
      throw new Error("Static session operation did not complete");
    return JSON.parse(values.at(-1)!) as Record<string, unknown>;
  };
  let frozenBinding: SessionBinding | undefined;
  const bound = async () => {
    const current = await config.binding();
    frozenBinding ??= structuredClone(current);
    if (sessionDigest(current) !== sessionDigest(frozenBinding))
      throw new SessionBindingChanged();
    return frozenBinding;
  };
  const readSavedJson = async (saved: SavedWork): Promise<unknown> => {
    const file = await contained(config.workspace, saved.path);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("Work is not a regular file");
      const work = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (sessionDigest(work) !== saved.digest)
        throw new Error("Saved work changed");
      return work;
    } finally {
      await handle.close();
    }
  };
  const readWork = async (saved: SavedWork) =>
    (await readSavedJson(saved)) as {
      work: { result: { outputRefs: ExactArtifactRef[] } };
    };
  return {
    workspace: config.workspace,
    binding: bound,
    next: config.next,
    verifyAccepted: config.verifyAccepted,
    inspect: async () => invoke(["inspect", (await bound()).runId]),
    saveWork: async (task, output) => {
      await bound();
      await config.validateTask(task);
      const value = deriveOutputDigests(JSON.parse(output) as unknown, task);
      const digest = sessionDigest(value);
      const root = await realpath(config.workspace);
      // Require existing trusted metadata; never create through an external link.
      await contained(root, ".mimic");
      const folder = path.join(".mimic", "agent-work");
      try {
        await mkdir(path.join(root, folder), { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await contained(root, folder);
      const relative = path.join(
        folder,
        `${config.sessionId}-${task.taskId}-${digest}.json`,
      );
      // Preserve the exact model string independently of deterministic reference
      // preparation. Different strings with identical prepared work remain distinct.
      const rawPath = path.join(
        folder,
        `${config.sessionId}-${task.taskId}-${sessionDigest(output)}.raw.json`,
      );
      const raw = {
        version: 1,
        output,
        outputDigest: sessionDigest(output),
        normalizedDigest: digest,
      };
      await atomicCreateJson(path.join(root, rawPath), raw);
      await readSavedJson({ path: rawPath, digest: sessionDigest(raw) });
      await atomicCreateJson(path.join(root, relative), value);
      const saved = { path: relative, digest };
      await readWork(saved);
      return saved;
    },
    submit: async (task, saved) => {
      await bound();
      await config.validateTask(task);
      const packagePath = config.packagePath(task);
      const packageDirectory = await contained(config.workspace, packagePath);
      const skill = await loadSkillPackage(
        packageDirectory,
        config.schemasRoot,
      );
      if (
        sessionDigest(skill) !== task.packageDigest ||
        skill.manifest.packageVersion !== task.packageVersion
      )
        throw new SessionBindingChanged();
      const work = await readWork(saved);
      const result = await invoke([
        "submit",
        (await bound()).runId,
        "--task",
        task.taskId,
        "--package",
        packagePath,
        "--work",
        saved.path,
      ]);
      if (result.submissionState === "blocked")
        throw new SessionQuestion(task.taskId);
      if (result.submissionState !== "accepted")
        throw new Error("Static submission requires attention");
      await config.verifyAccepted(task, work.work.result.outputRefs);
      return work.work.result.outputRefs;
    },
  };
}
