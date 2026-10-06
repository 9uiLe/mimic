import { chromium, expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import { setupApprovedPrototypeFixture } from "../../../fixtures/prototypes/approved.js";
import {
  brokenTransition,
  inaccessibleImage,
  overflowingUnfocusedCss,
} from "../../../fixtures/quality-gates/regressions.js";

test("browser gates inspect generated states and detect a broken transition", async () => {
  test.setTimeout(120_000);
  const fixture = await setupApprovedPrototypeFixture();
  let gateBrowser: Browser | undefined;
  try {
    gateBrowser = await chromium.launch();
    const output = await buildPrototype(
      fixture.store,
      fixture.input,
      fixture.root,
    );
    const input = { trustedRoot: fixture.root, directory: output.directory };
    const good = await runBrowserQualityGates(input, gateBrowser);
    const unavailable = await runBrowserQualityGates(input, {
      async newContext() {
        throw new Error("synthetic browser launch failure");
      },
    } as unknown as Browser);
    expect(
      unavailable.findings.filter((item) => item.state === "UNVERIFIED"),
    ).toHaveLength(10);
    expect(good.target.planDigest).toBe(output.planDigest);
    for (const device of ["chromium-desktop", "chromium-mobile"])
      for (const criterion of [
        "browser-render",
        "axe",
        "keyboard-focus",
        "viewport-overflow",
        "navigation-state",
      ])
        expect(
          good.findings.find(
            (item) =>
              item.criterion === criterion &&
              item.conditions.browser === device,
          )?.state,
          `${device} ${criterion}`,
        ).toBe("PASS");

    const script = path.join(output.directory, "prototype.js");
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace(
        "if (button) show(button.getAttribute('data-target-state'));",
        brokenTransition,
      ),
    );
    const broken = await runBrowserQualityGates(input, gateBrowser);
    for (const device of ["chromium-desktop", "chromium-mobile"])
      expect(
        broken.findings.find(
          (item) =>
            item.criterion === "navigation-state" &&
            item.conditions.browser === device,
        )?.state,
      ).toBe("FAIL");
    expect(broken.target.bundleDigest).not.toBe(good.target.bundleDigest);
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace(
        brokenTransition,
        "if (button) show(button.getAttribute('data-target-state'));",
      ),
    );
    const htmlFile = path.join(output.directory, "index.html");
    await writeFile(
      htmlFile,
      (await readFile(htmlFile, "utf8")).replace(
        "</body>",
        `${inaccessibleImage}</body>`,
      ),
    );
    const cssFile = path.join(output.directory, "prototype.css");
    await writeFile(
      cssFile,
      (await readFile(cssFile, "utf8")) + overflowingUnfocusedCss,
    );
    const impaired = await runBrowserQualityGates(input, gateBrowser);
    for (const device of ["chromium-desktop", "chromium-mobile"])
      for (const criterion of ["axe", "viewport-overflow", "keyboard-focus"])
        expect(
          impaired.findings.find(
            (item) =>
              item.criterion === criterion &&
              item.conditions.browser === device,
          )?.state,
          `${device} ${criterion}`,
        ).toBe("FAIL");
  } finally {
    await gateBrowser?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
