# Mimic checkpoint and resume

`AgentSession` is the outer execution loop, separate from a Core Run and an official provider conversation. `createWorkspaceSessionPorts` connects a saved Run plan, Core routing, static Skill packages, exact artifact inputs, evidence files, the injected official executor contract, file-backed `submit`, and authority-checked readback. It requires an initialized workspace and Run, a task-to-package mapping, and an explicit model with subscription-only settings.

```ts
import {
  AgentSession,
  FileSessionStore,
} from "../../apps/cli/src/agent/session.js";
import { createWorkspaceSessionPorts } from "../../apps/cli/src/agent/session-workspace.js";

const ports = await createWorkspaceSessionPorts({
  workspace,
  runId,
  sessionId,
  packages: { task_system: "skills/s04" },
  settings: { provider: "codex", model, billingMode: "subscription-only" },
});
const session = new AgentSession(
  sessionId,
  new FileSessionStore(workspace),
  ports,
  officialExecutor,
  { maxGenerations: 4, timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
);
await session.advance();
await session.inspect(); // read-only, including when no checkpoint exists
await session.advance({ resume: true }); // explicit; never an automatic retry
```

The factory reconstructs prompts from the saved plan, official static Skill text, exact authority-readable inputs, declared evidence, and output schemas. Model output is an untrusted JSON Skill-work envelope. The static CLI validates it with `--package` and `--work`; `CliHost.executeSkill` is not used. Existing immutable work reservations and revision-request handoffs remain in effect. Local confirmation receipts use the static CLI's verifier. Signed operator history without a trusted host is unsupported and fails closed. The loop cannot approve a candidate or create a confirmation.

## Durable state and safe boundaries

Checkpoint files contain Run/plan/provider/model bindings, input/package/context digests and package version, exact input/output references, private work references, generation count, and stop/question IDs. Prompts, stream fragments, authentication credentials and native session IDs are not checkpoint fields. Completed work is checked against the sealed static reservation, its exact saved work and authoritative task-completion event, and authority-readable output locks. It is never regenerated on resume. Accepted work followed by a lost response is reconciled through identical static submission before another model call.

Work and invocation files are immutable, private workspace metadata. They contain user content and generated candidate/question data; callers must treat them as private. Credential/runtime metadata paths and `.env` variants cannot be declared as evidence. Root-relative paths, ancestor links, and malformed task IDs are rejected before writes. Checkpoints are atomically replaced and synced with mode `0600`; metadata directories are created with mode `0700`. Hashes detect damage; they do not grant Core authority.

Independent runnable tasks continue when another candidate is review-ready. Approval stays a human boundary. Auth, quota, billing, unsupported capabilities, cancellation, timeout, unknown outcomes, questions, changed bindings and generation limits stop the loop. Each fresh call requires a confirmed entitled model and tool restriction capability. No auxiliary model, tool execution, billing fallback, backend switch, automatic retry or implicit login is added. Generation, elapsed execution and output size have explicit bounds.

An unresolved model start or cancellation retains the process-owned lock. A second session instance cannot dispatch a new generation while that lease exists, even with `reconciledUnknownOutcome: true`. Startup deadlines include executor discovery/start; late handles are cancelled. Timeout cancellation must settle and drain to a confirmed cancelled terminal state before its lease is released. `cancel()` requests termination; a successful method return alone does not prove that an official process has ended.

After a crashed owner exits, call `FileSessionStore.recoverAbandonedLock(sessionId)` explicitly. It verifies a same-host positive PID that no longer exists and serializes recovery. Live owners, PID reuse, foreign hosts, missing owner records and unknown permissions fail closed. Never remove a live lock to force resume. An incomplete owner/recovery record needs operator investigation; it is not an automatic-retry condition. Recovering a stale lock does not itself reconcile effects of a previously interrupted official call.

## Questions and changed inputs

A static `blocked` Skill result stops as `question`, preserving its immutable work and `unknowns`. Read-only inspection displays the Core blocker and those questions. An unchanged explicit resume reconciles the same blocked submission and remains stopped; it does not call the model, answer the question or grant approval. A question is generated data requiring human review, not authority.

Record an answer that changes the frozen plan, input or context in an explicit new task/Run and session with new exact bindings. Do not rewrite an old task plan, input lock, accepted revision or saved work. The old question remains inspectable. A new answer does not advance an old provisional upstream request: source approval publishes a new revision, so downstream tasks/requests require explicit rebinding. Generation already accepted in the old Run is preserved; only work required by the new Run is generated.

Resume reconstructs Mimic context and starts a **fresh official session**. It has no native conversation continuity, and ephemeral provider execution alone is not durable Mimic state. Native persistent provider resume is unnecessary for this minimum loop and remains a separate capability.

The production Codex model-only execution/billing path is still gated by its adapter's verified capabilities and entitlement. Contract and recovery tests use an explicitly fake executor with real Core/static CLI submission; they do not certify an account or spend credits. Actual official-model vertical acceptance remains pending those concrete runtime prerequisites.

## Runnable entry

After building, use `node apps/cli/dist/agent/session-main.js start --config <file>`. The regular JSON configuration has only absolute `workspace` and official Codex `executable` paths, `runId`, `sessionId`, a task-to-relative-package `packages` map, `model`, and optional `maxGenerations`, `timeoutMs`, and `maxOutputBytes`. The saved Core Run and static packages must already exist. The entry fixes Codex and subscription-only billing; it copies only approved native-login environment keys and has no custom executor, argv, credential or entitlement override.

Use `inspect --config <file>` for read-only state/questions without starting the official CLI. Use `resume --config <file>` only after resolving the displayed stop. `--reconciled-unknown-outcome` on resume is an explicit operator acknowledgment; it cannot bypass a live process lease, changed bindings, billing or tool capability gates. `recover-lock --config <file>` only recovers a proven dead same-host owner, with no inference. SIGINT/SIGTERM requests cancellation of a running session; cancellation uncertainty keeps its lease.

A recognized Codex installation with existing ChatGPT login currently reports `billing-unconfirmed` and launches no inference. Missing auth or incompatible runtime reports its distinct stop. Start/resume emit inspection JSON even when normally stopped; check `status` and `stop` rather than treating exit code zero as completed generation. Configuration/lock errors return code two with sanitized diagnostics. The real model path remains pending the adapter prerequisites above.
