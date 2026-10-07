import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { setupPrototypeModesFixture } from "../../../fixtures/prototype-modes/approved.js";
import { buildPrototypeModes } from "../../../packages/core/src/prototype-modes/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";

test("browser gates inspect generated Current and Proposed mode bundles", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const fixture = await setupPrototypeModesFixture();
  try {
    const modes = await buildPrototypeModes(
      fixture.store,
      fixture.modePlan,
      fixture.root,
    );
    for (const output of [modes.current, modes.proposed!]) {
      const report = await runBrowserQualityGates(
        {
          trustedRoot: fixture.root,
          directory: output.directory,
          store: fixture.store,
        },
        browser,
      );
      for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
        for (const criterion of ["browser-render", "navigation-state"])
          expect(
            report.findings.find(
              (finding) =>
                finding.criterion === criterion &&
                finding.conditions.browser === device,
            )?.state,
            `${output.directory}: ${device} ${criterion}`,
          ).toBe("PASS");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
