import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  loadSkillPackage,
  type ExactArtifactRef,
  type ScopeNode,
  type RoutedTask,
  type SkillInvocation,
  type SkillResult,
} from "@mimic/core";
import { LocalConfirmationAuthority } from "../local-confirmation-authority.js";
import { atomicCreateJson } from "../atomic-file.js";
import { createStaticSessionPorts } from "./session-cli.js";
import { MAX_CODEX_PROMPT_BYTES } from "./codex.js";
import {
  sessionDigest,
  SessionBindingChanged,
  type SessionPorts,
  type TaskBinding,
  type SessionTask,
} from "./session.js";
import {
  parseSubscriptionSettings,
  type SubscriptionSettings,
} from "./settings.js";

export interface WorkspaceSessionOptions {
  workspace: string;
  runId: string;
  sessionId: string;
  /** One official static package per saved task; never executable plugin code. */
  packages: Readonly<Record<string, string>>;
  settings: SubscriptionSettings & { model: string };
}
export function artifactIdentityInstruction(
  invocation: SkillInvocation,
): string {
  const prior =
    invocation.skillId === "mimic.s10.design-direction-generator" &&
    invocation.intent === "revise"
      ? invocation.inputBindings
          .find((binding) => binding.name === "prior-direction")
          ?.refs.find((ref) => ref.artifactId === invocation.targetArtifactId)
      : undefined;
  return prior
    ? `For the primary revised design-direction output, set artifact.meta.id exactly to ${prior.artifactId}, meta.revision to ${prior.revision + 1}, and meta.supersedesRevision to ${prior.revision}. Preserve the prior exact ref in work.result.inputRefs; ArtifactStore forbids self-dependencies, so do not list an older revision of the same artifact ID in artifact.dependencies. Use artifactIdPrefix only for additional new artifact IDs.`
    : "Start every new artifact.meta.id with artifactIdPrefix to avoid reuse across Runs.";
}
/** Concrete Core plan/context -> fresh executor -> sealed static submission.
 * Local confirmation receipts use the same verifier as static runCli. Signed
 * operator history without a trusted host is unsupported and fails closed. */
