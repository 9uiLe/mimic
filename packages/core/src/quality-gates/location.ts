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

function expectedProposedPlan(
  authored: PrototypeBuilderInput,
  choices: readonly unknown[],
  historical: boolean,
): PrototypeBuilderInput | undefined {
  if (!Array.isArray(authored.states)) return undefined;
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
  if (notices.some((notice) => notice === undefined)) return undefined;
  return {
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
}

const comparisonKeys = [
  "kind",
  "productionReady",
  "modePlanDigest",
  "contract",
  "scenario",
  "choices",
  "decisionContext",
  "current",
  "proposed",
  "fallback",
  "review",
].sort();
const slotKeys = ["path", "planDigest"].sort();
const refKeys = ["artifactId", "revision", "lockDigest"].sort();
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  same(Object.keys(value).sort(), [...keys].sort());
const exactRef = (value: unknown): boolean =>
  record(value) &&
  exactKeys(value, refKeys) &&
  typeof value.artifactId === "string" &&
  /^art_[A-Za-z0-9_-]+$/.test(value.artifactId) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) > 0 &&
  typeof value.lockDigest === "string" &&
  /^sha256:[0-9a-f]{64}$/.test(value.lockDigest);
const decisionContext = (value: unknown): boolean =>
  record(value) &&
  exactKeys(value, ["kind", "requests"]) &&
  ["live", "historical"].includes(value.kind as string) &&
  Array.isArray(value.requests) &&
  value.requests.every(exactRef) &&
  (value.kind !== "historical" || value.requests.length === 0);
const modeChoice = (value: unknown): boolean =>
  record(value) &&
  typeof value.id === "string" &&
  /^[A-Za-z][A-Za-z0-9_-]*$/.test(value.id) &&
  ["current", "required", "proposed", "unresolved"].includes(
    value.status as string,
  ) &&
  exactRef(value.capability) &&
  (value.status === "current"
    ? exactKeys(value, ["id", "status", "capability"])
    : exactKeys(value, ["id", "status", "capability", "systemRequest"]) &&
      exactRef(value.systemRequest));

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
      !exactRef(modePlan.contract) ||
      !exactRef(current.scenario) ||
      !exactRef(proposed.scenario) ||
      !decisionContext(modePlan.decisionContext) ||
      !directoryName(modePlan.comparisonPath) ||
      modePlan.comparisonPath !== comparisonName ||
      !directoryName(current.outputPath) ||
      !directoryName(proposed.outputPath) ||
      current.outputPath === proposed.outputPath ||
      comparisonName === current.outputPath ||
      comparisonName === proposed.outputPath ||
      !exactKeys(comparison, comparisonKeys) ||
      comparison.kind !== "mimic-prototype-mode-comparison" ||
      comparison.productionReady !== false ||
      typeof comparison.review !== "string" ||
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
      !Array.isArray(modePlan.choices) ||
      !modePlan.choices.every(modeChoice) ||
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
    const comparisonCurrent = comparison.current;
    const comparisonProposed = comparison.proposed;
    const hasProposed = comparison.fallback === null;
    const renderedProposed = hasProposed
      ? expectedProposedPlan(
          proposed as unknown as PrototypeBuilderInput,
          comparison.choices as unknown[],
          (modePlan.decisionContext as Record<string, unknown>).kind ===
            "historical",
        )
      : undefined;
    if (
      (!isCurrent && !isProposed) ||
      !record(slot) ||
      !exactKeys(slot, slotKeys) ||
      slot.path !== slotName ||
      slot.planDigest !== digest(plan) ||
      !record(comparisonCurrent) ||
      !exactKeys(comparisonCurrent, slotKeys) ||
      comparisonCurrent.path !== current.outputPath ||
      comparisonCurrent.planDigest !== digest(current) ||
      (hasProposed
        ? !record(comparisonProposed) ||
          !exactKeys(comparisonProposed, slotKeys) ||
          comparisonProposed.path !== proposed.outputPath ||
          !renderedProposed ||
          comparisonProposed.planDigest !== digest(renderedProposed)
        : comparisonProposed !== null)
    )
      return false;
    if (isCurrent) return same(plan, current);
    return hasProposed && same(plan, renderedProposed);
  } catch {
    return false;
  }
}
