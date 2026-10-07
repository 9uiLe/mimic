import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { HtmlValidate } from "html-validate";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import { buildPrototypeModes } from "../../../packages/core/src/prototype-modes/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import { runStaticQualityGates } from "../../../packages/core/src/quality-gates/index.js";
import { setupResponsiveFixture } from "../../../fixtures/prototype-responsive/approved.js";
import { setupPrototypeModesFixture } from "../../../fixtures/prototype-modes/approved.js";
import { withResponsiveMode } from "../../../fixtures/prototype-responsive/mode.js";

test("generated mobile plan changes interaction structure and survives viewport roundtrips", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await setupResponsiveFixture();
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const validator = new HtmlValidate(
    JSON.parse(
      await readFile(
        new URL("../../../.htmlvalidate.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(
    (
      await validator.validateFile(path.join(output.directory, "index.html"))
    ).results.flatMap((item) => item.messages),
  ).toEqual([]);
  const server = createServer(async (request, response) => {
    const name = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (
      !name ||
      !["index.html", "prototype.css", "prototype.js"].includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    response.end(await readFile(path.join(output.directory, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local server address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Show success" }).click();
    await expect(page.getByRole("status")).toHaveText("success state");
    const order = () =>
      page
        .locator("#candidate-root")
        .evaluate((root) =>
          [...root.children].map(
            (child) =>
              child.id || (child as HTMLElement).dataset.responsiveTarget,
          ),
        );
    const mobile = (page.viewportSize()?.width ?? 1280) <= 640;
    if (mobile) {
      expect(await order()).toEqual([
        "candidate-actions",
        "candidate-context",
        "candidate-evidence",
      ]);
      await expect(page.locator("#choose-candidate")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Choose C-204" }),
      ).toBeVisible();
    } else {
      expect(await order()).toEqual([
        "candidate-context",
        "candidate-actions",
        "candidate-evidence",
      ]);
      await expect(
        page.getByRole("button", { name: "Choose candidate" }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#mobile-choose-candidate")).toBeVisible();
    expect(await order()).toEqual([
      "candidate-actions",
      "candidate-context",
      "candidate-evidence",
    ]);
    const identity = page.getByText("Synthetic candidate C-204");
    const summary = page.getByText("Candidate identity", { exact: true });
    await expect(identity).toBeHidden();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(identity).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(identity).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("#candidate-context")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summary).toBeFocused();
    const evidence = page.getByText(
      "Synthetic uncertainty remains visible on request",
    );
    const more = page.getByText("More evidence and uncertainty", {
      exact: true,
    });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(evidence).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.locator("#mobile-choose-candidate").focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("#choose-candidate")).toBeFocused();
    await expect(page.getByRole("status")).toHaveText("success state");
    expect(await order()).toEqual([
      "candidate-context",
      "candidate-actions",
      "candidate-evidence",
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#mobile-choose-candidate")).toBeFocused();
    await expect(evidence).toBeVisible();
    await page.getByRole("button", { name: "Choose C-204" }).click();
    await expect(page.getByRole("status")).toHaveText("disabled state");
    await page.getByRole("button", { name: "Show success" }).click();
    await expect(page.getByRole("status")).toHaveText("success state");
    if (testInfo.project.name.startsWith("chromium")) {
      const report = await runBrowserQualityGates(
        {
          trustedRoot: fixture.root,
          directory: output.directory,
          store: fixture.store,
        },
        browser,
      );
      for (const item of report.findings.filter((item) =>
        ["navigation-state", "responsive-transform"].includes(item.criterion),
      ))
        expect(item.state, `${item.criterion}: ${item.reason}`).toBe("PASS");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Current and Proposed responsive bundles retain classification and visible notice", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const fixture = await setupPrototypeModesFixture();
  const result = await buildPrototypeModes(
    fixture.store,
    withResponsiveMode(fixture.modePlan),
    fixture.root,
  );
  const proposed = result.proposed!;
  const server = createServer(async (request, response) => {
    const name = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (
      !name ||
      !["index.html", "prototype.css", "prototype.js"].includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    response.end(await readFile(path.join(proposed.directory, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const output of [result.current, proposed]) {
      const input = {
        trustedRoot: fixture.root,
        directory: output.directory,
        store: fixture.store,
        uiContract: fixture.modeRefs.contract,
      };
      const staticResult = await runStaticQualityGates(input);
      expect(
        staticResult.report.findings.find(
          (item) => item.criterion === "bundle-manifest",
        )?.state,
      ).toBe("PASS");
      if (browser.browserType().name() === "chromium") {
        const gate = await runBrowserQualityGates(input, browser);
        for (const item of gate.findings.filter((item) =>
          ["navigation-state", "responsive-transform"].includes(item.criterion),
        ))
          expect(item.state, `${item.criterion}: ${item.reason}`).toBe("PASS");
      }
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local server address");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Show success" }).click();
    await expect(
      page.getByRole("heading", { name: "System mode: Proposed" }),
    ).toBeVisible();
    await expect(
      page
        .locator("#mode-notice-success")
        .getByText("Proposed, not implemented", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Candidate identity", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose mobile candidate" }),
    ).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
