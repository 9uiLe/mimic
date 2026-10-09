#!/usr/bin/env node
/** 9UI-174 dogfood acceptance, separate from the general S10/S11 contract.
 * A single direction remains valid for tasks that did not request divergence. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "../packages/core/dist/index.js";

const [root, runId] = process.argv.slice(2);
if (!root || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(runId ?? "")) {
  process.stderr.write(
    "Usage: verify-monitor-design-cycle <workspace> <run-id>\n",
  );
  process.exit(2);
}
const state = JSON.parse(
  await readFile(path.join(root, ".mimic/workspace.json"), "utf8"),
);
const run = state.registry?.runs?.[runId];
if (!run || !Array.isArray(run.artifacts)) throw new Error("Unknown Run");
const failures = [];
const resolved = run.artifacts.map((ref) => {
  const saved = state.snapshots?.[`${ref.artifactId}@${ref.revision}`];
  const artifact = saved && JSON.parse(saved).artifact;
  if (
    !artifact ||
    artifactDigest(artifact) !== ref.lockDigest ||
    artifact.origin?.runId !== runId
  )
    throw new Error(
      `Invalid exact artifact: ${ref.artifactId}@${ref.revision}`,
    );
  return { ref, artifact };
});
const from = (task, type) =>
  resolved.filter(
    ({ artifact }) =>
      artifact.meta.type === type &&
      artifact.origin.actorId ===
        `mimic.${task}.${task === "s10" ? "design-direction-generator" : "direction-evaluator"}`,
  );
const directions = from("s10", "design-direction");
const evaluations = from("s11", "evaluation");
const decisions = from("s11", "decision");
if (directions.length < 4 || directions.length > 7)
  failures.push(
    `S10 directions: ${directions.length}; this dogfood requires 4–7`,
  );
if (
  new Set(directions.map(({ artifact }) => artifact.meta.title)).size !==
  directions.length
)
  failures.push("Direction titles are not distinct");
if (
  new Set(
    directions.map(({ artifact }) =>
      JSON.stringify(artifact.content.mechanisms),
    ),
  ).size !== directions.length
)
  failures.push("Direction mechanisms are not distinct");
const target = (ref) => `${ref.artifactId}@${ref.revision}`;
for (const direction of directions) {
  const matches = evaluations.filter(
    ({ artifact }) =>
      artifact.content.target.startsWith(target(direction.ref)) &&
      artifact.dependencies.some(
        (ref) => target(ref) === target(direction.ref),
      ),
  );
  if (matches.length !== 1)
    failures.push(
      `Expected one S11 evaluation of ${target(direction.ref)}, found ${matches.length}`,
    );
}
if (evaluations.length !== directions.length)
  failures.push(
    `S11 evaluations: ${evaluations.length}; expected ${directions.length}`,
  );
const criteria = evaluations.map(({ artifact }) =>
  artifact.content.findings.map((finding) => finding.criterion),
);
if (
  criteria.length &&
  criteria.some(
    (value) => JSON.stringify(value) !== JSON.stringify(criteria[0]),
  )
)
  failures.push("S11 criteria differ across candidates");
if (decisions.length !== 1)
  failures.push(`Pending S11 decisions: ${decisions.length}; expected 1`);
else {
  const decision = decisions[0].artifact;
  if (
    decision.content.outcome !== "proposed" ||
    !decision.content.summary ||
    !decision.content.rationale?.trim() ||
    decision.content.alternatives?.length < 2
  )
    failures.push(
      "S11 decision lacks a pending recommendation with alternatives and rationale",
    );
  const depended = new Set(decision.dependencies.map(target));
  if (directions.some((direction) => !depended.has(target(direction.ref))))
    failures.push("S11 decision does not depend on every exact direction");
}
const report = {
  runId,
  pass: failures.length === 0,
  failures,
  directions: directions.map(({ ref, artifact }) => ({
    ref,
    title: artifact.meta.title,
    summary: artifact.content.summary,
  })),
  evaluations: evaluations.map(({ ref, artifact }) => ({
    ref,
    target: artifact.content.target,
    criteria: artifact.content.findings.map((finding) => finding.criterion),
  })),
  decision: decisions.map(({ ref, artifact }) => ({
    ref,
    outcome: artifact.content.outcome,
    rationale: artifact.content.rationale,
    chosenAlternative: artifact.content.chosenAlternative,
  })),
  structuralDifferencesRequireHumanReview: true,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
