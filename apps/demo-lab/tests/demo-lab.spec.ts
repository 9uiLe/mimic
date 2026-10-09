import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyCatalog } from "../src/catalog-generator.js";

const catalog = path.resolve(import.meta.dirname, "../public/catalog");

async function ready(page: import("@playwright/test").Page) {
  await expect(
    page
      .frameLocator("#prototype-frame")
      .getByText("Loading synthetic candidates"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open standalone prototype/ }),
  ).toBeVisible();
}

async function clickSettled(control: import("@playwright/test").Locator) {
  await control.scrollIntoViewIfNeeded();
  // Focus changes can scroll the shell around the iframe. Wait for the actual
  // pointer target to stop moving before sending one ordinary click.
  let previousBox: string | undefined;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const bounds = await control.boundingBox();
        if (!bounds) {
          previousBox = undefined;
          stableSamples = 0;
          return 0;
        }
        const box = JSON.stringify(bounds);
        stableSamples = box === previousBox ? stableSamples + 1 : 0;
        previousBox = box;
        return stableSamples;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(2);
  await control.click();
}

test("committed catalog matches the genuine mode builder bytes", async () => {
  test.setTimeout(60_000);
  await verifyCatalog(false);
});

test("review shell renders genuine generated modes at desktop and mobile sizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await ready(page);
  await expect(page.getByLabel("Project")).toHaveValue("product_mimic");
  await expect(page.getByLabel("Experience Domain")).toHaveValue(
    "product-wide",
  );
  expect(
    Math.round((await page.locator("#device-frame").boundingBox())?.width ?? 0),
  ).toBe(880);
  const frame = page.frameLocator("#prototype-frame");
  await clickSettled(frame.getByRole("button", { name: "Show success" }));
  await expect(frame.getByText("Synthetic candidate ready")).toBeVisible();
  await clickSettled(frame.getByRole("button", { name: "Choose candidate" }));
  await expect(
    frame.getByText("Synthetic candidate selected; action disabled"),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator("#device-frame")).toHaveClass(/mobile/);
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator("#device-frame").boundingBox())?.width ?? 0,
      ),
    )
    .toBe(390);
  await page.getByRole("button", { name: "Proposed", exact: true }).focus();
  await expect(
    page.getByRole("button", { name: "Proposed", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByText(/Proposed capability is not implemented/),
  ).toBeVisible();
  await expect(
    frame.getByText(/Proposed, not implemented: candidateCompare/).first(),
  ).toBeVisible();
  await clickSettled(frame.getByRole("button", { name: "Show success" }));
  await expect(
    frame.getByRole("button", { name: "Compare candidates" }),
  ).toBeVisible();
  await clickSettled(frame.getByRole("button", { name: "Compare candidates" }));
  await expect(
    frame.getByText("Synthetic candidate selected; action disabled"),
  ).toBeVisible();
  const comparison = JSON.parse(
    await readFile(
      path.join(catalog, "candidate-review/comparison/comparison.json"),
      "utf8",
    ),
  );
  await expect(page.getByText(comparison.modePlanDigest)).toBeVisible();
  await expect(
    page.getByText(
      `${comparison.scenario.artifactId}@${comparison.scenario.revision}#${comparison.scenario.lockDigest}`,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show preview status" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Preview ready" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".skip-link").focus();
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#preview-heading$/);
  await page.getByLabel("Experience Domain").focus();
  await expect(page.getByLabel("Experience Domain")).toBeFocused();
  const axe = await new AxeBuilder({ page })
    .exclude("#prototype-frame")
    .analyze();
  expect(
    axe.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

test("dependent selection, history, and rejected Proposed fallback stay on exact scenarios", async ({
  page,
}) => {
  await page.goto(
    "/?project=unknown&domain=unknown&direction=stale&scenario=unknown&mode=proposed&viewport=invalid",
  );
  await ready(page);
  await expect(page.getByLabel("Experience Domain")).toHaveValue(
    "product-wide",
  );
  await expect(page.locator("#scenario")).toHaveValue("candidate-review");
  await expect(
    page.getByRole("button", { name: "Proposed", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Experience Domain").selectOption("domain_compare");
  await expect(page.locator("#scenario")).toHaveValue("domain-review");
  await expect(page.getByText(/art_mode_domain_scenario@1#/)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByLabel("Experience Domain")).toHaveValue(
    "product-wide",
  );
  await page.evaluate(() => history.forward());
  await expect(page.locator("#scenario")).toHaveValue("domain-review");
  await page.getByLabel("Experience Domain").selectOption("product-wide");
  await page
    .getByLabel("Direction / architecture")
    .selectOption("rejected-request");
  await expect(page.locator("#scenario")).toHaveValue("rejected-change");
  await expect(
    page.getByText(/Proposed unavailable: rejected-system-request/),
  ).toBeVisible();
  await expect(
    page.getByText("Current fallback (Proposed requested)"),
  ).toBeVisible();
  await expect(
    page
      .frameLocator("#prototype-frame")
      .getByText(/Proposed, not implemented/),
  ).toHaveCount(0);
  const comparison = JSON.parse(
    await readFile(
      path.join(catalog, "rejected-change/comparison/comparison.json"),
      "utf8",
    ),
  );
  await expect(
    page.getByText(
      `${comparison.decisionContext.requests[0].artifactId}@2#${comparison.decisionContext.requests[0].lockDigest}`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open standalone prototype/ }),
  ).toHaveAttribute(
    "href",
    "/catalog/rejected-change/comparison/current/index.html",
  );
  await page.getByRole("button", { name: "Current", exact: true }).click();
  await expect(page.getByText(/Current mode is based/)).toBeVisible();
  await page.getByRole("button", { name: "Proposed", exact: true }).click();
  await expect(page.getByText(/Current fallback/).first()).toBeVisible();
});

test("failed and rapidly superseded selections never leave stale controls active", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Proposed", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /Open standalone prototype/ }),
  ).toBeVisible();
  const showSuccess = page
    .frameLocator("#prototype-frame")
    .getByRole("button", { name: "Show success" });
  await clickSettled(showSuccess);
  await expect(
    page
      .frameLocator("#prototype-frame")
      .getByRole("button", { name: "Compare candidates" }),
  ).toBeVisible();
  await page.route(
    "**/catalog/domain-review/comparison/comparison.json",
    (route) => route.fulfill({ status: 503, body: "" }),
  );
  await page.getByLabel("Experience Domain").selectOption("domain_compare");
  await expect(
    page.getByText(/Unable to load this generated prototype/),
  ).toBeVisible();
  await expect(page.locator("#prototype-frame")).toHaveCount(0);
  await page.route(
    "**/catalog/candidate-review/comparison/comparison.json",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    },
  );
  await page.getByLabel("Experience Domain").selectOption("product-wide");
  await page
    .getByLabel("Direction / architecture")
    .selectOption("rejected-request");
  await expect(
    page.getByText(/Proposed unavailable: rejected-system-request/),
  ).toBeVisible();
  await expect(page.locator("#scenario")).toHaveValue("rejected-change");
  await expect(
    page.getByText("Current fallback (Proposed requested)"),
  ).toBeVisible();
  await page.waitForTimeout(700);
  await expect(
    page.getByText("Current fallback (Proposed requested)"),
  ).toBeVisible();
  await expect(page.locator("#prototype-frame")).toHaveCount(1);
  await expect(
    page
      .frameLocator("#prototype-frame")
      .getByText(/Proposed, not implemented/),
  ).toHaveCount(0);
});

test("local sandbox and empty or missing catalog states are explicit", async ({
  page,
}) => {
  await page.goto("/?scenario=https://example.invalid/evil");
  await ready(page);
  await expect(page.locator("#prototype-frame")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await expect(
    page.getByRole("link", { name: /Open standalone prototype/ }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  const frame = page.frameLocator("#prototype-frame");
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        return Boolean(window.top?.document.body);
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  await page.getByRole("button", { name: "Desktop" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.route("**/catalog/index.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"schemaVersion":1,"synthetic":true,"entries":[]}',
    }),
  );
  await page.reload();
  await expect(
    page.getByText("No generated prototype is available."),
  ).toBeVisible();
  await expect(page.locator("#scenario")).toBeDisabled();
  await page.unrouteAll();
  await page.route("**/catalog/index.json", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.reload();
  await expect(
    page.getByText(/Could not load the local synthetic catalog/),
  ).toBeVisible();
  await expect(page.getByLabel("Project")).toBeDisabled();
});
