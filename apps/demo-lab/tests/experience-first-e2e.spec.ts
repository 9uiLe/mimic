import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import { setupExperienceFirst } from "../../../fixtures/dogfood/experience-first/setup.js";

// This serves the builder's actual files. No Demo Lab mock is substituted.
test("Experience-first generated case states retain context on desktop and mobile", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
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
    const failures = report.findings.filter(
      (finding) => finding.state === "FAIL",
    );
    if (test.info().project.name.startsWith("webkit")) {
      // WebKit focus behavior varies by host. Preserve any observed FAIL and
      // reject failures outside the known first-Tab criterion.
      expect(
        failures.filter((finding) => finding.criterion !== "keyboard-focus"),
        JSON.stringify(failures),
      ).toEqual([]);
    } else {
      expect(failures, JSON.stringify(failures)).toEqual([]);
    }
    expect(report.findings.length).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
