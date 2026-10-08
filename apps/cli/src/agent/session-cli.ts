import { constants } from "node:fs";
import { mkdir, open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { loadSkillPackage, type ExactArtifactRef } from "@mimic/core";
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
  const readWork = async (saved: SavedWork) => {
    const file = await contained(config.workspace, saved.path);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("Work is not a regular file");
      const work = JSON.parse(await handle.readFile("utf8")) as {
        work: { result: { outputRefs: ExactArtifactRef[] } };
      };
      if (sessionDigest(work) !== saved.digest)
        throw new Error("Saved work changed");
      return work;
    } finally {
      await handle.close();
    }
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
      const value = JSON.parse(output) as unknown;
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
