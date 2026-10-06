import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { buildPrototypeModes } from "../../../packages/core/src/prototype-modes/index.js";
import { setupPrototypeModesFixture } from "../../../fixtures/prototype-modes/approved.js";

test("generated Current and Proposed modes preserve scenario and repeated desktop/mobile interactions", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await setupPrototypeModesFixture();
  const result = await buildPrototypeModes(
    fixture.store,
    fixture.modePlan,
    fixture.root,
  );
  const server = createServer(async (request, response) => {
    const parts = request.url?.split("/").filter(Boolean) ?? [];
    const [mode, name = "index.html"] = parts;
    if (
      !["current", "proposed"].includes(mode ?? "") ||
      !["index.html", "prototype.css", "prototype.js"].includes(name) ||
      parts.length > 2
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
    response.end(
      await readFile(path.join(result.comparisonDirectory, mode!, name)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    for (const mode of ["current", "proposed"] as const) {
      await page.goto(`http://127.0.0.1:${address.port}/${mode}/`);
      await expect(
        page.getByText("Loading synthetic candidates"),
      ).toBeVisible();
      if (mode === "proposed") {
        await expect(
          page
            .locator('[data-state="loading"]')
            .getByText(/Proposed, not implemented: candidateCompare/),
        ).toBeVisible();
        await expect(
          page
            .locator('[data-state="loading"]')
            .getByText(new RegExp(fixture.modeRefs.request.artifactId)),
        ).toBeVisible();
        await expect(
          page
            .locator('[data-state="loading"]')
            .getByText(
              new RegExp(fixture.modeRefs.request.lockDigest.slice(0, 19)),
            ),
        ).toBeVisible();
      } else {
        await expect(page.getByText(/Proposed, not implemented/)).toHaveCount(
          0,
        );
      }
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: "Show success" }).click();
        await expect(page.getByText("Synthetic candidate ready")).toBeVisible();
        if (mode === "proposed") {
          await expect(page.locator("#mode-notice-success")).toBeVisible();
          await page
            .getByRole("button", { name: "Compare candidates" })
            .click();
          await expect(
            page.getByText("Synthetic candidate selected; action disabled"),
          ).toBeVisible();
          await page.getByRole("button", { name: "Show success" }).click();
        }
        await page.getByRole("button", { name: "Choose candidate" }).click();
        await expect(
          page.getByText("Synthetic candidate selected; action disabled"),
        ).toBeVisible();
      }
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations).toEqual([]);
      await page.getByRole("button", { name: "Show success" }).click();
      const cards = page.locator('[data-state="success"] > div > section');
      await expect(cards).toHaveCount(mode === "proposed" ? 3 : 2);
      if (mode === "proposed")
        await expect(page.locator("#mode-notice-success")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const first = await cards.nth(0).boundingBox();
      const second = await cards.nth(1).boundingBox();
      if (!first || !second)
        throw new Error("Missing generated card positions");
      if ((page.viewportSize()?.width ?? 1000) <= 640) {
        expect(Math.abs(first.x - second.x)).toBeLessThan(2);
        expect(second.y).toBeGreaterThan(first.y + first.height);
      } else {
        expect(second.x).toBeGreaterThan(first.x + first.width);
        expect(Math.abs(first.y - second.y)).toBeLessThan(2);
      }
    }
    expect(result.proposed).toBeDefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
