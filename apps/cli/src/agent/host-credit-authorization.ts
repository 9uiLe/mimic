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
import { canonicalJson } from "@mimic/core";
import type {
  CodexCreditRiskDecisionPort,
  CodexCreditRiskScope,
} from "./codex.js";
import {
  FileSessionStore,
  sessionDigest,
  type SessionCheckpoint,
} from "./session.js";

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

/** The recording operator transcribes a real user delegation. This is an
 * accountable local assertion, not cryptographic proof of the conversation. */
export interface DelegatedCreditEvidence {
  readonly sourceThreadId: string;
  readonly requestMessageId: string;
  readonly requestText: string;
  readonly delegationMessageId: string;
  readonly delegationText: string;
  readonly contextMessageId: string;
  readonly approvalMessageId: string;
  readonly contextText: string;
  readonly approvalText: string;
  readonly approverId: string;
  readonly delegateId: string;
  readonly recordedBy: string;
  readonly approvedAt: number;
  readonly approvalTimePrecision: "minute" | "millisecond";
  readonly continuation?: {
    readonly priorGrantId: string;
    readonly referenceSha256: string;
    readonly changeSummary: string;
    readonly kind?: "selected-revision" | "same-run-retry";
    readonly rejectedSessionId?: string;
  };
  readonly attestedScope: {
    readonly workspace: string;
    readonly runId: string;
    readonly model: string;
    readonly executable: string;
    readonly maxCalls: number;
    readonly durationMinutes: number;
    readonly inputsSha256: string;
  };
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
  reference_sha256: string | null;
  continuation_of: string | null;
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
const validEvidenceText = (value: string) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
const explicitCreditApproval = (value: string) =>
  value.trim() === "OK" ||
  value.trim() === "OK, GPTのクレジットは自由に使って構いません。" ||
  value.trim() === "それならどれだけ使ってもいいよ";
const validModel = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const day = 24 * 60 * 60_000;

async function containedIntakeFile(
  workspace: string,
  relative: string,
): Promise<string> {
  const file = path.join(workspace, relative);
  if ((await realpath(file)) !== file)
    throw Error("Continuation input changed");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw Error("Invalid continuation input file");
    return handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function referenceDigest(workspace: string): Promise<string> {
  return `sha256:${digest(await containedIntakeFile(workspace, "inputs/references.md"))}`;
}

/** This continuation is limited to adding references to the same guided
 * design brief. The operator remains responsible for verifying the sources. */
async function addedReferencesOnly(
  priorWorkspace: string,
  workspace: string,
  priorRunId: string,
  runId: string,
  priorInputsSha256: string,
  packages: Readonly<Record<string, string>>,
): Promise<boolean> {
  if (
    priorWorkspace === workspace ||
    path.dirname(priorWorkspace) !== path.dirname(workspace)
  )
    return false;
  const intake = async (root: string) => {
    return JSON.parse(
      await containedIntakeFile(root, "intake-source.json"),
    ) as {
      model: string;
      brief: { references: unknown[] };
      [key: string]: unknown;
    };
  };
  const prior = await intake(priorWorkspace);
  const next = await intake(workspace);
  const guidedRunId = (value: typeof prior) =>
    `run_design_${digest(JSON.stringify(value)).slice(0, 16)}`;
  if (
    guidedRunId(prior) !== priorRunId ||
    guidedRunId(next) !== runId ||
    (await frozenRunInputsSha256(priorWorkspace, priorRunId, packages)) !==
      priorInputsSha256
  )
    return false;
  if (
    !Array.isArray(prior.brief?.references) ||
    !Array.isArray(next.brief?.references) ||
    next.brief.references.length <= prior.brief.references.length ||
    JSON.stringify(
      next.brief.references.slice(0, prior.brief.references.length),
    ) !== JSON.stringify(prior.brief.references)
  )
    return false;
  const withoutReferences = (value: typeof prior) => ({
    ...value,
    brief: { ...value.brief, references: [] },
  });
  if (
    JSON.stringify(withoutReferences(prior)) !==
    JSON.stringify(withoutReferences(next))
  )
    return false;
  const renderedReferences = (value: typeof prior) => {
    const text = value.brief.references.length
      ? value.brief.references
          .map((item) => {
            const ref = item as Record<string, unknown>;
            return `- Source: ${ref.source}\n  Reason: ${ref.reason}\n  Applies when: ${ref.appliesWhen}\n  Do not borrow: ${ref.doNotBorrow}`;
          })
          .join("\n")
      : "No references were supplied. Do not infer or invent a source.";
    return `# References supplied by the user\n\n${text}\n`;
  };
  if (
    (await containedIntakeFile(priorWorkspace, "inputs/references.md")) !==
      renderedReferences(prior) ||
    (await containedIntakeFile(workspace, "inputs/references.md")) !==
      renderedReferences(next)
  )
    return false;
  return next.brief.references
    .slice(prior.brief.references.length)
    .every((value) => {
      const item = value as Record<string, unknown>;
      return (
        typeof item?.source === "string" &&
        /https:\/\/[^\s,)]+/.test(item.source) &&
        [item.reason, item.appliesWhen, item.doNotBorrow].every(
          (part) => typeof part === "string" && validEvidenceText(part),
        )
      );
    });
}

/** A second Run in the same workspace may revise only the exact direction
 * selected in its parent Run. Core still verifies the selection at Run start. */
async function selectedRevisionOnly(
  workspace: string,
  priorRunId: string,
  runId: string,
  priorInputsSha256: string,
  packages: Readonly<Record<string, string>>,
): Promise<boolean> {
  type Ref = { artifactId: string; revision: number; lockDigest: string };
  type Selection = {
    id: string;
    runId: string;
    ref: Ref;
    actor: { kind: string };
    externalRefs: string[];
  };
  type RevisionBase = { ref: Ref; sourceRunId: string; selectionId: string };
  type Trial = Record<string, unknown> & {
    runId: string;
    previousRunId?: string;
    condition: string;
    revisionRequest?: string;
    baseRef?: Ref;
  };
  type Task = {
    id: string;
    humanBrief?: string;
    intent?: string;
    targetArtifactId?: string;
    revisionBase?: RevisionBase;
    inputs?: {
      required?: unknown[];
      optional?: { name?: string; refs?: Ref[] }[];
    };
    [key: string]: unknown;
  };
  const load = async <T>(relative: string): Promise<T> =>
    JSON.parse(await containedIntakeFile(workspace, relative)) as T;
  const prior = await load<Trial>(`trial-${priorRunId}.json`);
  const child = await load<Trial>(`trial-${runId}.json`);
  const state = await load<{
    registry?: {
      runs?: Record<
        string,
        { revisionSelection?: Selection; revisionBase?: RevisionBase }
      >;
    };
    snapshots?: Record<string, string>;
  }>(".mimic/workspace.json");
  const priorPlan = await load<Task[]>(`.mimic/runs/${priorRunId}.json`);
  const planText = await containedIntakeFile(
    workspace,
    `.mimic/runs/${runId}.json`,
  );
  const plan = JSON.parse(planText) as Task[];
  const ref = child.baseRef;
  const selection = state.registry?.runs?.[priorRunId]?.revisionSelection;
  const revisionBase = state.registry?.runs?.[runId]?.revisionBase;
  const s10 = Array.isArray(plan)
    ? plan.find((task) => task.id === "s10")
    : undefined;
  const same = (left: unknown, right: unknown) =>
    canonicalJson(left) === canonicalJson(right);
  const saved = state.snapshots?.[`${ref?.artifactId}@${ref?.revision}`];
  const snapshot = saved
    ? (JSON.parse(saved) as {
        digest?: string;
        artifact?: { content?: unknown };
      })
    : undefined;
  const commonBrief = plan.find((task) => task.id === "s04")?.humanBrief;
  const intervention =
    "Design intervention: choose information and structure from the user's task and primary action. Do not add impressive but irrelevant statistics, claims or sections.";
  const revisedS10Brief = commonBrief?.includes(intervention)
    ? commonBrief.replace(
        intervention,
        `Revise only the human-selected direction once; do not create alternative directions.\n${intervention}`,
      )
    : undefined;
  const suffix =
    ref && snapshot?.artifact?.content && child.revisionRequest
      ? `\nHuman-selected prior direction: ${ref.artifactId}@${ref.revision}#${ref.lockDigest} from Run ${priorRunId}. Its accepted content is ${JSON.stringify(snapshot.artifact.content)}. Address only this requested issue: ${child.revisionRequest}. Retain the prior direction unless the issue requires a change. This is revision of the selected direction; do not imply a new human choice.`
      : undefined;
  const expectedPlan = priorPlan.map((task) => {
    if (task.id === "s10")
      return {
        ...task,
        humanBrief: `${revisedS10Brief}\nImprove the selected direction against the stated issue. Preserve its useful structure and explain the change and its cost; do not generate new options or claim another human selection.${suffix}`,
        intent: "revise",
        targetArtifactId: ref?.artifactId,
        revisionBase,
        inputs: {
          ...task.inputs,
          optional: task.inputs?.optional?.map((input) =>
            input.name === "prior-direction"
              ? { ...input, refs: [ref] }
              : input,
          ),
        },
      };
    if (task.id === "s11")
      return {
        ...task,
        humanBrief: `${commonBrief}\nCritique unnecessary information, generic structure and reference misuse by screen location and reason. Keep untested operation and human preference UNVERIFIED. Give a recommendation and trade-offs, never an AI-likeness score or a ban on purple, rounded corners or a font. Human selection is pending.${suffix}`,
      };
    return task;
  });
  const frozenFields = [
    "condition",
    "model",
    "budget",
    "brief",
    "referenceFile",
    "referenceDigest",
    "evidenceFiles",
    "evidenceDigests",
    "skillTreeDigest",
    "schemaTreeDigest",
    "templateDigest",
    "revisionBudget",
  ];
  return !!(
    prior.runId === priorRunId &&
    child.runId === runId &&
    child.previousRunId === priorRunId &&
    child.condition === "guided" &&
    typeof child.revisionRequest === "string" &&
    child.revisionRequest.trim() &&
    child.planDigest === `sha256:${digest(planText)}` &&
    snapshot?.digest === ref?.lockDigest &&
    typeof commonBrief === "string" &&
    typeof revisedS10Brief === "string" &&
    typeof suffix === "string" &&
    priorPlan.length === plan.length &&
    priorPlan.some((task) => task.id === "s10") &&
    priorPlan.some((task) => task.id === "s11") &&
    same(plan, expectedPlan) &&
    planText ===
      (await containedIntakeFile(workspace, `tasks-${runId}.json`)) &&
    frozenFields.every((field) => same(prior[field], child[field])) &&
    ref?.artifactId &&
    Number.isSafeInteger(ref.revision) &&
    /^sha256:[a-f0-9]{64}$/.test(ref.lockDigest) &&
    selection?.actor?.kind === "human" &&
    selection.runId === priorRunId &&
    selection.externalRefs?.length === 1 &&
    selection.externalRefs[0].startsWith("mimic-local-revision-selection:") &&
    same(selection.ref, ref) &&
    same(revisionBase?.ref, ref) &&
    revisionBase?.sourceRunId === priorRunId &&
    revisionBase?.selectionId === selection.id &&
    s10?.intent === "revise" &&
    s10.targetArtifactId === ref.artifactId &&
    same(s10.revisionBase, revisionBase) &&
    s10.inputs?.optional?.some(
      (input: { name?: string; refs?: unknown[] }) =>
        input.name === "prior-direction" && same(input.refs, [ref]),
    ) &&
    (await frozenRunInputsSha256(workspace, priorRunId, packages)) ===
      priorInputsSha256
  );
}

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
          decision_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          approved_at INTEGER NOT NULL, revoked_at INTEGER,
          reference_sha256 TEXT, continuation_of TEXT
        );
        CREATE TABLE IF NOT EXISTS consumed (
          grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
          decision_id TEXT NOT NULL UNIQUE, consumed_at INTEGER NOT NULL,
          PRIMARY KEY (grant_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS delegated_grants (
          grant_id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
          source_thread_id TEXT NOT NULL, context_message_id TEXT NOT NULL,
          approval_message_id TEXT NOT NULL, approver_id TEXT NOT NULL,
          delegate_id TEXT NOT NULL, recorded_by TEXT NOT NULL,
          evidence_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rejected_sessions (
          grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL, checkpoint_sha256 TEXT NOT NULL,
          PRIMARY KEY (grant_id, session_id)
        );
      `);
      const schema = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'grants'",
        )
        .get() as { sql: string };
      if (/decision_id TEXT NOT NULL UNIQUE/i.test(schema.sql)) {
        // Existing grants and consumption receipts must survive the one-to-many
        // decision migration. SQLite cannot drop a column UNIQUE constraint.
        database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
        try {
          database.exec(`
            CREATE TABLE grants_v2 (
              id TEXT PRIMARY KEY, workspace TEXT NOT NULL, run_id TEXT NOT NULL,
              model TEXT NOT NULL, executable TEXT NOT NULL,
              max_calls INTEGER NOT NULL, expires_at INTEGER NOT NULL,
              inputs_sha256 TEXT NOT NULL,
              decision_id TEXT NOT NULL, actor_id TEXT NOT NULL,
              approved_at INTEGER NOT NULL, revoked_at INTEGER,
              reference_sha256 TEXT, continuation_of TEXT
            );
            INSERT INTO grants_v2
              (id, workspace, run_id, model, executable, max_calls, expires_at,
               inputs_sha256, decision_id, actor_id, approved_at, revoked_at)
            SELECT id, workspace, run_id, model, executable, max_calls, expires_at,
                   inputs_sha256, decision_id, actor_id, approved_at, revoked_at
            FROM grants;
            DROP TABLE grants;
            ALTER TABLE grants_v2 RENAME TO grants;
          `);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          database.exec("PRAGMA foreign_keys = ON");
        }
        if (database.prepare("PRAGMA foreign_key_check").get())
          throw Error("Authorization migration broke a receipt reference");
      }
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS grants_decision_scope
        ON grants(decision_id, workspace, run_id, inputs_sha256);
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
    const frozen = await this.freeze(scope);
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
    return this.persist(frozen, decision);
  }

  async recordDelegated(
    scope: RunCreditScope,
    source: DelegatedCreditEvidence,
  ): Promise<string> {
    if (!source?.attestedScope)
      throw Error("Delegation evidence does not bind this Run scope");
    const evidence: DelegatedCreditEvidence = Object.freeze({
      sourceThreadId: source.sourceThreadId,
      requestMessageId: source.requestMessageId,
      requestText: source.requestText,
      delegationMessageId: source.delegationMessageId,
      delegationText: source.delegationText,
      contextMessageId: source.contextMessageId,
      contextText: source.contextText,
      approvalMessageId: source.approvalMessageId,
      approvalText: source.approvalText,
      approverId: source.approverId,
      delegateId: source.delegateId,
      recordedBy: source.recordedBy,
      approvedAt: source.approvedAt,
      approvalTimePrecision: source.approvalTimePrecision,
      continuation: source.continuation
        ? Object.freeze({
            priorGrantId: source.continuation.priorGrantId,
            referenceSha256: source.continuation.referenceSha256,
            changeSummary: source.continuation.changeSummary,
            kind: source.continuation.kind,
            rejectedSessionId: source.continuation.rejectedSessionId,
          })
        : undefined,
      attestedScope: Object.freeze({
        workspace: source.attestedScope.workspace,
        runId: source.attestedScope.runId,
        model: source.attestedScope.model,
        executable: source.attestedScope.executable,
        maxCalls: source.attestedScope.maxCalls,
        durationMinutes: source.attestedScope.durationMinutes,
        inputsSha256: source.attestedScope.inputsSha256,
      }),
    });
    const frozen = await this.freeze(scope);
    const now = Date.now();
    const attested = evidence.attestedScope;
    if (
      ![
        evidence.sourceThreadId,
        evidence.requestMessageId,
        evidence.delegationMessageId,
        evidence.contextMessageId,
        evidence.approvalMessageId,
        evidence.approverId,
        evidence.delegateId,
        evidence.recordedBy,
      ].every(validOpaqueId) ||
      !validEvidenceText(evidence.requestText) ||
      !validEvidenceText(evidence.delegationText) ||
      !validEvidenceText(evidence.contextText) ||
      !validEvidenceText(evidence.approvalText) ||
      !explicitCreditApproval(evidence.approvalText) ||
      new Set([
        evidence.requestMessageId,
        evidence.delegationMessageId,
        evidence.contextMessageId,
        evidence.approvalMessageId,
      ]).size !== 4 ||
      evidence.approverId === evidence.delegateId ||
      evidence.recordedBy !== evidence.delegateId ||
      !Number.isSafeInteger(evidence.approvedAt) ||
      !["minute", "millisecond"].includes(evidence.approvalTimePrecision) ||
      (evidence.approvalTimePrecision === "minute" &&
        evidence.approvedAt % 60_000 !== 0) ||
      evidence.approvedAt > now ||
      evidence.approvedAt < now - day ||
      attested.workspace !== frozen.workspace ||
      attested.runId !== frozen.runId ||
      attested.model !== frozen.model ||
      attested.executable !== frozen.executable ||
      attested.maxCalls !== frozen.maxCalls ||
      attested.inputsSha256 !== frozen.inputsSha256 ||
      !Number.isSafeInteger(attested.durationMinutes) ||
      attested.durationMinutes < 1 ||
      attested.durationMinutes > 1440 ||
      frozen.expiresAt !==
        evidence.approvedAt + attested.durationMinutes * 60_000
    )
      throw Error("Delegation evidence does not bind this Run scope");
    let rejectedCheckpointDigest: string | undefined;
    if (evidence.continuation) {
      const continuation = evidence.continuation;
      if (
        evidence.approvalText.trim() !== "それならどれだけ使ってもいいよ" ||
        !/^grant_[A-Za-z0-9_-]+$/.test(continuation.priorGrantId) ||
        !/^sha256:[a-f0-9]{64}$/.test(continuation.referenceSha256) ||
        !validEvidenceText(continuation.changeSummary) ||
        (await referenceDigest(frozen.workspace)) !==
          continuation.referenceSha256
      )
        throw Error("Delegation continuation does not bind its references");
      const database = await this.database(frozen.workspace);
      let priorScope:
        Pick<StoredGrant, "workspace" | "run_id" | "inputs_sha256"> | undefined;
      try {
        priorScope = database
          .prepare(
            "SELECT workspace, run_id, inputs_sha256 FROM grants WHERE id = ?",
          )
          .get(continuation.priorGrantId) as typeof priorScope;
      } finally {
        database.close();
      }
      if (
        !priorScope ||
        !(continuation.kind === "selected-revision"
          ? priorScope.workspace === frozen.workspace &&
            (await selectedRevisionOnly(
              frozen.workspace,
              priorScope.run_id,
              frozen.runId,
              priorScope.inputs_sha256,
              frozen.packages,
            ))
          : continuation.kind === "same-run-retry"
            ? priorScope.workspace === frozen.workspace &&
              priorScope.run_id === frozen.runId &&
              priorScope.inputs_sha256 === frozen.inputsSha256 &&
              frozen.maxCalls === 1
            : continuation.kind === undefined &&
              (await addedReferencesOnly(
                priorScope.workspace,
                frozen.workspace,
                priorScope.run_id,
                frozen.runId,
                priorScope.inputs_sha256,
                frozen.packages,
              )))
      )
        throw Error(
          "Continuation changes more than the permitted guided Run inputs",
        );
      if (continuation.kind === "same-run-retry") {
        if (
          !/^session_[A-Za-z0-9_-]+$/.test(continuation.rejectedSessionId ?? "")
        )
          throw Error("Same-Run retry requires an exact rejected session ID");
        const checkpoint = await new FileSessionStore(frozen.workspace).read(
          continuation.rejectedSessionId!,
        );
        const tasks = Object.values(checkpoint?.tasks ?? {});
        if (
          checkpoint?.binding.runId !== frozen.runId ||
          checkpoint?.sessionId !== continuation.rejectedSessionId ||
          checkpoint.status !== "stopped" ||
          checkpoint.stop !== "candidate-rejected" ||
          checkpoint.executionPolicy !==
            "authorized-existing-credit-risk-once" ||
          checkpoint.generationCount !== 1 ||
          tasks.length !== 1 ||
          tasks[0]?.phase !== "rejected" ||
          tasks[0].staticFailure?.candidate !== true
        )
          throw Error(
            "Same-Run retry lacks a saved static candidate rejection",
          );
        rejectedCheckpointDigest = sessionDigest(checkpoint);
      }
    }
    // This ID is stable across attempts and independent of the operator's text.
    const decisionId = `delegated_${digest(
      JSON.stringify([
        evidence.sourceThreadId,
        evidence.approvalMessageId,
        ...(evidence.continuation?.kind === "same-run-retry"
          ? ["same-run-retry", evidence.continuation.priorGrantId]
          : []),
      ]),
    )}`;
    return this.persist(
      frozen,
      {
        decisionId,
        actorId: evidence.approverId,
        approvedAt: evidence.approvedAt,
      },
      evidence,
      evidence.continuation,
      rejectedCheckpointDigest,
    );
  }

  /** Record the in-process result of the trusted one-call host entry. A
   * workspace checkpoint alone is never proof that a paid call was rejected. */
  async recordAuthorizedCandidateRejection(
    grantId: string,
    workspace: string,
    result: SessionCheckpoint,
  ): Promise<void> {
    if (
      result.status !== "stopped" ||
      result.stop !== "candidate-rejected" ||
      result.executionPolicy !== "authorized-existing-credit-risk-once" ||
      result.generationCount !== 1 ||
      Object.values(result.tasks).length !== 1 ||
      Object.values(result.tasks)[0]?.phase !== "rejected" ||
      Object.values(result.tasks)[0]?.staticFailure?.candidate !== true
    )
      return;
    const root = await realpath(workspace);
    const database = await this.database(root);
    try {
      this.transaction(database, () => {
        const grant = database
          .prepare("SELECT workspace, run_id FROM grants WHERE id = ?")
          .get(grantId) as { workspace: string; run_id: string } | undefined;
        if (
          grant?.workspace !== root ||
          grant.run_id !== result.binding.runId ||
          !database
            .prepare(
              "SELECT 1 FROM consumed WHERE grant_id = ? AND request_id = ?",
            )
            .get(grantId, `${result.sessionId}-1`)
        )
          throw Error("Rejected session is not bound to the spent grant");
        database
          .prepare(
            "INSERT OR IGNORE INTO rejected_sessions (grant_id, session_id, checkpoint_sha256) VALUES (?, ?, ?)",
          )
          .run(grantId, result.sessionId, sessionDigest(result));
      });
    } finally {
      database.close();
    }
  }

  private async freeze(scope: RunCreditScope): Promise<FrozenRunCreditScope> {
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
    return Object.freeze({
      ...scope,
      workspace,
      executable,
      packages,
      inputsSha256,
    });
  }

  private async persist(
    frozen: FrozenRunCreditScope,
    decision: HumanCreditDecision,
    delegated?: DelegatedCreditEvidence,
    continuation?: NonNullable<DelegatedCreditEvidence["continuation"]>,
    rejectedCheckpointDigest?: string,
  ): Promise<string> {
    const decidedAt = Date.now();
    if (frozen.expiresAt <= decidedAt)
      throw Error("Run authorization expired before recording");
    const database = await this.database(frozen.workspace);
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
        const prior = continuation
          ? (database
              .prepare("SELECT * FROM grants WHERE id = ?")
              .get(continuation.priorGrantId) as
              | (StoredGrant & {
                  decision_id: string;
                  actor_id: string;
                  id: string;
                })
              | undefined)
          : undefined;
        if (continuation) {
          const stored = prior
            ? (database
                .prepare(
                  "SELECT evidence_json FROM delegated_grants WHERE grant_id = ?",
                )
                .get(prior.id) as { evidence_json: string } | undefined)
            : undefined;
          const oldEvidence = stored
            ? (JSON.parse(stored.evidence_json) as DelegatedCreditEvidence)
            : undefined;
          const identity = (value: DelegatedCreditEvidence) =>
            JSON.stringify([
              value.sourceThreadId,
              value.requestMessageId,
              value.requestText,
              value.delegationMessageId,
              value.delegationText,
              value.contextMessageId,
              value.contextText,
              value.approvalMessageId,
              value.approvalText,
              value.approverId,
              value.delegateId,
              value.recordedBy,
              value.approvedAt,
              value.approvalTimePrecision,
            ]);
          if (
            !delegated ||
            !prior ||
            !oldEvidence ||
            (prior.decision_id !== decision.decisionId &&
              continuation.kind !== "same-run-retry") ||
            prior.actor_id !== decision.actorId ||
            prior.revoked_at !== null ||
            prior.expires_at <= Date.now() ||
            frozen.expiresAt > prior.expires_at ||
            prior.model !== frozen.model ||
            prior.executable !== frozen.executable ||
            prior.max_calls < frozen.maxCalls ||
            (prior.run_id === frozen.runId &&
              continuation.kind !== "same-run-retry") ||
            oldEvidence.approvalText.trim() !==
              "それならどれだけ使ってもいいよ" ||
            identity(oldEvidence) !== identity(delegated) ||
            (continuation.kind === "same-run-retry" &&
              oldEvidence.continuation?.kind === "same-run-retry")
          )
            throw Error(
              "Delegation continuation differs from the original decision",
            );
          if (continuation.kind === "same-run-retry") {
            const receipt = database
              .prepare(
                "SELECT checkpoint_sha256 FROM rejected_sessions WHERE grant_id = ? AND session_id = ?",
              )
              .get(prior.id, continuation.rejectedSessionId!) as
              { checkpoint_sha256: string } | undefined;
            if (
              !receipt ||
              receipt.checkpoint_sha256 !== rejectedCheckpointDigest
            )
              throw Error("Same-Run retry lacks a host-recorded rejection");
            if (
              !database
                .prepare(
                  "SELECT 1 FROM consumed WHERE grant_id = ? AND request_id = ?",
                )
                .get(prior.id, `${continuation.rejectedSessionId}-1`)
            )
              throw Error("Rejected session did not consume the prior grant");
            const used = database
              .prepare(
                "SELECT COUNT(*) AS count FROM consumed WHERE grant_id = ?",
              )
              .get(prior.id) as { count: number };
            const existingTopup = database
              .prepare(
                "SELECT id FROM grants WHERE continuation_of = ? AND run_id = ?",
              )
              .get(prior.id, prior.run_id);
            if (used.count !== prior.max_calls || existingTopup)
              throw Error(
                "Same-Run retry requires one exhausted grant without an earlier top-up",
              );
          }
          if (
            continuation.kind !== "same-run-retry" &&
            database
              .prepare(
                "SELECT id FROM grants WHERE decision_id = ? AND workspace = ? AND run_id = ?",
              )
              .get(decision.decisionId, frozen.workspace, frozen.runId)
          )
            throw Error(
              "Human decision has already been recorded for this Run",
            );
        } else if (
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
           decision_id, actor_id, approved_at, reference_sha256, continuation_of)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            frozen.workspace,
            frozen.runId,
            frozen.model,
            frozen.executable,
            frozen.maxCalls,
            frozen.expiresAt,
            frozen.inputsSha256,
            decision.decisionId,
            decision.actorId,
            decision.approvedAt,
            continuation?.referenceSha256 ?? null,
            continuation?.priorGrantId ?? null,
          );
        if (delegated)
          database
            .prepare(
              `
            INSERT INTO delegated_grants
            (grant_id, source_thread_id, context_message_id, approval_message_id,
             approver_id, delegate_id, recorded_by, evidence_json, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            )
            .run(
              id,
              delegated.sourceThreadId,
              delegated.contextMessageId,
              delegated.approvalMessageId,
              delegated.approverId,
              delegated.delegateId,
              delegated.recordedBy,
              JSON.stringify(delegated),
              decidedAt,
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
        if (
          !database
            .prepare("SELECT 1 FROM grants WHERE id = ? AND workspace = ?")
            .get(grantId, canonicalWorkspace)
        )
          throw Error("Unknown grant");
        const result = database
          .prepare(
            `
          WITH RECURSIVE descendants(id) AS (
            SELECT id FROM grants WHERE id = ? AND workspace = ?
            UNION ALL
            SELECT child.id FROM grants child
            JOIN descendants parent ON child.continuation_of = parent.id
          )
          UPDATE grants SET revoked_at = COALESCE(revoked_at, ?)
          WHERE id IN (SELECT id FROM descendants)
        `,
          )
          .run(grantId, canonicalWorkspace, Date.now());
        if (result.changes < 1) throw Error("Unknown grant");
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
        SELECT workspace, executable, expires_at, revoked_at, reference_sha256
        FROM grants WHERE id = ?
      `,
        )
        .get(grantId) as
        | Pick<
            StoredGrant,
            | "workspace"
            | "executable"
            | "expires_at"
            | "revoked_at"
            | "reference_sha256"
          >
        | undefined;
      if (
        !grant ||
        grant.workspace !== canonicalWorkspace ||
        grant.revoked_at !== null ||
        grant.expires_at <= Date.now()
      )
        throw Error("No current authorization for this workspace");
      if (
        grant.reference_sha256 &&
        (await referenceDigest(canonicalWorkspace)) !== grant.reference_sha256
      )
        throw Error("No current authorization for this workspace");
      return grant.executable;
    } finally {
      database.close();
    }
  }

  /** Read-only check before a new session is journaled; port() still enforces at use. */
  async availableForRun(
    grantId: string,
    workspace: string,
    runId: string,
    model: string,
    packages: Readonly<Record<string, string>>,
  ): Promise<string> {
    const canonicalWorkspace = await realpath(workspace);
    const inputsSha256 = await frozenRunInputsSha256(
      canonicalWorkspace,
      runId,
      packages,
    );
    const database = await this.database(canonicalWorkspace);
    try {
      const grant = database
        .prepare(
          `SELECT workspace, run_id, model, executable, max_calls, expires_at,
          inputs_sha256, revoked_at, reference_sha256, continuation_of
          FROM grants WHERE id = ?`,
        )
        .get(grantId) as StoredGrant | undefined;
      const consumed = database
        .prepare("SELECT COUNT(*) AS count FROM consumed WHERE grant_id = ?")
        .get(grantId) as { count: number };
      if (
        !grant ||
        grant.workspace !== canonicalWorkspace ||
        grant.run_id !== runId ||
        grant.model !== model ||
        grant.inputs_sha256 !== inputsSha256 ||
        grant.revoked_at !== null ||
        grant.expires_at <= Date.now() ||
        consumed.count >= grant.max_calls
      )
        throw Error("No current authorization for this execution");
      if (
        grant.reference_sha256 &&
        (await referenceDigest(canonicalWorkspace)) !== grant.reference_sha256
      )
        throw Error("No current authorization for this execution");
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
        const currentReferenceSha256 = await referenceDigest(workspace).catch(
          () => null,
        );
        const database = await this.database(workspace);
        try {
          return this.transaction(database, () => {
            if (signal?.aborted) throw Error("Authorization cancelled");
            const grant = database
              .prepare(
                `
              SELECT workspace, run_id, model, executable, max_calls, expires_at,
                     inputs_sha256, revoked_at, reference_sha256, continuation_of
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
              (grant.reference_sha256 !== null &&
                grant.reference_sha256 !== currentReferenceSha256) ||
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
