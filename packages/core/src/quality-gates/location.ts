import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, type JsonValue } from "../artifact-canonical.js";
import type { PrototypeBuilderInput } from "../prototype-builder/index.js";

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(canonicalJson(value as JsonValue))
    .digest("hex")}`;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
const directoryName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

async function readMetadata(directory: string, name: string): Promise<unknown> {
  const file = path.join(directory, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
    return undefined;
  const contents = await readFile(file);
  if (contents.byteLength > 2_000_000) return undefined;
  return JSON.parse(contents.toString("utf8")) as unknown;
}

function matchesProposedPlan(
  rendered: PrototypeBuilderInput,
  authored: PrototypeBuilderInput,
  choices: readonly unknown[],
  historical: boolean,
): boolean {
  if (!Array.isArray(rendered.states) || !Array.isArray(authored.states))
    return false;
  const notices = choices
    .filter((choice) => record(choice) && choice.status !== "current")
    .map((choice) => {
      if (!record(choice) || !record(choice.systemRequest)) return undefined;
      const request = choice.systemRequest;
      const status =
        choice.status === "required"
          ? "Approved requirement, not implemented"
          : "Proposed, not implemented";
      return `${status}: ${choice.id}; System Request ${request.artifactId}@${request.revision}; digest ${String(request.lockDigest).slice(0, 19)}…`;
    });
  if (notices.some((notice) => notice === undefined)) return false;
  const expected = {
    ...authored,
    states: authored.states.map((state) => ({
      ...state,
      root: {
        ...state.root,
        children: [
          ...(state.root.children ?? []),
          {
            tag: "header",
            id: `mode-notice-${state.name}`,
            children: [
              {
                tag: "h2",
                text: historical
                  ? "System mode: Proposed historical replay"
                  : "System mode: Proposed",
              },
              ...notices.map((text) => ({ tag: "p", text })),
            ],
          },
        ],
      },
    })),
  };
  return same(rendered, expected);
}

/** A mode bundle keeps its authored relative path after the comparison is published. */
export async function matchesOutputLocation(
  trustedRoot: string,
  directory: string,
  plan: PrototypeBuilderInput,
): Promise<boolean> {
  if (path.resolve(trustedRoot, plan.outputPath) === directory) return true;
  const comparisonDirectory = path.dirname(directory);
  const comparisonName = path.basename(comparisonDirectory);
  const slotName = path.basename(directory);
  if (
    !directoryName(comparisonName) ||
    !directoryName(slotName) ||
    slotName !== plan.outputPath ||
    path.dirname(comparisonDirectory) !== trustedRoot
  )
    return false;
  try {
    const modePlan = await readMetadata(comparisonDirectory, "mode-plan.json");
    const comparison = await readMetadata(
      comparisonDirectory,
      "comparison.json",
    );
    if (!record(modePlan) || !record(comparison)) return false;
    const current = modePlan.current;
    const proposed = modePlan.proposed;
    if (
      !record(current) ||
      !record(proposed) ||
      !directoryName(modePlan.comparisonPath) ||
      modePlan.comparisonPath !== comparisonName ||
      !directoryName(current.outputPath) ||
      !directoryName(proposed.outputPath) ||
      current.outputPath === proposed.outputPath ||
      comparisonName === current.outputPath ||
      comparisonName === proposed.outputPath ||
      comparison.kind !== "mimic-prototype-mode-comparison" ||
      comparison.productionReady !== false ||
      comparison.modePlanDigest !== digest(modePlan) ||
      ![
        null,
        "rejected-system-request",
        "rejected-capability",
        "unresolved-choice",
      ].includes(comparison.fallback as string | null) ||
      !same(comparison.scenario, plan.scenario) ||
      !same(current.scenario, proposed.scenario) ||
      !same(current.scenario, plan.scenario) ||
      !same(comparison.contract, modePlan.contract) ||
      !same(comparison.decisionContext, modePlan.decisionContext) ||
      !record(modePlan.decisionContext) ||
      !["live", "historical"].includes(
        modePlan.decisionContext.kind as string,
      ) ||
      !Array.isArray(modePlan.choices) ||
      !Array.isArray(modePlan.currentUses) ||
      !Array.isArray(modePlan.proposedUses) ||
      !same(
        comparison.choices,
        modePlan.choices.filter(
          (choice) =>
            record(choice) &&
            ((modePlan.currentUses as unknown[]).includes(choice.id) ||
              (modePlan.proposedUses as unknown[]).includes(choice.id)),
        ),
      )
    )
      return false;
    const isCurrent = slotName === current.outputPath;
    const isProposed = slotName === proposed.outputPath;
    const slot = comparison[isCurrent ? "current" : "proposed"];
    if (
      (!isCurrent && !isProposed) ||
      !record(slot) ||
      slot.path !== slotName ||
      slot.planDigest !== digest(plan) ||
      !record(comparison.current) ||
      comparison.current.path !== current.outputPath ||
      comparison.current.planDigest !== digest(current) ||
      (comparison.fallback === null) !== record(comparison.proposed) ||
      (record(comparison.proposed) &&
        (comparison.proposed.path !== proposed.outputPath ||
          !/^sha256:[0-9a-f]{64}$/.test(
            String(comparison.proposed.planDigest),
          )))
    )
      return false;
    if (isCurrent) return same(plan, current);
    return (
      comparison.fallback === null &&
      matchesProposedPlan(
        plan,
        proposed as unknown as PrototypeBuilderInput,
        comparison.choices as unknown[],
        record(modePlan.decisionContext) &&
          modePlan.decisionContext.kind === "historical",
      )
    );
  } catch {
    return false;
  }
}
