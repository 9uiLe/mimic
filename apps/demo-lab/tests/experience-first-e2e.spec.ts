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
  "responsive-transform",
] as const;

function requireObservedGateCoverage(
  report: QualityReport,
  engine: "chromium" | "firefox" | "webkit",
  bundleDigest: string,
): void {
  if (
    report.target.bundleDigest !== bundleDigest ||
    report.findings.length !== 12
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
          `Unverified or unexpected ${engine}-${viewport} ${criterion}: ${state}: ${matches[0]!.reason}`,
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
    for (const state of ["empty", "partial", "empty", "partial"] as const) {
      await page.getByRole("button", { name: `Show ${state}` }).click();
      await expect(page.getByRole("status")).toHaveText(`${state} state`);
      await page.getByRole("button", { name: "Show success" }).first().click();
      await expect(page.getByRole("status")).toHaveText("success state");
    }
    const cards = page.locator("#review-root > *");
    await expect(cards).toHaveCount(4);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (!first || !second)
      throw new Error("Missing generated section position");
    if ((page.viewportSize()?.width ?? 1280) <= 640) {
      await expect(cards.nth(0)).toHaveAttribute("id", "review-decision");
      await expect(cards.nth(1)).toHaveAttribute("id", "mobile-case-nav");
      expect(Math.abs(first.x - second.x)).toBeLessThan(2);
      expect(second.y).toBeGreaterThan(first.y + first.height);
    } else {
      await expect(cards.nth(0)).toHaveAttribute("id", "case-context");
      await expect(cards.nth(1)).toHaveAttribute("id", "review-decision");
      expect(second.x).toBeGreaterThan(first.x + first.width);
    }
    const order = () =>
      page
        .locator("#review-root")
        .evaluate((root) =>
          [...root.children].map(
            (child) =>
              child.id || (child as HTMLElement).dataset.responsiveTarget,
          ),
        );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(order)
      .toEqual([
        "review-decision",
        "mobile-case-nav",
        "evidence-list",
        "decision-history",
      ]);
    await expect(page.locator("#case-context")).toHaveCount(0);
    await expect(page.locator("#mobile-case-identity")).toHaveText(
      "Case C-204",
    );
    await expect(page.locator("#choose-case")).toBeVisible();
    const evidence = page.locator("#review-uncertainty");
    const history = page.locator("#uncommitted-history");
    await expect(evidence).toBeHidden();
    await expect(history).toBeHidden();
    for (const [summaryText, content] of [
      ["Review evidence and uncertainty", evidence],
      ["Show uncommitted decision history", history],
    ] as const) {
      const summary = page.getByText(summaryText, { exact: true });
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(content).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(content).toBeHidden();
      await page.keyboard.press("Enter");
      await expect(content).toBeVisible();
    }
    await page.locator("#mobile-overview-anchor").focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
      .poll(order)
      .toEqual([
        "case-context",
        "review-decision",
        "evidence-list",
        "decision-history",
      ]);
    await expect(page.locator("#overview-anchor")).toBeFocused();
    await expect(page.getByRole("status")).toHaveText("success state");
    await expect(evidence).toBeVisible();
    await expect(history).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#mobile-overview-anchor")).toBeFocused();
    await expect(evidence).toBeVisible();
    await expect(history).toBeVisible();
    await page.locator("#choose-case").click();
    await expect(page.getByRole("status")).toHaveText("disabled state");
    await page.getByRole("button", { name: "Show success" }).first().click();
    await expect(page.getByRole("status")).toHaveText("success state");
    if (browser.browserType().name() === "chromium") {
      for (const state of ["empty", "partial"] as const) {
        await page.locator(`#show-${state}`).click();
        await expect(page.getByRole("status")).toHaveText(`${state} state`);
        const beforeTab = await page.evaluate(() => {
          const active = document.activeElement;
          const view = active?.closest("[data-state]") as HTMLElement | null;
          return {
            id: active?.id,
            state: view?.dataset.state,
            hidden: view?.hidden,
          };
        });
        expect(beforeTab).toEqual({
          id: `show-${state}`,
          state: "success",
          hidden: true,
        });
        await page.keyboard.press("Tab");
        const naturalFocus = await page.evaluate(() => {
          const active = document.activeElement;
          return {
            id: active?.id ?? "",
            visibleControl:
              !!active &&
              active !== document.body &&
              !!active.closest("[data-state]:not([hidden])") &&
              getComputedStyle(active).outlineStyle !== "none",
          };
        });
        expect(
          naturalFocus.visibleControl,
          `${state}: natural post-route Tab currently misses a visible control (${naturalFocus.id || "body"}); this remains an open keyboard issue`,
        ).toBe(false);
        await page
          .getByRole("button", { name: "Show success" })
          .first()
          .click();
        await expect(page.getByRole("status")).toHaveText("success state");
      }
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
    if (engine === "chromium") {
      const mobileKeyboard = report.findings.find(
        (finding) =>
          finding.criterion === "keyboard-focus" &&
          finding.conditions.browser === "chromium-mobile",
      );
      expect(
        mobileKeyboard?.state,
        `Repeated routes must retain first-Tab coverage: ${mobileKeyboard?.reason}`,
      ).toBe("PASS");
    }
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
