import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildPrototypeJourney } from "../../../packages/core/src/prototype-journey/index.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import { setupPrototypeJourney } from "../../../fixtures/prototype-journey/setup.js";
import { authoredReplacementSurfacePlan } from "../../../fixtures/prototype-journey/plan.js";
import { authoredJourneyModes } from "../../../fixtures/prototype-journey/modes.js";
import { buildPrototypeJourneyModes } from "../../../packages/core/src/prototype-modes/journey.js";

for (const width of [1280, 390]) {
  test(
    "emitted C-204 journey retains independent drafts and focus at " +
      width +
      "px",
    async ({ page }) => {
      test.setTimeout(120_000);
      const fixture = await setupPrototypeJourney();
      const output = await buildPrototypeJourney(
        fixture.store,
        fixture.journeyPlan,
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
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No server address");
        await page.setViewportSize({ width, height: 850 });
        await page.goto("http://127.0.0.1:" + address.port + "/");
        const filter = page.getByRole("searchbox", {
          name: "Filter cases by status",
        });
        await expect(page.locator('[data-view="queue"]')).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open C-206" }),
        ).toBeVisible();
        await filter.fill("needs-review");
        await expect(
          page.getByRole("button", { name: "Open C-204" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open C-205" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open C-206" }),
        ).toBeHidden();
        await page.getByRole("button", { name: "Open C-204" }).click();
        await expect(page.locator('[data-view="review"]')).toBeVisible();
        await expect(page).toHaveURL(/#review$/);
        const identity = page
          .locator("#review__case-identity, #review__mobile-case-identity")
          .filter({ visible: true });
        await expect(identity).toHaveText("C-204");
        const draft = page.getByRole("textbox", {
          name: "Uncommitted review draft",
        });
        await draft.fill("Distinctive C-204 draft <uncommitted>");
        await expect(page.locator("#review__draft-preview")).toHaveText(
          "Distinctive C-204 draft <uncommitted>",
        );
        await expect(page.locator("#review__approval-state")).toHaveText(
          "pending",
        );
        await expect(page.locator("#review__decision-state")).toHaveText(
          "none",
        );
        await page
          .getByRole("button", { name: "Return to filtered queue" })
          .click();
        await expect(filter).toHaveValue("needs-review");
        await expect(filter).toBeFocused();
        await expect(
          page.getByRole("button", { name: "Open C-206" }),
        ).toBeHidden();
        await page.getByRole("button", { name: "Open C-204" }).click();
        await expect(draft).toHaveValue(
          "Distinctive C-204 draft <uncommitted>",
        );
        await page
          .getByRole("button", { name: "Return to filtered queue" })
          .click();
        await page.getByRole("button", { name: "Open C-205" }).click();
        await expect(identity).toHaveText("C-205");
        await expect(draft).toHaveValue("");
        await draft.fill("Separate C-205 draft");
        await page
          .getByRole("button", { name: "Return to filtered queue" })
          .click();
        await page.getByRole("button", { name: "Open C-204" }).click();
        await expect(draft).toHaveValue(
          "Distinctive C-204 draft <uncommitted>",
        );
        await page.getByRole("button", { name: "Discard draft" }).click();
        await expect(draft).toHaveValue("");
        await expect(page.locator("#review__draft-preview")).toHaveText("");
        await expect(page.locator("#review__approval-state")).toHaveText(
          "pending",
        );
        await expect(page.locator("#review__decision-state")).toHaveText(
          "none",
        );
        await page.getByRole("button", { name: "Show error" }).click();
        await expect(
          page.locator('[data-view="review"] [data-state="error"]'),
        ).toBeVisible();
        await expect(
          page.locator('[data-view="review"] [data-state="error"] h2').first(),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          page
            .locator('[data-view="review"] [data-state="error"]')
            .getByRole("button", { name: "Show success" })
            .first(),
        ).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(
          page.locator('[data-view="review"] [data-state="success"]'),
        ).toBeVisible();
        await page.setViewportSize({
          width: width === 1280 ? 390 : 1280,
          height: 850,
        });
        await expect(identity).toHaveText("C-204");
        await expect(draft).toHaveValue("");
        await page.setViewportSize({ width, height: 850 });
        await expect(identity).toHaveText("C-204");
        const axe = await new AxeBuilder({ page }).analyze();
        expect(axe.violations).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );
}

function journeyPhase(name: string) {
  const started = performance.now();
  let previous = started;
  return (phase: string, detail: Record<string, unknown> = {}) => {
    const now = performance.now();
    console.log(
      "9UI-155 phase " +
        name +
        " " +
        phase +
        ": " +
        JSON.stringify({
          totalMs: Math.round(now - started),
          deltaMs: Math.round(now - previous),
          ...detail,
        }),
    );
    previous = now;
  };
}

async function replacementBundle(log: ReturnType<typeof journeyPhase>) {
  const fixture = await setupPrototypeJourney();
  log("fixture ready");
  try {
    const plan = authoredReplacementSurfacePlan(fixture.journeyPlan);
    const output = await buildPrototypeJourney(
      fixture.store,
      plan,
      fixture.root,
    );
    log("bundle built");
    return { fixture, output };
  } catch (error) {
    await rm(fixture.root, { recursive: true, force: true });
    throw error;
  }
}

function logJourneyFindings(
  log: ReturnType<typeof journeyPhase>,
  report: Awaited<ReturnType<typeof runBrowserQualityGates>>,
) {
  log("gate complete", {
    findings: report.findings.map((finding) => ({
      criterion: finding.criterion,
      width: finding.conditions.viewportWidth,
      state: finding.state,
      observations: finding.conditions.observations,
      ...(finding.state === "PASS"
        ? {}
        : { reason: finding.reason, evidence: finding.evidence }),
    })),
  });
}

async function removeReplacementFixture(
  root: string,
  log: ReturnType<typeof journeyPhase>,
) {
  await rm(root, { recursive: true, force: true });
  log("fixture removed");
}

test("replacement return control survives desktop/mobile startup and both resize directions", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const log = journeyPhase("direct");
  const { fixture, output } = await replacementBundle(log);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    server = createServer(async (request, response) => {
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
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    log("server listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server address");
    for (const start of [1280, 390]) {
      log("direct width start", { width: start });
      await page.setViewportSize({ width: start, height: 850 });
      await page.goto("http://127.0.0.1:" + address.port + "/");
      const filter = page.getByRole("searchbox", {
        name: "Filter cases by status",
      });
      await filter.fill("x".repeat(120));
      expect(
        await filter.evaluate((node: HTMLInputElement) => node.value.length),
      ).toBe(100);
      await filter.fill("not-present");
      await expect(page.getByText("No matching cases")).toBeVisible();
      await filter.fill("needs-review");
      await page.getByRole("button", { name: "Open C-204" }).click();
      const draft = page.getByRole("textbox", {
        name: "Uncommitted review draft",
      });
      await draft.fill("x".repeat(4100));
      expect(
        await draft.evaluate((node: HTMLInputElement) => node.value.length),
      ).toBe(4000);
      await draft.fill("Return replacement draft " + start);
      await page.setViewportSize({
        width: start === 1280 ? 390 : 1280,
        height: 850,
      });
      const swappedReturn = page.locator(
        start === 1280 ? "#review__return-mobile" : "#review__return-success",
      );
      await expect(swappedReturn).toBeVisible();
      await swappedReturn.click();
      await expect(filter).toHaveValue("needs-review");
      await expect(
        page.locator(
          start === 1280 ? "#queue__mobile-open-c204" : "#queue__open-c204",
        ),
      ).toBeFocused();
      await filter.fill("not-present");
      await expect(page.getByText("No matching cases")).toBeVisible();
      await filter.fill("needs-review");
      await page.getByRole("button", { name: "Open C-204" }).click();
      await expect(draft).toHaveValue("Return replacement draft " + start);
      await page.setViewportSize({ width: start, height: 850 });
      const originalReturn = page.locator(
        start === 1280 ? "#review__return-success" : "#review__return-mobile",
      );
      await expect(originalReturn).toBeVisible();
      await originalReturn.click();
      await expect(
        page.locator(
          start === 1280 ? "#queue__open-c204" : "#queue__mobile-open-c204",
        ),
      ).toBeFocused();
      await page.getByRole("button", { name: "Open C-205" }).click();
      await expect(draft).toHaveValue("");
      await expect(page.locator('[data-view="review"]')).not.toContainText(
        "C-204",
      );
      await page
        .getByRole("button", { name: "Show error", exact: true })
        .click();
      await expect(page.locator('[data-view="review"]')).not.toContainText(
        "C-204",
      );
      expect(errors).toEqual([]);
      log("direct width complete", {
        width: start,
        pageErrors: errors,
        consoleErrors,
      });
    }
  } catch (error) {
    log("body failed", {
      error: String(error),
      pageErrors: errors,
      consoleErrors,
    });
    throw error;
  } finally {
    const cleanup = async (phase: string, action: () => Promise<void>) => {
      try {
        await action();
        log(phase);
      } catch (error) {
        cleanupErrors.push(error);
        log(phase + " failed", { error: String(error) });
      }
    };
    await cleanup("page closed", async () => {
      await page.close();
    });
    await cleanup("context closed", async () => {
      await context.close();
    });
    if (server?.listening) {
      const ownedServer = server;
      await cleanup("server closed", async () => {
        const closed = new Promise<void>((resolve, reject) =>
          ownedServer.close((error) => (error ? reject(error) : resolve())),
        );
        ownedServer.closeAllConnections();
        await closed;
      });
    }
    await cleanup("fixture removed", async () => {
      await rm(fixture.root, { recursive: true, force: true });
    });
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      "Replacement journey cleanup failed",
    );
});

test("replacement journey normal gates pass at both widths", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const log = journeyPhase("normal gate");
  const { fixture, output } = await replacementBundle(log);
  let cleanupError: unknown;
  try {
    log("gate start");
    const report = await runBrowserQualityGates(
      {
        trustedRoot: fixture.root,
        directory: output.directory,
        store: fixture.store,
        uiContract: fixture.contract.ref,
      },
      browser,
    );
    logJourneyFindings(log, report);
    for (const width of [1280, 390])
      for (const criterion of [
        "journey-render",
        "journey-actions",
        "journey-continuity",
        "journey-axe",
        "journey-keyboard",
        "journey-overflow",
      ]) {
        const finding = report.findings.find(
          (item) =>
            item.criterion === criterion &&
            item.conditions.viewportWidth === width,
        );
        expect(
          finding?.state,
          criterion + " " + width + ": " + finding?.reason,
        ).toBe("PASS");
      }
  } catch (error) {
    log("body failed", { error: String(error) });
    throw error;
  } finally {
    try {
      await removeReplacementFixture(fixture.root, log);
    } catch (error) {
      log("fixture removal failed", { error: String(error) });
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
});

test("replacement journey sabotage fails actions at both widths", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const log = journeyPhase("sabotaged gate");
  const { fixture, output } = await replacementBundle(log);
  let cleanupError: unknown;
  try {
    log("gate start");
    const sabotagedBrowser = new Proxy(browser, {
      get(target, property) {
        if (property === "newContext")
          return async (...args: Parameters<typeof browser.newContext>) => {
            const context = await target.newContext(...args);
            await context.addInitScript(() => {
              document.addEventListener(
                "click",
                (event) => {
                  const button =
                    event.target instanceof Element
                      ? event.target.closest("button[id]")
                      : null;
                  if (
                    button?.id === "review__second-show-error" ||
                    button?.id === "review__return-mobile"
                  )
                    event.stopImmediatePropagation();
                },
                true,
              );
            });
            return context;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sabotaged = await runBrowserQualityGates(
      {
        trustedRoot: fixture.root,
        directory: output.directory,
        store: fixture.store,
        uiContract: fixture.contract.ref,
      },
      sabotagedBrowser,
    );
    logJourneyFindings(log, sabotaged);
    const actionFindings = sabotaged.findings.filter(
      (finding) => finding.criterion === "journey-actions",
    );
    expect(actionFindings.map((finding) => finding.state)).toEqual([
      "FAIL",
      "FAIL",
    ]);
    expect(actionFindings[0]!.reason).toContain("second-show-error");
    expect(actionFindings[1]!.reason).toContain("second-show-error");
    expect(actionFindings[1]!.reason).toContain("return-mobile");
  } catch (error) {
    log("body failed", { error: String(error) });
    throw error;
  } finally {
    try {
      await removeReplacementFixture(fixture.root, log);
    } catch (error) {
      log("fixture removal failed", { error: String(error) });
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
});

test("journey browser gates observe all declared actions on the exact bundle", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fixture = await setupPrototypeJourney();
  try {
    const output = await buildPrototypeJourney(
      fixture.store,
      fixture.journeyPlan,
      fixture.root,
    );
    const report = await runBrowserQualityGates(
      {
        trustedRoot: fixture.root,
        directory: output.directory,
        store: fixture.store,
        uiContract: fixture.contract.ref,
      },
      browser,
    );
    for (const width of [1280, 390]) {
      for (const criterion of [
        "journey-render",
        "journey-actions",
        "journey-continuity",
        "journey-axe",
        "journey-keyboard",
        "journey-overflow",
      ]) {
        const finding = report.findings.find(
          (item) =>
            item.criterion === criterion &&
            item.conditions.viewportWidth === width,
        );
        expect(finding, criterion + " " + width).toBeDefined();
        expect(finding?.state, finding?.reason).toBe("PASS");
        expect(Number(finding?.conditions.observations)).toBeGreaterThan(0);
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Proposed notice survives route, semantic status and mobile transformation", async ({
  page,
}) => {
  const fixture = await setupPrototypeJourney({ withModes: true });
  const modes = authoredJourneyModes(fixture);
  const result = await buildPrototypeJourneyModes(
    fixture.store,
    modes,
    fixture.root,
  );
  const directory = result.proposed!.directory;
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
    response.end(await readFile(path.join(directory, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:" + address.port + "/");
    const notice = () =>
      page
        .locator("[data-view]:not([hidden]) [data-state]:not([hidden])")
        .getByText("System mode: Proposed", { exact: true });
    await expect(notice()).toBeVisible();
    await page.locator("#queue__queue-show-error").click();
    await expect(notice()).toBeVisible();
    await page.getByRole("button", { name: "Show success" }).click();
    await page.locator("#queue__open-c204").click();
    await expect(notice()).toBeVisible();
    await page.locator("#review__proposed-preview").click();
    await expect(
      page.locator('[data-view="review"] [data-state="partial"]'),
    ).toBeVisible();
    await expect(notice()).toBeVisible();
    await page
      .getByRole("button", { name: "Return to filtered queue" })
      .click();
    await expect(notice()).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
