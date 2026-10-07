import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import {
  inspectBundle,
  type QualityReport,
} from "../../../packages/core/src/quality-gates/index.js";
import { setupExperienceFirst } from "../../../fixtures/dogfood/experience-first/setup.js";

const criteria = [
  "browser-render",
  "axe",
  "keyboard-focus",
  "viewport-overflow",
  "navigation-state",
] as const;

function requireObservedGateCoverage(
  report: QualityReport,
  engine: "chromium" | "firefox" | "webkit",
  bundleDigest: string,
): void {
  if (
    report.target.bundleDigest !== bundleDigest ||
    report.findings.length !== 10
  )
    throw new Error("Browser gate target or criterion coverage is incomplete");
  for (const viewport of ["desktop", "mobile"] as const) {
    for (const criterion of criteria) {
      const matches = report.findings.filter(
        (finding) =>
          finding.criterion === criterion &&
          finding.conditions.browser === `${engine}-${viewport}` &&
          finding.conditions.bundleDigest === bundleDigest &&
          finding.conditions.viewportWidth ===
            (viewport === "desktop" ? 1280 : 390),
      );
      if (matches.length !== 1)
        throw new Error(
          `Missing exact ${engine}-${viewport} ${criterion} observation`,
        );
      const state = matches[0]!.state;
      if (
        state !== "PASS" &&
        !(
          engine === "webkit" &&
          criterion === "keyboard-focus" &&
          state === "FAIL"
        )
      )
        throw new Error(
          `Unverified or unexpected ${engine}-${viewport} ${criterion}: ${state}`,
        );
    }
  }
}

// This serves the builder's actual files. No Demo Lab mock is substituted.
test("Experience-first generated case states retain context on desktop and mobile", async ({
  page,
  browser,
}) => {
  // The browser gate checks both viewports and all seven states within this test.
  test.setTimeout(300_000);
  const fixture = await setupExperienceFirst();
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
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
      "content-type": name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    response.end(await readFile(path.join(output.directory, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(
      page.getByRole("heading", { name: "Synthetic C-204 case review" }),
    ).toBeVisible();
    await expect(page.getByText("C-204 · loading")).toBeVisible();
    await page.getByRole("button", { name: "Show success" }).first().click();
    await expect(page.getByText("C-204 · success")).toBeVisible();
    await expect(
      page
        .locator('[data-state="success"]:not([hidden])')
        .getByText("Return to filtered queue; draft remains uncommitted"),
    ).toBeVisible();
    for (const state of [
      "partial",
      "error",
      "permission",
      "empty",
      "disabled",
      "loading",
    ] as const) {
      await page.getByRole("button", { name: `Show ${state}` }).click();
      await expect(page.getByText(`C-204 · ${state}`)).toBeVisible();
      await expect(
        page
          .locator(`[data-state="${state}"]:not([hidden])`)
          .getByText("Queue / Review · needs-review"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Show success" }).first().click();
      await expect(page.getByText("C-204 · success")).toBeVisible();
    }
    const cards = page.locator('[data-state="success"] > div > section');
    await expect(cards).toHaveCount(3);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (!first || !second)
      throw new Error("Missing generated section position");
    if ((page.viewportSize()?.width ?? 1280) <= 640) {
      expect(Math.abs(first.x - second.x)).toBeLessThan(2);
      expect(second.y).toBeGreaterThan(first.y + first.height);
    } else {
      expect(second.x).toBeGreaterThan(first.x + first.width);
    }
    const report = await runBrowserQualityGates(
      {
        trustedRoot: fixture.root,
        directory: output.directory,
        store: fixture.store,
        uiContract: fixture.contract.ref,
      },
      browser,
    );
    const inspected = await inspectBundle({
      trustedRoot: fixture.root,
      directory: output.directory,
    });
    const engineName = browser.browserType().name();
    if (!["chromium", "firefox", "webkit"].includes(engineName))
      throw new Error(`Unexpected browser engine: ${engineName}`);
    const engine = engineName as "chromium" | "firefox" | "webkit";
    requireObservedGateCoverage(report, engine, inspected.target.bundleDigest);
    const unavailable: QualityReport = {
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        state: "UNVERIFIED" as const,
      })),
    };
    expect(() =>
      requireObservedGateCoverage(
        unavailable,
        engine,
        inspected.target.bundleDigest,
      ),
    ).toThrow("Unverified");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
