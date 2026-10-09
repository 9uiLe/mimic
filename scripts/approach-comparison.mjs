#!/usr/bin/env node
/** Prepare and inspect matched S09–S11 Runs without invoking a model or granting authority. */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, readdir, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stages = ["s04", "s01", "s02", "s05", "s07", "s08"];
const arms = ["B0", "C1", "C2"];
const corpusFiles = [
  "knowledge/seed/graph.json",
  "knowledge/seed/spaces.json",
  "knowledge/seed/sources.json",
  "knowledge/seed/product-ui-playbook.md",
  "knowledge/seed/purpose-information-playbook.md",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const repositoryCommit = () =>
  execFileSync("git", ["-c", `safe.directory=${repo}`, "rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const inside = (root, target) =>
  target === root || target.startsWith(`${root}${path.sep}`);
const safeName = (value) => {
  assert(
    typeof value === "string" &&
      value.length <= 76 &&
      /^[a-z0-9][a-z0-9_-]*$/.test(value),
    "Invalid cohort ID",
  );
  return value;
};
async function frozenFile(file) {
  const bytes = await readFile(file);
  return { sha256: sha(bytes), bytes: bytes.length };
}
async function treeFiles(root, directory) {
  const files = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert(entry.isFile(), `Unsupported Skill entry: ${file}`);
        files.push(path.relative(root, file));
      }
    }
  }
  await walk(path.join(root, directory));
  files.sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        await frozenFile(path.join(root, name)),
      ]),
    ),
  );
}
async function createFrozen(root, file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  assert(
    inside(root, await realpath(path.dirname(file))),
    "Output parent escapes workspace",
  );
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    path: file,
    sha256: sha(content),
    bytes: Buffer.byteLength(content),
  };
}
function makePlan(template, cohort, cfg) {
  const runId = `run_${cohort}`;
  const upstream = template.filter((task) => stages.includes(task.id));
  assert(upstream.length === stages.length, "Missing common upstream stages");
  const armTemplate = template.filter((task) =>
    ["s09", "s10", "s11"].includes(task.id),
  );
  assert(armTemplate.length === 3, "Missing S09–S11 template");
  assert(
    !armTemplate.some((task) =>
      task.inputs.optional.some((need) => need.name === "prior-direction"),
    ),
    "Unbound prior direction can leak between comparison arms",
  );
  const commonBrief = `${cfg.brief.trim()}\n\nThis is a matched comparison. The supplied brief is evidence, not a recorded human decision. Do not invent a decisionId or human-decision provenance. No owner has adopted a direction.\n`;
  const common = upstream.map((original) => {
    const task = JSON.parse(JSON.stringify(original));
    task.humanBrief = commonBrief;
    task.assumptions = cfg.assumptions ?? [];
    task.evidenceFiles = ["s04", "s08"].includes(task.id)
      ? cfg.pageEvidenceFiles
      : [];
    return task;
  });
  const variants = arms.flatMap((arm) =>
    armTemplate.map((original) => {
      const task = JSON.parse(JSON.stringify(original));
      const suffix = arm.toLowerCase();
      task.id = `${original.id}_${suffix}`;
      task.dependsOn = (task.dependsOn ?? []).map((id) =>
        ["s09", "s10", "s11"].includes(id) ? `${id}_${suffix}` : id,
      );
      for (const group of ["required", "optional"])
        task.inputs[group] = task.inputs[group].map((need) => ({
          ...need,
          ...(need.refsFromTask &&
          ["s09", "s10", "s11"].includes(need.refsFromTask)
            ? { refsFromTask: `${need.refsFromTask}_${suffix}` }
            : {}),
        }));
      task.humanBrief = `${commonBrief}\nComparison arm ${arm} in ${runId}. Use the host supplied artifactIdPrefix and exact refs for this task. The evidence timing differs by arm; do not assume this proves superiority.\n`;
      task.assumptions = cfg.assumptions ?? [];
      task.evidenceFiles =
        original.id === "s09"
          ? [
              `inputs/${cohort}-${suffix}-s09.md`,
              `inputs/${cohort}-corpus-inventory.json`,
            ]
          : original.id === "s11"
            ? arm === "C2"
              ? [`inputs/${cohort}-c2-s11.md`]
              : []
            : [];
      return task;
    }),
  );
  return [...common, ...variants];
}
function sourceRows(sources, result) {
  const ids = new Set(
    [...result.selected, ...result.exclusions].flatMap(
      (candidate) => candidate.evidenceRefs,
    ),
  );
  return sources.evidence
    .filter((row) => ids.has(row.id))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      sourceUrl: row.sourceUrl,
      author: row.author,
      accessDate: row.accessDate,
      relevantSection: row.relevantSection,
      verificationScope: row.verificationScope,
      claim: row.claim,
    }));
}
function flatCaseRows(sources, graph, assessments) {
  return assessments.map((assessment) => ({
    caseId: assessment.caseId,
    caseLabel: graph.nodes.find((node) => node.id === assessment.caseId)?.label,
    evidence: sources.evidence
      .filter((row) => assessment.evidenceRefs.includes(row.id))
      .map((row) => ({
        kind: row.kind,
        sourceUrl: row.sourceUrl,
        author: row.author,
        accessDate: row.accessDate,
        claim: row.claim,
      })),
  }));
}
function referenceEvidence(
  arm,
  inventory,
  result,
  sources,
  graph,
  traitIds,
  assessments,
) {
  const header = `# ${arm} reference evidence\n\nAll source claims below are local paraphrases or hypotheses; follow the source URLs. Complete corpus SHA-256 inventory: ${inventory.digest}. Do not treat a case as a UI to copy.\n\n`;
  const flat = flatCaseRows(sources, graph, assessments);
  if (arm === "B0")
    return (
      header +
      "## Flat case catalogue\n\nNo task-specific graph role or path is supplied in this arm. The common upstream carries the product purpose and observed page.\n\n" +
      JSON.stringify(flat) +
      "\n"
    );
  if (arm === "C2")
    return (
      header +
      "## Mechanisms foregrounded before divergence\n\nExplore distinct information architectures, operation models, and progress representations. Preserve choice and status facts. The non-fit check follows at S11.\n\n" +
      JSON.stringify(
        flat.map((item) => ({
          ...item,
          mechanisms: graph.nodes
            .filter(
              (node) =>
                node.kind === "mechanism" &&
                node.id.slice("mechanism:".length) ===
                  item.caseId.slice("case:".length),
            )
            .map((node) => node.label),
        })),
      ) +
      "\n"
    );
  const nodeIds = new Set([
    ...traitIds,
    ...result.selected.flatMap((item) => [
      item.caseId,
      ...item.principleIds,
      ...item.spaceIds,
      ...item.mechanismIds,
      ...item.patternIds,
      ...item.failureIds,
    ]),
    ...result.exclusions.flatMap((item) => [
      item.caseId,
      ...item.mechanismIds,
      ...item.failureIds,
    ]),
  ]);
  const graphNodes = graph.nodes
    .filter((node) => nodeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      evidenceRefs: node.evidenceRefs,
    }));
  const graphEdges = graph.edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );
  return (
    header +
    "## Host graph retrieval (provisional, reviewable)\n\n" +
    "This was computed before S09 from declared traits and assessments. S09 may question its roles. Omitted cases remain in the hashed inventory and are not deemed useless.\n\n" +
    "```json\n" +
    JSON.stringify({
      selected: result.selected.map((item) => ({
        caseId: item.caseId,
        role: item.role,
        mechanismIds: item.mechanismIds,
        rationale: item.rationale,
        doNotBorrow: item.doNotBorrow,
        risks: item.risks,
        evidenceRefs: item.evidenceRefs,
      })),
      exclusions: result.exclusions,
      gaps: result.gaps,
      graphNodes,
      graphEdges,
      sourceEvidence: sourceRows(sources, result),
    }) +
    "\n```\n"
  );
}
async function prepare(cfg) {
  const { retrieveDesignReferences } =
    await import("../packages/core/dist/index.js");
  const { preflightPlan } = await import("../apps/cli/dist/plan.js");
  const root = await realpath(cfg.workspace);
  const cohort = safeName(cfg.cohortId);
  assert(
    cfg.model &&
      cfg.reasoningEffort &&
      cfg.brief &&
      Array.isArray(cfg.pageEvidenceFiles),
    "Missing comparison settings",
  );
  const commit = repositoryCommit();
  assert(
    !cfg.repositoryCommit || cfg.repositoryCommit === commit,
    "Repository commit changed",
  );
  const scopeConfig = await readJson(path.join(root, ".mimic/config.json"));
  const existing = await readJson(
    path.join(root, ".mimic/workspace.json"),
  ).catch((error) => {
    if (error.code === "ENOENT")
      return { registry: { runs: {}, canonical: {} } };
    throw error;
  });
  assert(
    Object.keys(existing.registry?.runs ?? {}).length === 0 &&
      Object.keys(existing.registry?.canonical ?? {}).length === 0,
    "Comparison preparation requires a fresh Mimic workspace",
  );
  const template = await readJson(path.resolve(cfg.planTemplate));
  assert(Array.isArray(template), "Invalid plan template");
  const plan = makePlan(template, cohort, cfg);
  preflightPlan(plan, scopeConfig.scopes, scopeConfig.defaultScope);
  const fileHashes = Object.fromEntries(
    await Promise.all(
      corpusFiles.map(async (name) => [
        name,
        await frozenFile(path.join(repo, name)),
      ]),
    ),
  );
  const inventory = {
    commit,
    files: fileHashes,
    digest: sha(JSON.stringify(fileHashes)),
  };
  const pageEvidence = {};
  for (const name of cfg.pageEvidenceFiles) {
    const file = await realpath(path.join(root, name));
    assert(inside(root, file), "Evidence escapes workspace");
    pageEvidence[name] = await frozenFile(file);
  }
  const packages = await treeFiles(root, "skills");
  const schemas = {
    repository: await treeFiles(repo, "schemas"),
    workspace: await treeFiles(root, "schemas"),
  };
  const compiledModules = {
    ...(await treeFiles(repo, "packages/core/dist")),
    ...(await treeFiles(repo, "apps/cli/dist")),
  };
  const graph = await readJson(path.join(repo, corpusFiles[0]));
  const sources = await readJson(path.join(repo, corpusFiles[2]));
  const retrieval = retrieveDesignReferences(graph, {
    traitIds: cfg.traitIds,
    assessments: cfg.assessments,
    history: cfg.history ?? [],
    limit: cfg.limit ?? 6,
  });
  const targets = [
    `inputs/${cohort}-corpus-inventory.json`,
    ...arms.map((arm) => `inputs/${cohort}-${arm.toLowerCase()}-s09.md`),
    `plans/${cohort}-comparison.json`,
    `inputs/${cohort}-c2-s11.md`,
    `plans/${cohort}-manifest.json`,
  ];
  for (const name of targets) {
    const file = path.join(root, name);
    assert(inside(root, file), "Output escapes workspace");
    try {
      await readFile(file);
      throw new Error(`Comparison output exists: ${name}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const written = [];
  written.push(
    await createFrozen(
      root,
      path.join(root, targets[0]),
      JSON.stringify(inventory, null, 2) + "\n",
    ),
  );
  const armRecords = {};
  for (const arm of arms) {
    const evidence = referenceEvidence(
      arm,
      inventory,
      retrieval,
      sources,
      graph,
      cfg.traitIds,
      cfg.assessments,
    );
    const evidencePath = `inputs/${cohort}-${arm.toLowerCase()}-s09.md`;
    written.push(
      await createFrozen(root, path.join(root, evidencePath), evidence),
    );
    if (arm === "C2")
      written.push(
        await createFrozen(
          root,
          path.join(root, `inputs/${cohort}-c2-s11.md`),
          `# S11 purpose and counterexample check\n\nCompare every direction against the same decision facts: what is visible, what consequential fact is hidden, what is needless noise, and the next action. Revisit the cases' explicit non-fit conditions. This evidence was present in the common corpus at S09; it is foregrounded now.\n\n${JSON.stringify(graph.nodes.filter((node) => node.kind === "failure" && cfg.assessments.some((item) => item.caseId.slice(5) === node.id.slice(8))).map((node) => ({ id: node.id, label: node.label, evidenceRefs: node.evidenceRefs })))}`,
        ),
      );
    armRecords[arm] = {
      taskIds: ["s09", "s10", "s11"].map(
        (stage) => `${stage}_${arm.toLowerCase()}`,
      ),
      evidencePath,
      retrievalStatus: arm === "C1" ? retrieval.status : "not-applicable",
    };
  }
  const planPath = `plans/${cohort}-comparison.json`;
  written.push(
    await createFrozen(
      root,
      path.join(root, planPath),
      JSON.stringify(plan, null, 2) + "\n",
    ),
  );
  const manifest = {
    version: 1,
    cohort,
    runId: `run_${cohort}`,
    planPath,
    repositoryCommit: commit,
    implementation: await frozenFile(fileURLToPath(import.meta.url)),
    planTemplate: await frozenFile(path.resolve(cfg.planTemplate)),
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    packages,
    schemas,
    compiledModules,
    commonTaskIds: stages,
    pageEvidence,
    corpus: inventory,
    retrievalRequest: {
      traitIds: cfg.traitIds,
      assessments: cfg.assessments,
      history: cfg.history ?? [],
      limit: cfg.limit ?? 6,
    },
    retrieval,
    arms: armRecords,
    frozenFiles: written.map((item) => ({
      ...item,
      path: path.relative(root, item.path),
    })),
  };
  await createFrozen(
    root,
    path.join(root, `plans/${cohort}-manifest.json`),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
async function report(cfg) {
  const { artifactDigest, canonicalJson, deriveRunState } =
    await import("../packages/core/dist/index.js");
  const { preflightPlan } = await import("../apps/cli/dist/plan.js");
  const root = await realpath(cfg.workspace);
  const cohort = safeName(cfg.cohortId);
  const manifest = await readJson(
    path.join(root, `plans/${cohort}-manifest.json`),
  );
  assert(manifest.cohort === cohort, "Cohort mismatch");
  const currentCommit = repositoryCommit();
  const currentTemplate = await frozenFile(path.resolve(cfg.planTemplate));
  const currentImplementation = await frozenFile(
    fileURLToPath(import.meta.url),
  );
  const corpusMatches = Object.fromEntries(
    await Promise.all(
      Object.entries(manifest.corpus.files).map(async ([name, expected]) => {
        const actual = await frozenFile(path.join(repo, name));
        return [
          name,
          actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
        ];
      }),
    ),
  );
  const repositoryInputs = {
    commitMatches: currentCommit === manifest.repositoryCommit,
    templateMatches:
      currentTemplate.sha256 === manifest.planTemplate.sha256 &&
      currentTemplate.bytes === manifest.planTemplate.bytes,
    implementationMatches:
      currentImplementation.sha256 === manifest.implementation.sha256 &&
      currentImplementation.bytes === manifest.implementation.bytes,
    corpusMatches,
  };
  let compiledVerification = "not-frozen";
  if (manifest.compiledModules) {
    const currentModules = {
      ...(await treeFiles(repo, "packages/core/dist")),
      ...(await treeFiles(repo, "apps/cli/dist")),
    };
    assert(
      JSON.stringify(Object.keys(currentModules).sort()) ===
        JSON.stringify(Object.keys(manifest.compiledModules).sort()),
      "Changed compiled module set",
    );
    for (const [name, expected] of Object.entries(manifest.compiledModules)) {
      const actual = currentModules[name];
      assert(
        actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
        `Changed compiled module: ${name}`,
      );
    }
    compiledVerification = "verified";
  }
  for (const file of manifest.frozenFiles) {
    const actual = await frozenFile(path.join(root, file.path));
    assert(
      actual.sha256 === file.sha256 && actual.bytes === file.bytes,
      `Changed frozen file: ${file.path}`,
    );
  }
  for (const [name, expected] of Object.entries(manifest.pageEvidence)) {
    const actual = await frozenFile(path.join(root, name));
    assert(
      actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
      `Changed page evidence: ${name}`,
    );
  }
  const currentPackages = await treeFiles(root, "skills");
  assert(
    JSON.stringify(Object.keys(currentPackages).sort()) ===
      JSON.stringify(Object.keys(manifest.packages).sort()),
    "Changed Skill package set",
  );
  for (const [name, expected] of Object.entries(manifest.packages)) {
    const actual = currentPackages[name];
    assert(
      actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
      `Changed Skill package: ${name}`,
    );
  }
  let schemaVerification = "not-frozen";
  if (manifest.schemas) {
    for (const [location, base] of [
      ["repository", repo],
      ["workspace", root],
    ]) {
      const current = await treeFiles(base, "schemas");
      assert(
        JSON.stringify(Object.keys(current).sort()) ===
          JSON.stringify(Object.keys(manifest.schemas[location]).sort()),
        `Changed schema set: ${location}`,
      );
      for (const [name, expected] of Object.entries(
        manifest.schemas[location],
      )) {
        const actual = current[name];
        assert(
          actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
          `Changed schema: ${location}/${name}`,
        );
      }
    }
    schemaVerification = "verified";
  }
  const scopeConfig = await readJson(path.join(root, ".mimic/config.json"));
  const planned = await readJson(path.join(root, manifest.planPath));
  const normalized = preflightPlan(
    planned,
    scopeConfig.scopes,
    scopeConfig.defaultScope,
  );
  const packageBySkill = new Map();
  for (const entry of await readdir(path.join(root, "skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const content = await readFile(
      path.join(root, "skills", entry.name, "manifest.yaml"),
      "utf8",
    );
    const skillId = content.match(/^\s*"skillId":\s*"([^"]+)"/m)?.[1];
    assert(skillId && !packageBySkill.has(skillId), "Invalid Skill mapping");
    packageBySkill.set(skillId, `skills/${entry.name}`);
  }
  const sessionPackages = Object.fromEntries(
    normalized.map((task) => {
      const location = packageBySkill.get(task.skillId);
      assert(location, `Missing Skill for ${task.id}`);
      return [task.id, location];
    }),
  );
  const savedTasks = await readJson(
    path.join(root, ".mimic/runs", `${manifest.runId}.json`),
  ).catch((error) => {
    if (error.code === "ENOENT") return normalized;
    throw error;
  });
  assert(
    canonicalJson(savedTasks) === canonicalJson(normalized),
    "Saved Run plan differs from frozen plan",
  );
  const expectedPlanDigest = sha(
    canonicalJson({ tasks: normalized, packages: sessionPackages }),
  );
  const workspace = await readJson(path.join(root, ".mimic/workspace.json"));
  const events = workspace.registry.events.filter(
    (event) => event.runId === manifest.runId,
  );
  const completed = (taskId) =>
    events.filter(
      (event) =>
        event.action === "set-work" &&
        event.actor?.kind === "agent" &&
        event.actor?.id === "orchestrator" &&
        event.reason ===
          `Skill task ${JSON.stringify(taskId)} completed with verified exact outputs`,
    );
  const sessions = [];
  try {
    for (const name of await readdir(
      path.join(root, ".mimic/agent-sessions"),
    )) {
      if (!name.endsWith(".json")) continue;
      const saved = await readJson(
        path.join(root, ".mimic/agent-sessions", name),
      );
      const checkpoint = saved.checkpoint;
      assert(
        checkpoint &&
          saved.digest === sha(canonicalJson(checkpoint)) &&
          checkpoint.version === 1 &&
          checkpoint.sessionId === name.slice(0, -5) &&
          Number.isSafeInteger(checkpoint.generationCount) &&
          checkpoint.generationCount >= 0 &&
          ["ready", "stopped", "complete"].includes(checkpoint.status) &&
          checkpoint.tasks &&
          typeof checkpoint.tasks === "object" &&
          !Array.isArray(checkpoint.tasks),
        `Invalid checkpoint envelope: ${name}`,
      );
      if (checkpoint?.binding?.runId !== manifest.runId) continue;
      assert(
        checkpoint.binding.planDigest === expectedPlanDigest &&
          checkpoint.binding.settings?.provider === "codex" &&
          checkpoint.binding.settings?.billingMode === "subscription-only" &&
          checkpoint.binding.settings?.model === manifest.model,
        `Session binding differs from frozen comparison: ${name}`,
      );
      sessions.push({
        sessionId: checkpoint.sessionId,
        generationCount: checkpoint.generationCount,
        status: checkpoint.status,
        stop: checkpoint.stop ?? null,
        tasks: Object.entries(checkpoint.tasks ?? {}).map(([taskId, task]) => ({
          taskId,
          phase: task.phase,
          rejectionReason: task.rejectionReason ?? null,
        })),
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let attempts = [];
  try {
    attempts = (await readFile(path.join(root, "attempts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.runId === manifest.runId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const attemptRows = new Map();
  for (const item of attempts) {
    const rows = attemptRows.get(item.sessionId) ?? [];
    rows.push(item);
    attemptRows.set(item.sessionId, rows);
  }
  const sessionIds = new Set(sessions.map((item) => item.sessionId));
  const attemptedSessions = new Map(
    [...attemptRows]
      .filter(([id, rows]) => sessionIds.has(id) && rows.length === 1)
      .map(([id, rows]) => [id, rows[0]]),
  );
  for (const session of sessions) {
    for (const attempt of attemptRows.get(session.sessionId) ?? [])
      assert(
        attempt.model === manifest.model &&
          attempt.reasoningEffort === manifest.reasoningEffort &&
          Array.isArray(attempt.tasks) &&
          JSON.stringify(attempt.tasks.map((item) => item.taskId).sort()) ===
            JSON.stringify(session.tasks.map((item) => item.taskId).sort()),
        `Attempt settings differ from frozen comparison: ${session.sessionId}`,
      );
  }
  const hasProposedDecision = (event) =>
    event.outputs?.some((ref) => {
      const snapshot =
        workspace.snapshots?.[`${ref.artifactId}@${ref.revision}`];
      if (!snapshot) return false;
      const locked = JSON.parse(snapshot);
      return (
        locked.digest === ref.lockDigest &&
        locked.digest === artifactDigest(locked.artifact) &&
        locked.artifact?.meta?.type === "decision" &&
        locked.artifact?.lifecycle?.status === "proposed" &&
        locked.artifact?.approval?.status === "pending"
      );
    }) ?? false;
  const outcomes = {};
  for (const [arm, armRecord] of Object.entries(manifest.arms)) {
    const accepted = armRecord.taskIds.flatMap((id) => completed(id));
    const armAttempts = attempts.filter((item) =>
      item.tasks.some((task) => armRecord.taskIds.includes(task.taskId)),
    );
    const armSessions = sessions.filter((item) =>
      item.tasks.some((task) => armRecord.taskIds.includes(task.taskId)),
    );
    const mixedSessionIds = armSessions
      .filter((item) =>
        item.tasks.some((task) => !armRecord.taskIds.includes(task.taskId)),
      )
      .map((item) => item.sessionId);
    const exclusiveCosts = mixedSessionIds.length === 0;
    const timingVerified =
      armSessions.length > 0 &&
      armAttempts.length === armSessions.length &&
      armSessions.every((item) => {
        const attempt = attemptedSessions.get(item.sessionId);
        return (
          attempt &&
          Number.isFinite(attempt.elapsedMs) &&
          attempt.elapsedMs >= 0
        );
      });
    outcomes[arm] = {
      taskIds: armRecord.taskIds,
      acceptedRefs: accepted.flatMap((event) => event.outputs),
      lastAcceptedEvent: accepted.at(-1)?.at ?? null,
      firstReviewableAt:
        completed(`s11_${arm.toLowerCase()}`)
          .filter(hasProposedDecision)
          .map((event) => event.at)
          .filter(Boolean)
          .sort()[0] ?? null,
      attemptCount: exclusiveCosts ? armSessions.length : null,
      mixedSessionIds,
      reasoningEffortVerified: timingVerified,
      generationCount: exclusiveCosts
        ? armSessions.reduce((total, item) => total + item.generationCount, 0)
        : null,
      elapsedGenerationMs:
        exclusiveCosts && timingVerified
          ? armSessions.reduce(
              (total, item) =>
                total + attemptedSessions.get(item.sessionId).elapsedMs,
              0,
            )
          : null,
      stops: armSessions.map((item) => ({
        sessionId: item.sessionId,
        stop: item.stop,
        tasks: item.tasks,
      })),
    };
  }
  return {
    cohort,
    runId: manifest.runId,
    repositoryCommit: manifest.repositoryCommit,
    repositoryInputs,
    schemaVerification,
    compiledVerification,
    runState: workspace.registry.runs[manifest.runId]
      ? deriveRunState(workspace.registry.runs[manifest.runId])
      : "not-started",
    binding: {
      planDigest: expectedPlanDigest,
      model: manifest.model,
      reasoningEffort: manifest.reasoningEffort,
      verifiedSessionCount: sessions.length,
      reasoningEffortLogCount: sessions.filter((item) =>
        attemptedSessions.has(item.sessionId),
      ).length,
      reasoningEffortVerified:
        sessions.length > 0 &&
        attempts.length === sessions.length &&
        sessions.every((item) => attemptedSessions.has(item.sessionId)),
    },
    commonAcceptedRefs: stages.flatMap((id) =>
      completed(id).flatMap((event) => event.outputs),
    ),
    commonAttemptCount: sessions.some(
      (item) =>
        item.tasks.some((task) => stages.includes(task.taskId)) &&
        item.tasks.some((task) => !stages.includes(task.taskId)),
    )
      ? null
      : sessions.filter((item) =>
          item.tasks.some((task) => stages.includes(task.taskId)),
        ).length,
    outcomes,
    warning:
      "Elapsed generation and reasoning effort require the optional attempt log; absent rows remain unverified. Costs for sessions crossing task groups are unavailable to avoid double counting. It is a single Run, so model state and ordering effects remain possible. No human adoption is implied.",
  };
}
const [command, configFile] = process.argv.slice(2);
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert(
      ["prepare", "report"].includes(command) && configFile,
      "Usage: approach-comparison.mjs <prepare|report> <config.json>",
    );
    const cfg = await readJson(await realpath(configFile));
    const result =
      command === "prepare" ? await prepare(cfg) : await report(cfg);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
export { makePlan, prepare, report };
