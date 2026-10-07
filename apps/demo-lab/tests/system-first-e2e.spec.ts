import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { buildPrototypeModes } from "../../../packages/core/src/prototype-modes/index.js";
import { setupSystemFirst } from "../../../fixtures/dogfood/system-first/setup.js";

test("synthetic Riverbend Current and Proposed flows work on generated desktop and mobile prototypes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await setupSystemFirst();
  const generated = await buildPrototypeModes(
    fixture.runtime.artifacts,
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
    try {
      const bytes = await readFile(
        path.join(generated.comparisonDirectory, mode!, name),
      );
      response
        .writeHead(200, {
          "content-type": name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".js")
              ? "text/javascript"
              : "text/html",
        })
        .end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local port");
    for (const mode of ["current", "proposed"] as const) {
      await page.goto(`http://127.0.0.1:${address.port}/${mode}/`);
      await expect(
        page.getByRole("heading", { name: /Riverbend Repairs/ }),
      ).toBeVisible();
      await expect(
        page.getByText("Loading synthetic work orders"),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Show success" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        page
          .locator('[data-state="success"]:not([hidden])')
          .getByText("WO-1042 · North · urgent · 3h · unassigned"),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Choose work order" }),
      ).toBeVisible();
      if (mode === "proposed") {
        await expect(
          page
            .locator('[data-state="success"]:not([hidden])')
            .getByText(/Proposed, not implemented/)
            .first(),
        ).toBeVisible();
        await expect(
          page.getByText(/WO-1042 and WO-1043 comparison/),
        ).toBeVisible();
        await expect(
          page
            .locator('[data-state="success"]:not([hidden])')
            .getByText(new RegExp(fixture.refs.request.artifactId))
            .first(),
        ).toBeVisible();
      } else {
        await expect(page.getByText(/Proposed, not implemented/)).toHaveCount(
          0,
        );
      }
      const cards = page.locator('[data-state="success"] > div > section');
      await expect(cards).toHaveCount(mode === "current" ? 2 : 3);
      const first = await cards.nth(0).boundingBox();
      const second = await cards.nth(1).boundingBox();
      if (!first || !second) throw new Error("No generated card positions");
      if ((page.viewportSize()?.width ?? 1000) <= 640) {
        expect(Math.abs(first.x - second.x)).toBeLessThan(2);
        expect(second.y).toBeGreaterThan(first.y + first.height);
      } else {
        expect(second.x).toBeGreaterThan(first.x + first.width);
        expect(Math.abs(first.y - second.y)).toBeLessThan(2);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: "Choose work order" }).click();
      await expect(
        page.getByText("Synthetic work order selected; action disabled"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Show success" }).click();
      await expect(
        page
          .locator('[data-state="success"]:not([hidden])')
          .getByText("WO-1042 · North · urgent · 3h · unassigned"),
      ).toBeVisible();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
});
