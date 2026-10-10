import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CodexCreditRiskDecisionPort,
  CodexCreditRiskScope,
} from "./codex.js";

export interface RunCreditScope {
  readonly workspace: string;
  readonly runId: string;
  readonly model: string;
  readonly executable: string;
  readonly maxCalls: number;
  readonly expiresAt: number;
  readonly packages: Readonly<Record<string, string>>;
}

export interface FrozenRunCreditScope extends RunCreditScope {
  readonly inputsSha256: string;
}

/** Only a trusted application with a real human confirmation UI implements this. */
export interface HumanCreditDecision {
  readonly decisionId: string;
  readonly actorId: string;
  readonly approvedAt: number;
}

export interface HumanCreditDecisionSource {
  requestDecision(
    scope: Readonly<FrozenRunCreditScope>,
  ): Promise<HumanCreditDecision | null>;
}

interface StoredGrant {
  workspace: string;
  run_id: string;
  model: string;
  executable: string;
  max_calls: number;
  expires_at: number;
  inputs_sha256: string;
  revoked_at: number | null;
}

const validId = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
const validOpaqueId = (value: string) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
const validModel = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const day = 24 * 60 * 60_000;

/** Freeze the saved task plan, scope configuration, and every selected Skill
 * package file. Generated Run artifacts may append later without changing this
 * approved routing and instruction snapshot. */
