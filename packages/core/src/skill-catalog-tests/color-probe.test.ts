import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  checkColorRoleProposal,
  type ColorRoleContract,
  type ColorRoleProposal,
} from "../design-knowledge/index.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const raw = readFileSync(
  path.join(root, "docs/dogfood/9ui181-color-probe-output.json.raw"),
);
const contract = JSON.parse(
  readFileSync(
    path.join(root, "knowledge/seed/color-role-contract.json"),
    "utf8",
  ),
) as ColorRoleContract;
interface Candidate extends ColorRoleProposal {
  id: string;
  rationale: string;
  fit: string;
  countercondition: string;
  tradeoff: string;
  screenDescriptions: Record<string, string>;
  sourceObservations: string;
  mimicPredictions: string;
}
const candidates = (
  JSON.parse(raw.toString("utf8")) as { strategies: Candidate[] }
).strategies;

test("raw model probe preserves three comparable provisional strategies", () => {
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "75f51de03ad751e274588ddd23b7c5622a667fb58b1cf58170e8948aa0450555",
  );
  expect(candidates.map((candidate) => candidate.id)).toEqual([
    "warm-core-quiet-surfaces",
    "sparse-signature-moments",
    "layered-utility-minimal-chroma",
  ]);
  expect(
    new Set(candidates.map((candidate) => candidate.roles["brand.accent"]))
      .size,
  ).toBe(3);
  for (const candidate of candidates) {
    expect(checkColorRoleProposal(contract, candidate)).toEqual([]);
    expect(Object.keys(candidate.screenDescriptions).sort()).toEqual(
      [...contract.requiredContexts].sort(),
    );
    expect(candidate.screenDescriptions["proposal comparison"]).toContain(
      "Resume Board",
    );
    expect(candidate.screenDescriptions["proposal comparison"]).toContain(
      "Criteria Comparison Studio",
    );
    expect(candidate.screenDescriptions["proposal comparison"]).toContain(
      "Run Timeline Investigation View",
    );
    expect(candidate.screenDescriptions["proposal comparison"]).toContain(
      "not human-approved",
    );
    expect(candidate.rationale.trim()).not.toBe("");
    expect(candidate.fit.trim()).not.toBe("");
    expect(candidate.countercondition.trim()).not.toBe("");
    expect(candidate.tradeoff.trim()).not.toBe("");
    expect(candidate.sourceObservations.trim()).not.toBe("");
    expect(candidate.mimicPredictions.trim()).not.toBe("");
  }
});
