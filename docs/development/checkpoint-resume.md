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
  { maxGenerations: 4, timeoutMs: 120_000, maxOutputBytes: 1_000_000 },
);
await session.advance();
await session.inspect(); // read-only, including when no checkpoint exists
await session.advance({ resume: true }); // explicit; never an automatic retry
```

The factory reconstructs prompts from the saved plan, official static Skill text, exact authority-readable inputs, declared evidence, and output schemas. Model output is an untrusted JSON Skill-work envelope. The static CLI validates it with `--package` and `--work`; `CliHost.executeSkill` is not used. Existing immutable work reservations and revision-request handoffs remain in effect. Local confirmation receipts use the static CLI's verifier. Signed operator history without a trusted host is unsupported and fails closed. The loop cannot approve a candidate or create a confirmation.

For a newly emitted artifact, the model may omit `lockDigest` or use `"host-derived"` in its output reference and matching proposal/request reference. Before immutable save, Mimic computes Core's canonical `artifactDigest` from the unchanged artifact and fills only those fresh references. Concrete hashes must already match; a wrong `meta.contentDigest` is rejected, never repaired. Duplicate identities and attempts to replace an exact input fail. Input references, dependencies, revision-request sources and affected locks retain their supplied exact hashes. The original model string is saved separately in private immutable `agent-work/*.raw.json` metadata with its digest and the prepared work digest. This preparation grants no approval; ordinary static submission still validates schemas, origin, exact bindings and Core authority.

An invalid generated envelope is retained as `*.rejected.raw.json` and stops as `candidate-rejected` with reason `preparation`. When the static CLI explicitly identifies candidate validation failure and no immutable submission marker exists, the checkpoint retains that work and stops as `candidate-rejected` with reason `static-validation`. Other CLI failures, including workspace configuration errors, preserve the saved candidate for retry after repair. Neither candidate rejection is automatically retried. A fresh, explicitly authorized generation may replace the rejected candidate while preserving its original bytes. If a submission marker exists or its absence cannot be established, the stop remains `unknown-outcome` and requires reconciliation; a candidate is never silently regenerated across that boundary.

## Durable state and safe boundaries

Checkpoint files contain Run/plan/provider/model bindings, input/package/context digests and package version, exact input/output references, private work references, generation count, and stop/question IDs. Prompts, stream fragments, authentication credentials and native session IDs are not checkpoint fields. Completed work is checked against the sealed static reservation, its exact saved work and authoritative task-completion event, and authority-readable output locks. It is never regenerated on resume. Accepted work followed by a lost response is reconciled through identical static submission before another model call.

Work and invocation files are immutable, private workspace metadata. They contain user content and generated candidate/question data; callers must treat them as private. Credential/runtime metadata paths and `.env` variants cannot be declared as evidence. Root-relative paths, ancestor links, and malformed task IDs are rejected before writes. Checkpoints are atomically replaced and synced with mode `0600`; metadata directories are created with mode `0700`. Hashes detect damage; they do not grant Core authority.

Optional task diagnostics record a fixed startup stage, metadata versus generation process, local spawn/settlement, exit code or known signal/error-code bucket, bounded stdout/stderr byte counts, and known decoder flags/failure categories. They never contain raw streams, error messages, prompts, paths, argv, environment, identifiers, token usage or stream hashes. Closed-schema projection at executor containment, checkpoint persistence/read and inspection rejects extra keys, accessors and invalid values. Older checkpoints without diagnostics remain readable. Pending startup can record its last known stage without claiming a process was spawned; a later stage clears observations from earlier metadata probes.

For a rejected JSON event, optional `decoder.rejectedShape` records only fixed event/item type buckets, known item-key presence flags and unknown-key counts saturated at 255. Unknown names become `other`; neither key names nor values are saved. Checkpoints predating this optional field remain readable.

The [official Codex 0.160.0 JSONL processor](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs) emits warnings and deprecations as `item.completed` with an `error` item, including before `turn.started`. Mimic accepts only the closed native warning shape after thread start and reserves its unique item ID; warnings supply no turn, candidate or completion. The same wire shape carries model rerouting. Its official prefix (`model rerouted:` followed by a space) stops as `unsupported`; recognized quota/authentication notices also stop with their fixed reason. These policy stops terminate the process group and retain their reason through settlement. Unknown/tool events, malformed warning shapes, ID collisions, missing turn/output/usage/terminal, trailing events and nonzero completion remain rejected.

Synthetic fixtures proved that the earlier decoder rejected this official warning shape before and during a turn. A real attempt observed thread start followed by a protocol failure before the decoder observed turn start, but did not retain the rejected event. The fixture incompatibility is established; the exact event responsible for that past attempt remains unproven. No additional real model call is part of this repair.

`backendReach` remains `unknown`, including after local thread/turn events. A reservation count of one is an attempted generation reservation, and session CLI exit zero is completion of the CLI operation, not proof of a native exit or model success. A short failed attempt without retained native/decoder observations cannot retrospectively establish its exact cause or backend call count. New diagnostics are prospective; they cannot recover previously discarded evidence. An exhausted one-call authorization remains exhausted even if a prelaunch failure is later identified. A future actual generation needs a fresh explicit user authorization. Candidate acceptance, exact readback and process-resume acceptance require their own evidence.

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

## Explicit one-call credit-risk authorization

`runAuthorizedSessionOnce(configPath, outputSchemaPath, decisionPort)` is a trusted coordinator entry separate from ordinary `runSessionCli`. Use it only after the user actually authorizes one bounded call with possible consumption of existing credits. This authorization does not establish subscription-only billing enforcement or permit API billing, purchases, auto-reload, another model, approval or Core commit. There is no JSON setting, CLI flag or decoded work field that authorizes it.

The host's `CodexCreditRiskDecisionPort.consumeUserDecision` must atomically consume its actual decision receipt in trusted storage, including across processes. The adapter binds an opaque, short-lived permit to the canonical workspace, request ID, fixed model and prompt digest. Creating the session dispatch issues no permit and invokes no official command; the decision is consumed only when the session attempts its first generation. Launch failure, cancellation, timeout and an unknown outcome do not reissue that permission. The host must not infer approval from an absent answer or manufacture a receipt.

The entry retains the existing private checkpoint, frozen Core inputs, process lease, lifecycle containment and static submission path. It always permits at most one generation, even if the ordinary configuration asks for more. The checkpoint explicitly records `executionPolicy: "authorized-existing-credit-risk-once"`; it does not change entitlement to confirmed. Accepted work is reconciled on resume without another decision or generation. Changing between ordinary subscription-only dispatch and this explicit exception requires a new session; inspection remains read-only. A fresh trusted dispatch cannot bypass the recorded generation count or a live process lease.

The output schema is an explicit workspace-contained regular file supplied by the trusted host. Core still validates generated work and artifact schemas through static submission. A small raw JSON connection smoke can use the adapter's authorized method without claiming Core acceptance; session generation requires the full static work envelope. Contract tests use mocked/fake runtime data with real Core and do not authorize or prove a real model call.

The configured session deadline also bounds generation (default adapter bound 30 seconds, configured maximum 120 seconds). Metadata commands retain their separate 10-second maximum; extending a generation deadline does not extend those metadata probes or permit another generation.
