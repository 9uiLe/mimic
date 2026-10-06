import { test, expect } from "vitest";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPrototypeModes } from "../../../packages/core/src/prototype-modes/index.js";
import { setupPrototypeModesFixture } from "../../../fixtures/prototype-modes/approved.js";

const catalogRoot = path.resolve(import.meta.dirname, "../public/catalog");
const cases = [
  {
    id: "candidate-review",
    options: {},
    project: { id: "product_mimic", label: "Mimic synthetic study" },
    domain: { id: "product-wide", label: "Product-wide candidate review" },
    direction: {
      id: "candidate-comparison",
      label: "Candidate comparison (illustrative)",
    },
    scenarioLabel: "Choose a candidate",
  },
  {
    id: "domain-review",
    options: { domainScenario: true },
    project: { id: "product_mimic", label: "Mimic synthetic study" },
    domain: { id: "domain_compare", label: "Comparison domain" },
    direction: {
      id: "candidate-comparison",
      label: "Candidate comparison (illustrative)",
    },
    scenarioLabel: "Review a domain candidate",
  },
  {
    id: "rejected-change",
    options: { laterRejectedDecision: true },
    project: { id: "product_mimic", label: "Mimic synthetic study" },
    domain: { id: "product-wide", label: "Product-wide candidate review" },
    direction: {
      id: "rejected-request",
      label: "Rejected comparison request (illustrative)",
    },
    scenarioLabel: "Choose a candidate after rejection",
  },
] as const;

async function filesAt(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(relative: string) {
    for (const item of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, item.name);
      if (item.isDirectory()) await visit(name);
      else result.push(name);
    }
  }
  await visit("");
  return result.sort();
}

test("the committed synthetic catalog matches exact builder output", async () => {
  const entries = [];
  for (const item of cases) {
    const fixture = await setupPrototypeModesFixture(item.options);
    try {
      const result = await buildPrototypeModes(
        fixture.store,
        fixture.modePlan,
        fixture.root,
      );
      const destination = path.join(catalogRoot, item.id, "comparison");
      if (process.env.WRITE_CATALOG === "1") {
        await rm(destination, { recursive: true, force: true });
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(result.comparisonDirectory, destination, { recursive: true });
      } else {
        const generatedFiles = await filesAt(result.comparisonDirectory);
        expect(await filesAt(destination)).toEqual(generatedFiles);
        for (const file of generatedFiles)
          expect(await readFile(path.join(destination, file))).toEqual(
            await readFile(path.join(result.comparisonDirectory, file)),
          );
      }
      entries.push({
        id: item.id,
        project: item.project,
        domain: item.domain,
        direction: item.direction,
        scenario: { ...fixture.modeRefs.scenario, label: item.scenarioLabel },
        comparisonPath: `/catalog/${item.id}/comparison`,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  const index = `${JSON.stringify({ schemaVersion: 1, synthetic: true, entries }, null, 2)}\n`;
  if (process.env.WRITE_CATALOG === "1") {
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(path.join(catalogRoot, "index.json"), index);
  } else {
    expect(await readFile(path.join(catalogRoot, "index.json"), "utf8")).toBe(
      index,
    );
  }
});
