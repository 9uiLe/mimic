import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
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
    await expect(page.getByText("Loading synthetic candidates")).toBeVisible();
    await page.getByRole("button", { name: "Show success" }).click();
    await expect(page.getByText("Synthetic candidate ready")).toBeVisible();
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
      await page.getByRole("button", { name: "Show success" }).click();
      await expect(page.getByRole("status")).toHaveText("success state");
    }
    const columns = await page
      .locator('[data-state="success"] main')
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBe((page.viewportSize()?.width ?? 1000) <= 640 ? 1 : 2);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
