import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("vanilla demo responds and has no automated accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mimic demo lab" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show preview status" }).click();
  await expect(page.getByRole("status")).toHaveText("Preview ready");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
