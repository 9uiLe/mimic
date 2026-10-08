import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("vanilla demo responds and has no automated accessibility violations", async ({
  page,
}) => {
  let releasePreview;
  const previewResponse = new Promise((resolve) => {
    releasePreview = resolve;
  });
  await page.route(
    "**/catalog/candidate-review/comparison/comparison.json",
    async (route) => {
      await previewResponse;
      await route.continue();
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mimic demo lab" }),
  ).toBeVisible();
  const standalone = page.getByRole("link", {
    name: /Open standalone prototype/,
  });
  await expect(standalone).toBeHidden();
  await page.getByRole("button", { name: "Show preview status" }).click();
  await expect(page.locator("#status")).toHaveText("Preview loading");
  releasePreview();
  await expect(standalone).toBeVisible();
  await page.getByRole("button", { name: "Show preview status" }).click();
  await expect(page.getByRole("status")).toHaveText("Preview ready");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
