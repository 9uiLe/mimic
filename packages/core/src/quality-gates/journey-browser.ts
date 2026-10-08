/// <reference lib="dom" />
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AxeBuilder } from "@axe-core/playwright";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type {
  PrototypeJourneyInput,
  JourneyControl,
  JourneyView,
  JourneyAction,
} from "../prototype-journey/index.js";
import {
  journeyNodeSurfaces,
  materializeJourneyTransitions,
  type JourneyTransition,
} from "../prototype-journey/index.js";
import type {
  PrototypeNode,
  PrototypeState,
} from "../prototype-builder/index.js";
import { runStaticJourneyQualityGates } from "./journey.js";
import type { GateFinding, GateInput, QualityReport } from "./index.js";
import {
  assertPatchedChrome,
  patchedChromeLaunchOptions,
} from "./patched-chrome.js";

function finding(
  criterion: string,
  state: GateFinding["state"],
  reason: string,
  bundleDigest: string,
  browser: string,
  width: number,
  observations: number,
): GateFinding {
  return {
    criterion,
    state,
    severity: "MAJOR",
    reason,
    evidence: ["index.html", "prototype.js", "plan.json", "manifest.json"],
    conditions: {
      bundleDigest,
      browser,
      viewportWidth: width,
      synthetic: true,
      observations,
    },
    limitations:
      "Browser observations are synthetic and same-session only; no human approval or empirical usability is inferred",
  };
}
function stateOf(
  view: JourneyView,
  nodeId: string,
): PrototypeState | undefined {
  const has = (root: PrototypeNode): boolean =>
    root.id === nodeId || (root.children?.some(has) ?? false);
  for (const state of view.render.states)
    if (has(state.root)) return state.name;
  for (const entry of view.render.responsive?.states ?? [])
    for (const operation of entry.operations)
      if (operation.kind === "replace" && has(operation.with))
        return entry.state;
  return undefined;
}
function stateButtons(view: JourneyView, width: number): JourneyTransition[] {
  const surface = width === 390 ? "mobile" : "desktop";
  return materializeJourneyTransitions(view).transitions.filter((item) =>
    item.surfaces.includes(surface),
  );
}
function available(
  plan: PrototypeJourneyInput,
  control: JourneyControl,
  width: number,
): boolean {
  const view = plan.views.find((item) => item.id === control.viewId)!;
  return journeyNodeSurfaces(view, control.nodeId).includes(
    width === 390 ? "mobile" : "desktop",
  );
}
function expectedReturnFocus(
  plan: PrototypeJourneyInput,
  control: JourneyControl,
  width: number,
): string {
  if (control.action.kind !== "select")
    throw new Error("Return focus requires a selection");
  let id = control.action.returnFocusId;
  const view = plan.views.find((item) => item.id === control.viewId)!;
  for (const entry of view.render.responsive?.states ?? [])
    for (const operation of entry.operations)
      if (operation.kind === "replace")
        for (const mapping of operation.focusMap) {
          if (width === 390 && mapping.desktopId === id) id = mapping.mobileId;
          if (width !== 390 && mapping.mobileId === id) id = mapping.desktopId;
        }
  return domId(control.viewId, id);
}
function domId(viewId: string, nodeId: string): string {
  return viewId + "__" + nodeId;
}
function activeState(page: Page, viewId: string, status: string) {
  return page.locator(
    '[data-view="' + viewId + '"] [data-state="' + status + '"]:not([hidden])',
  );
}
async function enterView(
  page: Page,
  plan: PrototypeJourneyInput,
  target: string,
  width: number,
): Promise<void> {
  if (target === plan.initialViewId) return;
  const source = plan.controls.find(
    (control) =>
      control.viewId === plan.initialViewId &&
      (control.action.kind === "select" ||
        control.action.kind === "navigate") &&
      control.action.viewId === target &&
      available(plan, control, width),
  );
  if (!source) throw new Error("No executable route to view " + target);
  await page.locator("#" + domId(source.viewId, source.nodeId)).click();
  if (
    (await page
      .locator('[data-view="' + target + '"]:not([hidden])')
      .count()) !== 1
  )
    throw new Error("View did not become visible: " + target);
}
async function enterState(
  page: Page,
  view: JourneyView,
  state: PrototypeState,
  width: number,
): Promise<void> {
  if (view.render.initialState === state) return;
  const edges = stateButtons(view, width);
  const queue: { state: PrototypeState; path: JourneyTransition[] }[] = [
    { state: view.render.initialState, path: [] },
  ];
  const seen = new Set<PrototypeState>([view.render.initialState]);
  let route: JourneyTransition[] | undefined;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    if (item.state === state) {
      route = item.path;
      break;
    }
    for (const edge of edges.filter(
      (candidate) => candidate.state === item.state,
    ))
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push({ state: edge.target, path: [...item.path, edge] });
      }
  }
  if (!route)
    throw new Error("Semantic status is unreachable: " + view.id + "/" + state);
  for (const next of route) {
    await page.locator("#" + domId(view.id, next.nodeId)).click();
  }
}
async function exerciseControl(
  page: Page,
  plan: PrototypeJourneyInput,
  control: JourneyControl,
  width: number,
): Promise<void> {
  const view = plan.views.find((item) => item.id === control.viewId)!;
  await enterView(page, plan, view.id, width);
  const state = stateOf(view, control.nodeId);
  if (!state) throw new Error("No owning semantic state for " + control.nodeId);
  await enterState(page, view, state, width);
  const element = page.locator("#" + domId(view.id, control.nodeId));
  if ((await element.count()) !== 1 || !(await element.isVisible()))
    throw new Error(
      "Declared control not visible: " + view.id + "/" + control.nodeId,
    );
  const action: JourneyAction = control.action;
  switch (action.kind) {
    case "set-filter": {
      const value = String(plan.entities[0]!.fields[action.field]);
      await element.fill(value);
      if ((await element.inputValue()) !== value)
        throw new Error("Filter value not retained");
      for (const row of plan.rows) {
        if (
          !journeyNodeSurfaces(
            plan.views.find((item) => item.id === row.viewId)!,
            row.nodeId,
          ).includes(width === 390 ? "mobile" : "desktop")
        )
          continue;
        const entity = plan.entities.find((item) => item.id === row.entityId)!;
        const expected = String(entity.fields[action.field])
          .toLowerCase()
          .includes(value.toLowerCase());
        if (
          (await page
            .locator("#" + domId(row.viewId, row.nodeId))
            .isVisible()) !== expected
        )
          throw new Error("Filter result differs for " + row.entityId);
      }
      let absent = "__journey_gate_missing__";
      while (
        plan.entities.some((item) =>
          item.fields[action.field]
            ?.toLowerCase()
            .includes(absent.toLowerCase()),
        )
      )
        absent += "_";
      await element.fill(absent);
      const emptyId =
        width === 390
          ? (plan.filterEmpty.mobileNodeId ?? plan.filterEmpty.nodeId)
          : plan.filterEmpty.nodeId;
      if (
        !(await page
          .locator("#" + domId(plan.filterEmpty.viewId, emptyId))
          .isVisible())
      )
        throw new Error("Authored empty-result feedback did not appear");
      for (const row of plan.rows) {
        if (
          !journeyNodeSurfaces(
            plan.views.find((item) => item.id === row.viewId)!,
            row.nodeId,
          ).includes(width === 390 ? "mobile" : "desktop")
        )
          continue;
        if (await page.locator("#" + domId(row.viewId, row.nodeId)).isVisible())
          throw new Error("Filtered row remained visible for absent status");
      }
      break;
    }
    case "edit-draft": {
      await element.fill("Gate draft <literal>");
      if ((await element.inputValue()) !== "Gate draft <literal>")
        throw new Error("Draft edit did not take effect");
      break;
    }
    case "discard-draft":
    case "reset-draft": {
      const edit = plan.controls.find(
        (item) => item.viewId === view.id && item.action.kind === "edit-draft",
      );
      if (!edit) throw new Error("No edit control to establish discard effect");
      await page
        .locator("#" + domId(edit.viewId, edit.nodeId))
        .fill("Discard probe");
      await element.click();
      if (
        (await page
          .locator("#" + domId(edit.viewId, edit.nodeId))
          .inputValue()) === "Discard probe"
      )
        throw new Error("Discard did not reset the draft");
      break;
    }
    case "select":
      await element.click();
      if (
        (await page
          .locator('[data-view="' + action.viewId + '"]:not([hidden])')
          .count()) !== 1 ||
        !(await page.locator("#prototype-status").textContent())?.includes(
          action.entityId,
        )
      )
        throw new Error("Selection did not preserve entity identity");
      break;
    case "navigate":
      await element.click();
      if (
        (await page
          .locator('[data-view="' + action.viewId + '"]:not([hidden])')
          .count()) !== 1
      )
        throw new Error("Navigation did not reach target view");
      break;
    case "return":
      await element.click();
      if (
        (await page
          .locator('[data-view="' + plan.initialViewId + '"]:not([hidden])')
          .count()) !== 1
      )
        throw new Error("Return did not reach source view");
      break;
    case "set-status":
      await element.click();
      if ((await activeState(page, view.id, action.status).count()) !== 1)
        throw new Error("Status action did not reach target state");
      break;
  }
}
async function sameSession(
  page: Page,
  plan: PrototypeJourneyInput,
  width: number,
): Promise<string> {
  const filter = plan.controls.find(
    (control) =>
      control.action.kind === "set-filter" && available(plan, control, width),
  );
  const selects = plan.controls
    .filter(
      (control) =>
        control.action.kind === "select" && available(plan, control, width),
    )
    .sort((left, right) => {
      const rank = (control: JourneyControl) => {
        const action = control.action;
        return action.kind === "select"
          ? plan.entities.findIndex((item) => item.id === action.entityId)
          : Infinity;
      };
      return rank(left) - rank(right);
    });
  const edit = plan.controls.find(
    (control) =>
      control.action.kind === "edit-draft" && available(plan, control, width),
  );
  const ret = plan.controls.find(
    (control) =>
      control.action.kind === "return" &&
      available(plan, control, width) &&
      stateOf(
        plan.views.find((view) => view.id === control.viewId)!,
        control.nodeId,
      ) ===
        plan.views.find((view) => view.id === control.viewId)!.render
          .initialState,
  );
  const discard = plan.controls.find(
    (control) =>
      (control.action.kind === "discard-draft" ||
        control.action.kind === "reset-draft") &&
      available(plan, control, width),
  );
  if (!filter || selects.length < 2 || !edit || !ret || !discard)
    throw new Error(
      "Journey does not declare filter, two selections, edit, return and discard",
    );
  const sameFilter = (left: JourneyControl, right: JourneyControl): boolean => {
    if (left.action.kind !== "select" || right.action.kind !== "select")
      return false;
    const leftId = left.action.entityId;
    const rightId = right.action.entityId;
    return (
      leftId !== rightId &&
      plan.entities.find((item) => item.id === leftId)?.fields[
        plan.filterField
      ] ===
        plan.entities.find((item) => item.id === rightId)?.fields[
          plan.filterField
        ]
    );
  };
  const first = selects.find((item) =>
    selects.some((other) => sameFilter(item, other)),
  );
  const second = first && selects.find((item) => sameFilter(first, item));
  if (
    !first ||
    !second ||
    first.action.kind !== "select" ||
    second.action.kind !== "select" ||
    edit.action.kind !== "edit-draft"
  )
    throw new Error("Journey lacks a second distinct entity");
  const firstEntityId = first.action.entityId;
  const filterNode = page.locator("#" + domId(filter.viewId, filter.nodeId));
  const filterValue = String(
    plan.entities.find((item) => item.id === firstEntityId)!.fields[
      plan.filterField
    ],
  );
  await filterNode.fill(filterValue);
  const firstButton = page.locator("#" + domId(first.viewId, first.nodeId));
  const secondButton = page.locator("#" + domId(second.viewId, second.nodeId));
  if (!(await firstButton.isVisible()) || !(await secondButton.isVisible()))
    throw new Error("Filter did not retain two selectable entities");
  await firstButton.click();
  const immutable = plan.texts.filter(
    (binding) =>
      binding.viewId === edit.viewId &&
      binding.source === "selected-field" &&
      ["approvalStatus", "committedDecision"].includes(binding.field),
  );
  if (immutable.length !== 2)
    throw new Error("Approval and committed-decision observations are missing");
  const expectedImmutable = immutable.map((binding) =>
    String(
      plan.entities.find((item) => item.id === firstEntityId)!.fields[
        binding.field
      ],
    ),
  );
  const draft = page.locator("#" + domId(edit.viewId, edit.nodeId));
  await draft.fill("Distinctive gate draft <uncommitted>");
  await page.locator("#" + domId(ret.viewId, ret.nodeId)).click();
  if (
    (await filterNode.inputValue()) !== filterValue ||
    !(await page
      .locator("#" + expectedReturnFocus(plan, first, width))
      .evaluate((node) => node === document.activeElement))
  )
    throw new Error("Return lost filter or focus");
  await firstButton.click();
  if ((await draft.inputValue()) !== "Distinctive gate draft <uncommitted>")
    throw new Error("Resume lost draft");
  await page.locator("#" + domId(ret.viewId, ret.nodeId)).click();
  await secondButton.click();
  if ((await draft.inputValue()) === "Distinctive gate draft <uncommitted>")
    throw new Error("Second entity inherited first draft");
  await page.locator("#" + domId(ret.viewId, ret.nodeId)).click();
  await firstButton.click();
  await page.locator("#" + domId(discard.viewId, discard.nodeId)).click();
  if ((await draft.inputValue()) === "Distinctive gate draft <uncommitted>")
    throw new Error("Explicit discard did not clear the draft");
  if (
    !(await page.locator("#prototype-status").textContent())?.includes(
      firstEntityId,
    )
  )
    throw new Error("Entity identity changed after discard");
  for (const [index, binding] of immutable.entries())
    if (
      (await page
        .locator("#" + domId(binding.viewId, binding.nodeId))
        .textContent()) !== expectedImmutable[index]
    )
      throw new Error(
        "Approval or committed decision changed through local journey actions",
      );
  return firstEntityId;
}
export async function runBrowserJourneyQualityGates(
  input: GateInput,
  suppliedBrowser?: Browser,
): Promise<QualityReport> {
  const staticResult = await runStaticJourneyQualityGates(input);
  const { bundle } = staticResult;
  const plan = bundle.plan as unknown as PrototypeJourneyInput | undefined;
  const exact =
    staticResult.report.findings.find(
      (item) => item.criterion === "source-locks",
    )?.state === "PASS";
  const findings: GateFinding[] = [];
  const widths = [1280, 390];
  const engine = suppliedBrowser?.browserType().name() ?? "chromium";
  if (!plan || !exact) {
    for (const width of widths)
      for (const criterion of [
        "journey-render",
        "journey-actions",
        "journey-continuity",
        "journey-axe",
        "journey-keyboard",
        "journey-overflow",
      ])
        findings.push(
          finding(
            criterion,
            "UNVERIFIED",
            "Exact source and final bundle validation is required",
            bundle.target.bundleDigest,
            engine + (width === 390 ? "-mobile" : "-desktop"),
            width,
            0,
          ),
        );
    return {
      target: bundle.target,
      findings,
      inspectedAt: new Date().toISOString(),
      action: "inspect-only",
    };
  }
  const files = new Map([
    ["/", { data: bundle.html, mime: "text/html; charset=utf-8" }],
    ["/prototype.css", { data: bundle.css, mime: "text/css; charset=utf-8" }],
    [
      "/prototype.js",
      { data: bundle.js, mime: "text/javascript; charset=utf-8" },
    ],
  ]);
  const server = createServer((request, response) => {
    const entry = files.get(request.url ?? "");
    if (!entry || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": entry.mime,
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
    });
    response.end(entry.data);
  });
  let browser = suppliedBrowser;
  let launched = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base =
      "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/";
    if (!browser) {
      browser = await chromium.launch(patchedChromeLaunchOptions());
      launched = true;
    }
    assertPatchedChrome(browser);
    for (const width of widths) {
      const name =
        browser.browserType().name() + (width === 390 ? "-mobile" : "-desktop");
      let context: BrowserContext | undefined;
      let count = 0;
      let observedControls = 0;
      let observedTransitions = 0;
      const expectedControls = plan.controls.filter((control) =>
        available(plan, control, width),
      ).length;
      const expectedTransitions = plan.views.reduce(
        (sum, view) => sum + stateButtons(view, width).length,
        0,
      );
      let rendered = false;
      let keyboardObserved = false;
      let axeObserved = 0;
      let overflowObserved = 0;
      const expectedSurfaces = plan.views.reduce(
        (sum, view) => sum + view.render.states.length,
        0,
      );
      const actionErrors: string[] = [];
      const axeErrors: string[] = [];
      const keyboardErrors: string[] = [];
      const overflowErrors: string[] = [];
      const continuityErrors: string[] = [];
      try {
        context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 800 },
          isMobile: width === 390 && browser.browserType().name() !== "firefox",
          hasTouch: width === 390,
        });
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(base).origin || !files.has(url.pathname))
            void route.abort();
          else void route.continue();
        });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(base);
        rendered =
          (await page.locator("body > main").count()) === 1 &&
          (await page.locator("[data-view]").count()) === plan.views.length &&
          (await page
            .locator('[data-view="' + plan.initialViewId + '"]:not([hidden])')
            .count()) === 1;
        if (pageErrors.length) rendered = false;
        for (const control of plan.controls.filter((item) =>
          available(plan, item, width),
        )) {
          const probe = await context.newPage();
          try {
            await probe.goto(base);
            await exerciseControl(probe, plan, control, width);
            count++;
            observedControls++;
          } catch (error) {
            actionErrors.push(
              control.viewId + "/" + control.nodeId + ": " + String(error),
            );
          } finally {
            await probe.close();
          }
        }
        for (const view of plan.views) {
          for (const edge of stateButtons(view, width)) {
            const probe = await context.newPage();
            try {
              await probe.goto(base);
              await enterView(probe, plan, view.id, width);
              await enterState(probe, view, edge.state, width);
              const button = probe.locator("#" + domId(view.id, edge.nodeId));
              if ((await button.count()) !== 1 || !(await button.isVisible()))
                throw new Error(
                  "Declared transition is not visible: " + edge.nodeId,
                );
              await button.click();
              if (
                (await activeState(probe, view.id, edge.target).count()) !== 1
              )
                throw new Error("target state not reached");
              count++;
              observedTransitions++;
            } catch (error) {
              actionErrors.push(
                view.id +
                  "/" +
                  edge.state +
                  "/" +
                  edge.nodeId +
                  "→" +
                  edge.target +
                  ": " +
                  String(error),
              );
            } finally {
              await probe.close();
            }
          }
        }
        try {
          const selectedEntityId = await sameSession(page, plan, width);
          count += 8;
          const focused = await page.evaluate(
            () =>
              !!document.activeElement &&
              !!document.activeElement.getClientRects().length &&
              !document.activeElement.closest("[hidden],details:not([open])"),
          );
          if (!focused) keyboardErrors.push("Focus moved into hidden content");
          const nextWidth = width === 390 ? 1280 : 390;
          await page.setViewportSize({ width: nextWidth, height: 844 });
          if (
            !(await page.locator("#prototype-status").textContent())?.includes(
              selectedEntityId,
            )
          )
            throw new Error("Entity identity changed on resize");
          await page.setViewportSize({ width, height: 844 });
          if (
            !(await page.locator("#prototype-status").textContent())?.includes(
              selectedEntityId,
            )
          )
            throw new Error("Entity identity changed on reverse resize");
        } catch (error) {
          continuityErrors.push(String(error));
        }
        for (const view of plan.views)
          for (const state of view.render.requiredStates) {
            const probe = await context.newPage();
            try {
              await probe.goto(base);
              await enterView(probe, plan, view.id, width);
              await enterState(probe, view, state, width);
              if ((await activeState(probe, view.id, state).count()) !== 1)
                throw new Error("State did not render");
              const links = await activeState(probe, view.id, state)
                .locator("a[href]")
                .evaluateAll((elements) =>
                  elements.map((item) => item.getAttribute("href")),
                );
              for (const link of links) {
                if (
                  !link ||
                  !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(link) ||
                  (await probe
                    .locator('[id="' + link.slice(1) + '"]')
                    .count()) !== 1
                )
                  actionErrors.push(
                    view.id + "/" + state + ": broken fragment " + link,
                  );
                else {
                  const anchor = activeState(probe, view.id, state)
                    .locator('a[href="' + link + '"]')
                    .first();
                  await anchor.click();
                  if (
                    !(await probe
                      .locator('[id="' + link.slice(1) + '"]')
                      .isVisible())
                  )
                    actionErrors.push(
                      view.id +
                        "/" +
                        state +
                        ": fragment target not visible after click",
                    );
                  count++;
                }
              }
              const axe = await new AxeBuilder({ page: probe }).analyze();
              axeErrors.push(
                ...axe.violations.map(
                  (item) => view.id + "/" + state + ": " + item.id,
                ),
              );
              axeObserved++;
              const size = await probe.evaluate(() => ({
                scroll: document.documentElement.scrollWidth,
                viewport: document.documentElement.clientWidth,
              }));
              if (size.scroll > size.viewport + 1)
                overflowErrors.push(
                  view.id +
                    "/" +
                    state +
                    ": " +
                    size.scroll +
                    " > " +
                    size.viewport,
                );
              overflowObserved++;
            } catch (error) {
              const message =
                "unverified: " + view.id + "/" + state + ": " + String(error);
              axeErrors.push(message);
              overflowErrors.push(message);
            } finally {
              await probe.close();
            }
          }
        if (!continuityErrors.length) {
          try {
            const review = plan.views.find(
              (view) => view.id !== plan.initialViewId,
            )!;
            const edge = stateButtons(review, width).find(
              (item) =>
                item.state === review.render.initialState &&
                item.target !== review.render.initialState,
            );
            if (!edge)
              throw new Error("No recovery transition for natural Tab probe");
            await page.locator("#" + domId(review.id, edge.nodeId)).click();
            const focusedHeading = await page.evaluate(() => {
              const node = document.activeElement;
              return (
                !!node &&
                /^H[1-3]$/.test(node.tagName) &&
                !!node.getClientRects().length
              );
            });
            if (!focusedHeading)
              throw new Error("Status change did not focus visible heading");
            await page.keyboard.press("Tab");
            const natural = await page.evaluate(() => {
              const node = document.activeElement;
              return (
                !!node &&
                ["BUTTON", "A", "INPUT"].includes(node.tagName) &&
                !!node.getClientRects().length &&
                !node.closest("[hidden],details:not([open])")
              );
            });
            if (!natural)
              throw new Error("Natural Tab did not reach a visible control");
            keyboardObserved = true;
          } catch (error) {
            keyboardErrors.push(String(error));
          }
        }
        if (pageErrors.length) actionErrors.push(...pageErrors);
      } catch (error) {
        const message = "Browser observation unavailable: " + String(error);
        actionErrors.push(message);
        continuityErrors.push(message);
        axeErrors.push(message);
        keyboardErrors.push(message);
        overflowErrors.push(message);
      } finally {
        await context?.close();
      }
      const all = [
        [
          "journey-render",
          rendered ? [] : ["Initial views, main landmark or runtime errors"],
        ],
        [
          "journey-actions",
          observedControls === expectedControls &&
          observedTransitions === expectedTransitions &&
          count > 0
            ? actionErrors
            : [
                "Declared action coverage incomplete: controls " +
                  observedControls +
                  "/" +
                  expectedControls +
                  ", transitions " +
                  observedTransitions +
                  "/" +
                  expectedTransitions,
                ...actionErrors,
              ],
        ],
        ["journey-continuity", continuityErrors],
        [
          "journey-axe",
          axeObserved === expectedSurfaces
            ? axeErrors
            : ["unverified: incomplete axe surfaces", ...axeErrors],
        ],
        [
          "journey-keyboard",
          keyboardObserved
            ? keyboardErrors
            : ["unverified: keyboard route unobserved", ...keyboardErrors],
        ],
        [
          "journey-overflow",
          overflowObserved === expectedSurfaces
            ? overflowErrors
            : ["unverified: incomplete overflow surfaces", ...overflowErrors],
        ],
      ] as const;
      for (const [criterion, errors] of all) {
        const unknown = errors.some(
          (message) =>
            message.startsWith("unverified:") ||
            message.startsWith("Browser observation unavailable"),
        );
        findings.push(
          finding(
            criterion,
            errors.length ? (unknown ? "UNVERIFIED" : "FAIL") : "PASS",
            errors.length
              ? errors.join("; ")
              : criterion + " passed with " + count + " observed actions",
            bundle.target.bundleDigest,
            name,
            width,
            count,
          ),
        );
      }
    }
  } finally {
    if (launched) await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return {
    target: bundle.target,
    findings,
    inspectedAt: new Date().toISOString(),
    action: "inspect-only",
  };
}