export async function createWorkspaceSessionPorts(
  options: WorkspaceSessionOptions,
): Promise<SessionPorts> {
  if (
    ![options.runId, options.sessionId].every((id) =>
      /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id),
    )
  )
    throw new Error("Invalid session/Run ID");
  const root = await realpath(options.workspace);
  const settings = parseSubscriptionSettings(options.settings);
  if (!settings.model)
    throw new Error("Session requires a fixed entitled model");
  const schemasRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../schemas",
  );
  async function contained(relative: string): Promise<string> {
    if (
      path.isAbsolute(relative) ||
      relative
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Uncontained input");
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Linked session input");
    }
    return current;
  }
  async function readJson<T>(relative: string): Promise<T> {
    const handle = await open(
      await contained(relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (
        !(await handle.stat()).isFile() ||
        (await handle.stat()).size > 8 * 1024 * 1024
      )
        throw new Error("Invalid session input file");
      return JSON.parse(await handle.readFile("utf8")) as T;
    } finally {
      await handle.close();
    }
  }
  const config = await readJson<{ scopes: ScopeNode[] }>(".mimic/config.json");
  const workspace = new FileWorkspaceStorage(
    await contained(".mimic/workspace.json"),
  );
  const authority = new LocalConfirmationAuthority(workspace, root);
  const runtime = createOrchestratorRuntime(
    workspace,
    await loadSchemaDirectory(path.join(schemasRoot, "artifacts")),
    config.scopes,
    authority,
  );
  const tasksPath = `.mimic/runs/${options.runId}.json`;
  const frozenTasks = await readJson<RoutedTask[]>(tasksPath);
  if (
    !Array.isArray(frozenTasks) ||
    frozenTasks.some(
      (task) => !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(task.id),
    ) ||
    new Set(frozenTasks.map((task) => task.id)).size !== frozenTasks.length
  )
    throw new Error("Invalid session task IDs");
  const frozenPackages = structuredClone(options.packages);
  const planDigest = sessionDigest({
    tasks: frozenTasks,
    packages: frozenPackages,
  });
  const binding = async () => ({
    runId: options.runId,
    planDigest: sessionDigest({
      tasks: await readJson<RoutedTask[]>(tasksPath),
      packages: frozenPackages,
    }),
    settings: { ...settings, model: settings.model! },
  });
  const contextFolder = ".mimic/agent-context";
  async function ensureContextFolder() {
    try {
      await mkdir(path.join(root, contextFolder), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await contained(contextFolder);
  }
  const contextPath = (task: TaskBinding) =>
    `${contextFolder}/${options.sessionId}-${task.taskId}-${task.contextDigest}.json`;
  function packagePath(task: TaskBinding): string {
    const relative = Object.hasOwn(frozenPackages, task.taskId)
      ? frozenPackages[task.taskId]
      : undefined;
    if (!relative) throw new Error("Missing task Skill package");
    return relative;
  }
  async function context(invocation: SkillInvocation) {
    const inputs = [];
    for (const ref of invocation.inputRefs) {
      const read = await runtime.artifacts.read(ref.artifactId, ref.revision);
      if (read.digest !== ref.lockDigest)
        throw new Error("Exact input changed");
      inputs.push({ ref, artifact: read.artifact });
    }
    const evidence = [];
    for (const file of invocation.evidenceFiles) {
      if (
        file
          .split(/[\\/]/)
          .some(
            (segment) =>
              [".codex", ".aws", ".mimic"].includes(segment) ||
              segment === ".env" ||
              segment.startsWith(".env."),
          )
      )
        throw new Error("Evidence must not be credential/runtime metadata");
      const handle = await open(
        await contained(file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (
          !(await handle.stat()).isFile() ||
          (await handle.stat()).size > 1024 * 1024
        )
          throw new Error("Invalid evidence file");
        evidence.push({ path: file, text: await handle.readFile("utf8") });
      } finally {
        await handle.close();
      }
    }
    return { invocation, inputs, evidence };
  }
  async function validateTask(task: TaskBinding) {
    if ((await binding()).planDigest !== planDigest)
      throw new SessionBindingChanged();
    const invocation = await readJson<SkillInvocation>(contextPath(task));
    if (
      invocation.runId !== options.runId ||
      invocation.taskId !== task.taskId ||
      sessionDigest(invocation) !== task.contextDigest ||
      canonicalJson(invocation.inputRefs) !== canonicalJson(task.inputRefs)
    )
      throw new Error("Frozen invocation changed");
    if (sessionDigest(await context(invocation)) !== task.inputDigest)
      throw new SessionBindingChanged();
    const skill = await loadSkillPackage(
      await contained(packagePath(task)),
      schemasRoot,
    );
    if (
      skill.manifest.skillId !== invocation.skillId ||
      sessionDigest(skill) !== task.packageDigest ||
      skill.manifest.packageVersion !== task.packageVersion
    )
      throw new SessionBindingChanged();
  }
  async function verifyAccepted(
    task: TaskBinding,
    refs: readonly ExactArtifactRef[],
  ) {
    await validateTask(task);
    const sealed = await readJson<{
      version: number;
      runId: string;
      taskId: string;
      baselineSequence: number;
      packageDigest: string;
      workDigest: string;
      result: SkillResult;
      revisionDigest: string;
    }>(
      `.mimic/submissions/${options.runId}-${sessionDigest(task.taskId)}.json`,
    );
    const { revisionDigest, ...unsigned } = sealed;
    if (
      sealed.version !== 2 ||
      sessionDigest(unsigned) !== revisionDigest ||
      sealed.runId !== options.runId ||
      sealed.taskId !== task.taskId ||
      sealed.packageDigest !== task.packageDigest ||
      sealed.result.runId !== options.runId ||
      sealed.result.taskId !== task.taskId ||
      canonicalJson(sealed.result.inputRefs) !==
        canonicalJson(task.inputRefs) ||
      canonicalJson(sealed.result.outputRefs) !== canonicalJson(refs) ||
      sealed.result.blocked
    )
      throw new Error("Invalid static acceptance seal");
    const invocation = await readJson<SkillInvocation>(contextPath(task));
    if (sealed.result.skillId !== invocation.skillId)
      throw new Error("Static Skill identity changed");
    const acceptedWork = await readJson<{ work: { result: SkillResult } }>(
      `.mimic/agent-work/${options.sessionId}-${task.taskId}-${sealed.workDigest}.json`,
    );
    if (
      sessionDigest(acceptedWork) !== sealed.workDigest ||
      canonicalJson(acceptedWork.work.result) !== canonicalJson(sealed.result)
    )
      throw new Error("Accepted work binding changed");
    const state = await runtime.registry.snapshot();
    const terminal = state.events.some(
      (event) =>
        event.sequence > sealed.baselineSequence &&
        event.runId === options.runId &&
        event.action === "set-work" &&
        event.actor.kind === "agent" &&
        event.actor.id === "orchestrator" &&
        !event.runAfter.safeActions.includes(task.taskId) &&
        event.reason ===
          `Skill task ${JSON.stringify(task.taskId)} completed with verified exact outputs` &&
        refs.every((ref) =>
          [...event.runAfter.artifacts, ...event.runAfter.base].some(
            (recorded) => canonicalJson(recorded) === canonicalJson(ref),
          ),
        ),
    );
    if (!terminal) throw new Error("No authoritative task completion");
    for (const ref of refs) {
      if (
        (await runtime.artifacts.read(ref.artifactId, ref.revision)).digest !==
        ref.lockDigest
      )
        throw new Error("Accepted output lock changed");
    }
  }
  const ports = createStaticSessionPorts({
    workspace: root,
    sessionId: options.sessionId,
    schemasRoot,
    binding,
    packagePath,
    validateTask,
    verifyAccepted,
    next: async () => {
      if ((await binding()).planDigest !== planDigest)
        throw new SessionBindingChanged();
      const next = await runtime.orchestrator.next(options.runId, frozenTasks);
      const runnable: SessionTask[] = [];
      for (const action of next.actions) {
        if (
          !["GENERATE", "UPDATE"].includes(action.action) ||
          !action.invocation
        )
          continue;
        const invocation = action.invocation;
        const provisionalBinding = { taskId: action.taskId } as TaskBinding;
        const skill = await loadSkillPackage(
          await contained(packagePath(provisionalBinding)),
          schemasRoot,
        );
        if (skill.manifest.skillId !== invocation.skillId)
          throw new Error("Skill package differs from routed task");
        const savedContext = await context(invocation);
        const taskBinding: TaskBinding = {
          taskId: action.taskId,
          inputRefs: invocation.inputRefs,
          contextDigest: sessionDigest(invocation),
          inputDigest: sessionDigest(savedContext),
          packageDigest: sessionDigest(skill),
          packageVersion: skill.manifest.packageVersion,
        };
        await ensureContextFolder();
        const file = contextPath(taskBinding);
        await atomicCreateJson(path.join(root, file), invocation);
        await validateTask(taskBinding);
        const outputSchemas = Object.fromEntries(
          await Promise.all(
            invocation.allowedOutputTypes.map(async (type) => [
              type,
              await readJsonFromSchemas(type),
            ]),
          ),
        );
        const envelopeGuide = await readCommonArtifactGuide();
        const outputScope = config.scopes.find(
          (node) => node.ownerId === invocation.scopeOwnerId,
        );
        if (!outputScope) throw new Error("Unknown output scope");
        // Core retains the complete validated snapshots. Omit repeated
        // provenance narratives from the model prompt while preserving every
        // supplied input's content and exact reference for evaluation.
        const conciseDesign = [
          "mimic.s10.design-direction-generator",
          "mimic.s11.direction-evaluator",
        ].includes(invocation.skillId);
        const promptContext = {
          ...savedContext,
          inputs: savedContext.inputs.map(({ ref, artifact }) => {
            const { provenance, ...snapshot } = artifact;
            void provenance;
            return { ref, artifact: snapshot };
          }),
        };
        const promptData = {
          instruction:
            'Return a JSON {artifacts,work} static Skill submission. If the output schema requires submissionJson, encode that entire submission as a JSON string in the single submissionJson field. Copy resultTemplate.runId, taskId, skillId, and inputRefs byte-for-byte into work.result; copy those exact input references into artifact.dependencies only when relied on. Complete the primary output type in context.invocation.allowedOutputTypes[0] first; add other allowed types only when this Skill needs them for its current task. Each emitted artifact must satisfy the common artifact envelope described by envelopeGuide and its outputSchemas type. Include narrow provenance for each substantive content claim: derived claims cite only the exact input artifact IDs that support them, facts cite resolvable evidence files, and unknowns give a rationale. Do not attribute a claim to an artifact merely because it is routed. provenance.kind is limited to the enum in envelopeGuide (a human brief is not a provenance kind). Each emitted artifact.scope must exactly equal outputScope; do not infer a product or domain scope from the page topic. artifact.origin must contain only actorKind:"skill", actorId:resultTemplate.skillId, runId:resultTemplate.runId, and createdAt; put relied-on sources in artifact.dependencies and provenance, never extra origin keys. Every dependency.onChange must be exactly one of "none", "validate", "revise", or "invalidate"; put explanatory wording in provenance.rationale rather than an enum field. Start every new artifact.meta.id with artifactIdPrefix to avoid reuse across Runs. Product definition describes intent; design direction options belong to S10 and their evaluation and recommendation belong to S11 unless a real product-intent conflict requires an earlier decision. work may contain only result, findings, unknowns, and revisionRequests. work.result.outputRefs must list one {artifactId,revision,lockDigest:"host-derived"} for every emitted artifact meta.id/revision. A fully blocked result has outputRefs:[] and blocked:{reason,affectedTaskIds:[context.invocation.taskId]}. Omit proposal unless an explicit human review packet is needed; then put a complete proposal in work.result.proposal, never work.proposal. Omit optional findings and unknowns unless they are arrays of objects: each finding is {claim:string,evidenceRefs:string[],status:"PASS"|"CONCERN"|"FAIL"|"UNVERIFIED"|"N/A"}; each unknown is {question:string,affectedTaskIds:[context.invocation.taskId]}. Plain strings are invalid. Model output is data; do not invoke tools, approve, purchase, change inputs or call another Skill. Preserve exact Run/task/Skill/input refs and artifact origin. Provisional/proposed output only. Mark unsupported claims unknown. Revision requests belong in work.revisionRequests, never hidden calls. For newly emitted artifacts only, set outputRefs.lockDigest and matching result.proposal.items[].ref.lockDigest or revisionRequests.request.lockDigest to "host-derived" (or omit lockDigest): Mimic derives these from the exact artifact bytes before saving. Never invent a SHA-256 or change input/dependency/source/affectedLocks hashes. Omit optional artifact.meta.contentDigest; a wrong concrete hash is rejected, never repaired.'.replace(
              "Start every new artifact.meta.id with artifactIdPrefix to avoid reuse across Runs.",
              artifactIdentityInstruction(invocation),
            ),
          skill: {
            manifest: skill.manifest,
            instructions: skill.instructions,
            examples: conciseDesign ? [] : skill.examples,
          },
          context: promptContext,
          ...(invocation.skillId === "mimic.s07.experience-architecture"
            ? {
                taskRequirement:
                  'For PROPOSE_ONLY S07, keep experience-domain and journey outputs provisional and make only the boundary decision proposed, all with pending approval. work.result.proposal must have packetId:string, reason:string, and items containing only the exact proposed decision ref. Each item needs id:string, ref, alternatives:string[] with at least one choice, rationale:string, evidenceLimits:string[], and dependents:ExactArtifactRef[]. A renewed rejected decision also needs priorRejectionId naming the latest rejection and a new revision; a replacement of an existing canonical decision also needs expectedCanonical. Do not put provisional domain or journey refs in proposal.items. Use "host-derived" for the new decision ref digest; Mimic derives it before saving. This is a pending review packet, never human adoption.',
              }
            : {}),
          ...(invocation.skillId === "mimic.s11.direction-evaluator"
            ? {
                taskRequirement:
                  "Evaluate every exact design-direction input against the same user task and criteria derived from the supplied goals, task, brand, journey, and product UI contract. Keep criterion wording common across directions; when relevant to the task, consider visible decision information, hidden decisive information, unnecessary noise, and next action, without omitting other required dimensions. Keep each reason short and put only criterion/state/severity/reason in each content.findings item. Honor any explicit task exclusion from design evaluation; do not turn an excluded dimension into a finding or selection gate. Emit one proposed decision explaining recommendation, viable alternative, and unknowns without claiming human adoption. The top-level submission contains only artifacts and work; work.result.outputRefs must match every emitted artifact. Check that submissionJson decodes as one complete JSON object.",
              }
            : {}),
          ...(invocation.skillId === "mimic.s10.design-direction-generator"
            ? {
                taskRequirement:
                  "When the controlling task asks for a small comparison set, emit three separate design-direction artifacts with substantial pairwise structural differences and a reason for stopping at three. Keep each candidate concise. The top-level submission contains only artifacts and work; put unknowns inside work. work.result.outputRefs must match every emitted artifact. Check that submissionJson decodes as one complete JSON object.",
              }
            : {}),
          resultTemplate: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
          },
          outputScope,
          artifactIdPrefix: `art_${invocation.runId}_${invocation.taskId}_`,
          outputSchemas,
          envelopeGuide,
        };
        let prompt = canonicalJson(promptData);
        if (Buffer.byteLength(prompt) > MAX_CODEX_PROMPT_BYTES) {
          const { envelopeGuide: omittedGuide, ...bounded } = promptData;
          void omittedGuide;
          prompt = canonicalJson({
            ...bounded,
            instruction: bounded.instruction
              .replace(
                "the common artifact envelope described by envelopeGuide",
                "the common artifact envelope",
              )
              .replace(
                "the enum in envelopeGuide",
                "fact, human-decision, assumption, hypothesis, derived or unknown",
              ),
            skill: { ...bounded.skill, examples: [] },
          });
        }
        if (Buffer.byteLength(prompt) > MAX_CODEX_PROMPT_BYTES)
          throw new Error("Frozen Skill prompt exceeds Codex input limit");
        runnable.push({ binding: taskBinding, prompt });
      }
      return {
        runnable,
        reviewReady: next.state === "review-ready",
        questionIds: next.actions
          .filter(
            (action) =>
              action.action === "BLOCK" && action.blockKind === "durable",
          )
          .map((action) => action.taskId),
        complete: next.state === "closed",
      };
    },
  });
  const inspectCore = ports.inspect;
  ports.inspect = async () => {
    const core = await inspectCore();
    const state = await runtime.registry.snapshot();
    const questions = [];
    for (const taskId of Object.keys(
      state.runs[options.runId]?.blockers ?? {},
    )) {
      try {
        const sealed = await readJson<{
          workDigest: string;
          result: SkillResult;
        }>(`.mimic/submissions/${options.runId}-${sessionDigest(taskId)}.json`);
        const saved = await readJson<{
          work: {
            unknowns?: { question: string; affectedTaskIds: string[] }[];
          };
        }>(
          `.mimic/agent-work/${options.sessionId}-${taskId}-${sealed.workDigest}.json`,
        );
        if (
          sessionDigest(saved) !== sealed.workDigest ||
          sealed.result.runId !== options.runId ||
          sealed.result.taskId !== taskId
        )
          throw new Error("Saved question binding changed");
        questions.push({
          taskId,
          reason: state.runs[options.runId].blockers[taskId],
          questions: saved.work.unknowns ?? [],
          requiresHumanAnswer: true,
          changesRequireNewRun: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        questions.push({
          taskId,
          reason: state.runs[options.runId].blockers[taskId],
          requiresHumanAnswer: true,
          changesRequireNewRun: true,
        });
      }
    }
    return { core, questions };
  };
  return ports;
  async function readJsonFromSchemas(type: string): Promise<unknown> {
    if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new Error("Invalid output type");
    const handle = await open(
      path.join(schemasRoot, "artifacts", "types", `${type}.schema.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  }
  async function readCommonArtifactGuide(): Promise<unknown> {
    const handle = await open(
      path.join(schemasRoot, "artifacts", "common.schema.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      type Property = {
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
        items?: Property;
      };
      const schema = JSON.parse(await handle.readFile("utf8")) as {
        required: string[];
        properties: Record<string, Property>;
        $defs: { provenanceEntry: unknown };
      };
      const compact = (value: Record<string, unknown>) =>
        Object.fromEntries(
          ["type", "enum", "pattern", "const", "format", "minItems"]
            .filter((key) => key in value)
            .map((key) => [key, value[key]]),
        );
      const fields: Record<string, unknown> = Object.fromEntries(
        schema.required.map((name) => {
          const property = schema.properties[name];
          return [
            name,
            {
              required: property.required ?? [],
              properties: Object.fromEntries(
                Object.entries(property.properties ?? {}).map(
                  ([key, value]) => [key, compact(value)],
                ),
              ),
              ...(property.items?.properties
                ? {
                    items: {
                      required: property.items.required ?? [],
                      properties: Object.keys(property.items.properties),
                    },
                  }
                : {}),
            },
          ];
        }),
      );
      fields.provenance = {
        ...(fields.provenance as Record<string, unknown>),
        items: schema.$defs.provenanceEntry,
      };
      return { required: schema.required, fields };
    } finally {
      await handle.close();
    }
  }
}
