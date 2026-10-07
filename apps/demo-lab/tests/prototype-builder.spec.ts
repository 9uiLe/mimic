import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { HtmlValidate } from "html-validate";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import { setupApprovedPrototypeFixture } from "../../../fixtures/prototypes/approved.js";

test("generated prototype supports desktop/mobile states and repeated interactions", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await setupApprovedPrototypeFixture();
  const output = await buildPrototype(
    fixture.store,
    fixture.input,
    fixture.root,
  );
  const htmlFile = path.join(output.directory, "index.html");
  const validator = new HtmlValidate(
    JSON.parse(
      await readFile(
        new URL("../../../.htmlvalidate.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const htmlReport = await validator.validateFile(htmlFile);
  expect(htmlReport.results.flatMap((result) => result.messages)).toEqual([]);
  const server = createServer(async (request, response) => {
    const name = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (
      !name ||
      !["index.html", "prototype.css", "prototype.js"].includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    const mime = name.endsWith(".css")
      ? "text/css"
      : name.endsWith(".js")
        ? "text/javascript"
        : "text/html";
    response.writeHead(200, { "content-type": mime });
    response.end(await readFile(path.join(output.directory, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(
      page.getByRole("heading", { name: "Synthetic candidate comparison" }),
    ).toBeVisible();
    const assertAccessible = async () => {
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.locator("[data-state]")).toHaveCount(
        fixture.input.requiredStates.length,
      );
      await expect(page.locator("[data-state]:not([hidden])")).toHaveCount(1);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
    };
    await expect(page.getByText("Loading synthetic candidates")).toBeVisible();
    await assertAccessible();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Show success" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Synthetic candidate ready")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "success view" }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Choose candidate" }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-state="success"]')
        .getByText("Synthetic candidate A; uncertainty visible"),
    ).toBeVisible();
    await assertAccessible();
    for (const state of [
      "empty",
      "partial",
      "error",
      "permission",
      "disabled",
      "loading",
      "error",
    ] as const) {
      await page.getByRole("button", { name: `Show ${state}` }).click();
      await expect(
        page.getByRole("heading", { name: `${state} view` }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toHaveText(`${state} state`);
      await expect(
        page.getByRole("heading", { name: `${state} view` }),
      ).toBeFocused();
      await assertAccessible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Show success" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toHaveText("success state");
      await expect(
        page.getByRole("heading", { name: "success view" }),
      ).toBeFocused();
    }
    await page.getByRole("button", { name: "Choose candidate" }).click();
    await expect(
      page.getByText("Synthetic candidate selected; action disabled"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show success" }).click();
    await expect(page.getByText("Synthetic candidate ready")).toBeVisible();
    const cards = page.locator('[data-state="success"] > div > section');
    await expect(cards).toHaveCount(2);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (!first || !second)
      throw new Error("Generated grid cards have no browser positions");
    if ((page.viewportSize()?.width ?? 1000) <= 640) {
      expect(Math.abs(first.x - second.x)).toBeLessThan(2);
      expect(second.y).toBeGreaterThan(first.y + first.height);
    } else {
      expect(second.x).toBeGreaterThan(first.x + first.width);
      expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
