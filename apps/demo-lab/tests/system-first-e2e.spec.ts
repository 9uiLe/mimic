import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";

test("synthetic Riverbend Current and Proposed flows work on generated desktop and mobile prototypes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const sample = path.resolve(
    import.meta.dirname,
    "../../../fixtures/dogfood/system-first/sample",
  );
  const review = JSON.parse(
    await readFile(path.join(sample, "review.json"), "utf8"),
  );
  const comparison = JSON.parse(
    await readFile(path.join(sample, "comparison/comparison.json.raw"), "utf8"),
  );
  expect(comparison.scenario).toEqual(review.scenarioAfterSimulation);
  expect(comparison.modePlanDigest).toBe(review.modePlanDigest);
  expect(
    comparison.choices.find((choice: { id: string }) => choice.id === "compare")
      ?.systemRequest,
  ).toEqual(review.systemRequest);
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
        path.join(sample, "comparison", mode!, name),
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
      await expect(page.getByText("Synthetic queue is loading")).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Open queue" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        page
          .locator('[data-state="success"]:not([hidden])')
          .getByText("WO-1042 · North · urgent · 3h · unassigned")
          .first(),
      ).toBeVisible();
      await expect(
        page.getByText("WO-1043 · West · routine · 18h · Crew B").first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Inspect WO-1042" }),
      ).toBeVisible();
      if (mode === "proposed") {
        await expect(
          page
            .locator('[data-state="success"]:not([hidden])')
            .getByText(/Proposed paired inspection: WO-1042/)
            .first(),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Proposed paired inspection: WO-1043",
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Compare WO-1042 and WO-1043" }),
        ).toBeVisible();
      } else {
        await expect(page.getByText(/Proposed paired inspection/)).toHaveCount(
          0,
        );
      }
      const cards = page.locator('[data-state="success"] > div > section');
      await expect(cards).toHaveCount(mode === "current" ? 2 : 4);
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
      if (mode === "proposed") {
        const third = await cards.nth(2).boundingBox();
        const fourth = await cards.nth(3).boundingBox();
        if (!third || !fourth) throw new Error("No paired card positions");
        if ((page.viewportSize()?.width ?? 1000) <= 640) {
          expect(Math.abs(third.x - fourth.x)).toBeLessThan(2);
          expect(fourth.y).toBeGreaterThan(third.y + third.height);
        } else {
          expect(fourth.x).toBeGreaterThan(third.x + third.width);
          expect(Math.abs(third.y - fourth.y)).toBeLessThan(2);
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (process.env.MIMIC_EXPORT_SYSTEM_FIRST === "1") {
        const screenshots = path.resolve(
          import.meta.dirname,
          "../../../fixtures/dogfood/system-first/sample/screens",
        );
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({
          path: path.join(
            screenshots,
            `${test.info().project.name}-${mode}.png`,
          ),
          fullPage: true,
        });
      }
      await page.getByRole("button", { name: "Inspect WO-1042" }).click();
      await expect(
        page.getByRole("heading", { name: "WO-1042 detail" }),
      ).toBeVisible();
      await expect(
        page.getByText("WO-1042 · North · urgent · 3h · unassigned").last(),
      ).toBeVisible();
      if (mode === "proposed") {
        await expect(
          page
            .locator('[data-state="partial"]:not([hidden])')
            .getByText(/Comparison endpoint is absent/),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Proposed paired inspection: WO-1043",
          }),
        ).toBeVisible();
        await expect(
          page
            .locator('[data-state="partial"]:not([hidden])')
            .getByText("West · routine · 18h · Crew B", { exact: true }),
        ).toBeVisible();
      }
      await page
        .getByRole("button", { name: "Assign Crew A to WO-1042" })
        .click();
      await expect(
        page.getByText(/Crew A selected in synthetic local state/),
      ).toBeVisible();
      await page.getByRole("button", { name: "Return to queue" }).click();
      await expect(
        page
          .locator('[data-state="success"]:not([hidden])')
          .getByText("WO-1042 · North · urgent · 3h · unassigned")
          .first(),
      ).toBeVisible();
      if (mode === "proposed") {
        await page
          .getByRole("button", { name: "Compare WO-1042 and WO-1043" })
          .click();
        await expect(
          page
            .locator('[data-state="partial"]:not([hidden])')
            .getByText(/Comparison endpoint is absent/),
        ).toBeVisible();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