export async function frozenRunInputsSha256(
  workspace: string,
  runId: string,
  packages: Readonly<Record<string, string>>,
): Promise<string> {
  if (!validId(runId) || !packages || typeof packages !== "object")
    throw Error("Invalid frozen Run inputs");
  const root = await realpath(workspace);
  const files: { relative: string; sha256: string }[] = [];
  let totalBytes = 0;
  let visitedEntries = 0;
  async function collect(relative: string): Promise<void> {
    if (++visitedEntries > 2000 || relative.split(/[\\/]/).length > 32)
      throw Error("Frozen Run input tree exceeds host limit");
    if (
      path.isAbsolute(relative) ||
      relative
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === "..")
    )
      throw Error("Uncontained frozen Run input");
    const absolute = path.join(root, relative);
    const resolved = await realpath(absolute);
    if (!resolved.startsWith(`${root}${path.sep}`) || resolved !== absolute)
      throw Error("Linked or escaped frozen Run input");
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      for await (const entry of await opendir(absolute))
        await collect(path.join(relative, entry.name));
      return;
    }
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || files.length >= 2000)
      throw Error("Invalid frozen Run input file");
    totalBytes += info.size;
    if (totalBytes > 24 * 1024 * 1024)
      throw Error("Frozen Run inputs exceed host limit");
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      files.push({
        relative,
        sha256: digest((await handle.readFile()).toString("base64")),
      });
    } finally {
      await handle.close();
    }
  }
  await collect(`.mimic/runs/${runId}.json`);
  await collect(".mimic/config.json");
  const orderedPackages = Object.fromEntries(
    Object.entries(packages).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  for (const [taskId, relative] of Object.entries(orderedPackages)) {
    if (!validId(taskId) || typeof relative !== "string")
      throw Error("Invalid frozen package mapping");
    await collect(relative);
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return digest(JSON.stringify({ packages: orderedPackages, files }));
}

/** The host keeps this outside the model workspace. SQLite owns cross-process
 * transaction locking and crash recovery; there is no manually reclaimable lock. */
export class HostCreditAuthorizationStore {
  constructor(private readonly root: string) {}

  private async database(workspace: string): Promise<DatabaseSync> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const directory = await stat(root);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw Error("Authorization store is not private to this host user");
    if (root === workspace || root.startsWith(`${workspace}${path.sep}`))
      throw Error("Authorization store cannot be inside a model workspace");
    const file = path.join(root, "grants.sqlite");
    try {
      const previous = await lstat(file);
      if (!previous.isFile() || (previous.mode & 0o077) !== 0)
        throw Error("Invalid authorization database file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const database = new DatabaseSync(file);
    try {
      await chmod(file, 0o600);
      database.exec(`
        PRAGMA busy_timeout = 1500;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY, workspace TEXT NOT NULL, run_id TEXT NOT NULL,
          model TEXT NOT NULL, executable TEXT NOT NULL,
          max_calls INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          inputs_sha256 TEXT NOT NULL,
          decision_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
          approved_at INTEGER NOT NULL, revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS consumed (
          grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
          decision_id TEXT NOT NULL UNIQUE, consumed_at INTEGER NOT NULL,
          PRIMARY KEY (grant_id, request_id)
        );
      `);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private transaction<T>(database: DatabaseSync, work: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async record(
    scope: RunCreditScope,
    source: HumanCreditDecisionSource,
  ): Promise<string> {
    const workspace = await realpath(scope.workspace);
    const now = Date.now();
    if (
      !validId(scope.runId) ||
      !validModel(scope.model) ||
      !Number.isSafeInteger(scope.maxCalls) ||
      scope.maxCalls < 1 ||
      scope.maxCalls > 20 ||
      !Number.isSafeInteger(scope.expiresAt) ||
      scope.expiresAt <= now ||
      scope.expiresAt > now + day
    )
      throw Error("Invalid run authorization scope");
    const executable = await realpath(scope.executable);
    if (
      !(await stat(executable)).isFile() ||
      executable === workspace ||
      executable.startsWith(`${workspace}${path.sep}`)
    )
      throw Error(
        "Codex executable must be a host-owned file outside the workspace",
      );
    const packages = Object.freeze({ ...scope.packages });
    const inputsSha256 = await frozenRunInputsSha256(
      workspace,
      scope.runId,
      packages,
    );
    const frozen = Object.freeze({
      ...scope,
      workspace,
      executable,
      packages,
      inputsSha256,
    });
    // The callback must be a real host-owned confirmation flow, never model work.
    const requestedAt = Date.now();
    const decision = await source.requestDecision(frozen);
    const decidedAt = Date.now();
    if (
      !decision ||
      !validOpaqueId(decision.decisionId) ||
      !validOpaqueId(decision.actorId) ||
      !Number.isSafeInteger(decision.approvedAt) ||
      decision.approvedAt > decidedAt ||
      decision.approvedAt < requestedAt
    )
      throw Error("No fresh human authorization was provided by the host");
    if (frozen.expiresAt <= decidedAt)
      throw Error("Run authorization expired during confirmation");
    const database = await this.database(workspace);
    try {
      return this.transaction(database, () => {
        if (frozen.expiresAt <= Date.now())
          throw Error("Run authorization expired during confirmation");
        // Keep used IDs throughout their 24-hour freshness window.
        database
          .prepare(
            "DELETE FROM grants WHERE expires_at <= ? AND approved_at < ?",
          )
          .run(decidedAt, decidedAt - day);
        if (
          database
            .prepare("SELECT id FROM grants WHERE decision_id = ?")
            .get(decision.decisionId)
        )
          throw Error("Human decision has already been recorded");
        const id = `grant_${randomUUID().replaceAll("-", "")}`;
        database
          .prepare(
            `
          INSERT INTO grants
          (id, workspace, run_id, model, executable, max_calls, expires_at, inputs_sha256,
           decision_id, actor_id, approved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            workspace,
            frozen.runId,
            frozen.model,
            executable,
            frozen.maxCalls,
            frozen.expiresAt,
            inputsSha256,
            decision.decisionId,
            decision.actorId,
            decision.approvedAt,
          );
        return id;
      });
    } finally {
      database.close();
    }
  }

  async revoke(grantId: string, workspace: string): Promise<void> {
    const canonicalWorkspace = await realpath(workspace);
    const database = await this.database(canonicalWorkspace);
    try {
      this.transaction(database, () => {
        const result = database
          .prepare(
            `
          UPDATE grants SET revoked_at = COALESCE(revoked_at, ?)
          WHERE id = ? AND workspace = ?
        `,
          )
          .run(Date.now(), grantId, canonicalWorkspace);
        if (result.changes !== 1) throw Error("Unknown grant");
      });
    } finally {
      database.close();
    }
  }

  async executableFor(grantId: string, workspace: string): Promise<string> {
    const canonicalWorkspace = await realpath(workspace);
    const database = await this.database(canonicalWorkspace);
    try {
      const grant = database
        .prepare(
          `
        SELECT workspace, executable, expires_at, revoked_at FROM grants WHERE id = ?
      `,
        )
        .get(grantId) as
        | Pick<
            StoredGrant,
            "workspace" | "executable" | "expires_at" | "revoked_at"
          >
        | undefined;
      if (
        !grant ||
        grant.workspace !== canonicalWorkspace ||
        grant.revoked_at !== null ||
        grant.expires_at <= Date.now()
      )
        throw Error("No current authorization for this workspace");
      return grant.executable;
    } finally {
      database.close();
    }
  }

  /** The trusted coordinator derives expectedScope from the frozen Run plan. */
  port(
    grantId: string,
    runId: string,
    expectedScope: CodexCreditRiskScope,
    inputsSha256: string,
    packages: Readonly<Record<string, string>>,
    executable: string,
  ): CodexCreditRiskDecisionPort {
    return {
      consumeUserDecision: async (actual, signal) => {
        if (signal?.aborted) throw Error("Authorization cancelled");
        const workspace = await realpath(expectedScope.workspace);
        if (
          actual.requestId !== expectedScope.requestId ||
          actual.model !== expectedScope.model ||
          actual.workspace !== workspace ||
          actual.promptSha256 !== expectedScope.promptSha256 ||
          !/^[a-f0-9]{64}$/.test(actual.promptSha256)
        )
          throw Error("Execution differs from approved frozen request");
        if (
          (await frozenRunInputsSha256(workspace, runId, packages)) !==
          inputsSha256
        )
          throw Error("Frozen Run inputs changed before authorization");
        const database = await this.database(workspace);
        try {
          return this.transaction(database, () => {
            if (signal?.aborted) throw Error("Authorization cancelled");
            const grant = database
              .prepare(
                `
              SELECT workspace, run_id, model, executable, max_calls, expires_at,
                     inputs_sha256, revoked_at
              FROM grants WHERE id = ?
            `,
              )
              .get(grantId) as StoredGrant | undefined;
            const now = Date.now();
            const count = database
              .prepare(
                "SELECT COUNT(*) AS count FROM consumed WHERE grant_id = ?",
              )
              .get(grantId) as { count: number };
            if (
              !grant ||
              grant.workspace !== workspace ||
              grant.run_id !== runId ||
              grant.model !== actual.model ||
              grant.executable !== executable ||
              grant.inputs_sha256 !== inputsSha256 ||
              grant.revoked_at !== null ||
              grant.expires_at <= now ||
              count.count >= grant.max_calls ||
              database
                .prepare(
                  "SELECT 1 FROM consumed WHERE grant_id = ? AND request_id = ?",
                )
                .get(grantId, actual.requestId)
            )
              throw Error("No current authorization for this execution");
            const decisionId = `use_${digest(`${grantId}:${actual.requestId}:${actual.promptSha256}`)}`;
            database
              .prepare(
                `
              INSERT INTO consumed (grant_id, request_id, prompt_sha256, decision_id, consumed_at)
              VALUES (?, ?, ?, ?, ?)
            `,
              )
              .run(
                grantId,
                actual.requestId,
                actual.promptSha256,
                decisionId,
                now,
              );
            return {
              decisionId,
              expiresAt: Math.min(now + 60_000, grant.expires_at),
            };
          });
        } finally {
          database.close();
        }
      },
    };
  }
}
