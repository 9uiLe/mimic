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
import type { PrototypeBuilderInput } from "../prototype-builder/index.js";
import {
  inspectBundle,
  type GateFinding,
  type GateInput,
  type QualityReport,
} from "./index.js";

type BrowserFinding = GateFinding;
const devices = [
  { name: "chromium-desktop", width: 1280, height: 800, mobile: false },
  { name: "chromium-mobile", width: 390, height: 844, mobile: true },
] as const;
function finding(
  criterion: string,
  state: BrowserFinding["state"],
  severity: BrowserFinding["severity"],
  reason: string,
  evidence: readonly string[],
  conditions: BrowserFinding["conditions"],
  limitations: string,
): BrowserFinding {
  return {
    criterion,
    state,
    severity,
    reason,
    evidence,
    conditions,
    limitations,
  };
}
function transitions(
  plan: PrototypeBuilderInput,
): Map<string, { to: string; label: string }[]> {
  const graph = new Map<string, { to: string; label: string }[]>();
  for (const state of plan.states) {
    const edges: { to: string; label: string }[] = [];
    const walk = (node: typeof state.root): void => {
      if (node.tag === "button" && node.targetState)
        edges.push({ to: node.targetState, label: node.text ?? "" });
      for (const child of node.children ?? []) walk(child);
    };
    walk(state.root);
    graph.set(state.name, edges);
  }
  return graph;
}
function paths(
  plan: PrototypeBuilderInput,
): Map<string, { to: string; label: string }[]> {
  const graph = transitions(plan);
  const result = new Map<string, { to: string; label: string }[]>([
    [plan.initialState, []],
  ]);
  const queue: string[] = [plan.initialState];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index]!;
    for (const edge of graph.get(from) ?? []) {
      if (!result.has(edge.to)) {
        result.set(edge.to, [...result.get(from)!, edge]);
        queue.push(edge.to);
      }
    }
  }
  return result;
}
async function servedPage(
  page: Page,
  base: string,
  path: { to: string; label: string }[],
): Promise<void> {
  await page.goto(base, { waitUntil: "load" });
  for (const edge of path) {
    await page
      .locator("[data-state]:not([hidden]) button[data-target-state]")
      .filter({ hasText: edge.label })
      .first()
      .click({ timeout: 2_000 });
    await page
      .locator(`[data-state="${edge.to}"]:not([hidden])`)
      .waitFor({ timeout: 2_000 });
  }
}

/** Execute Chromium checks on a controlled in-memory copy of the inspected local bundle. */
export async function runBrowserQualityGates(
  input: GateInput,
  suppliedBrowser?: Browser,
): Promise<QualityReport> {
  const bundle = await inspectBundle(input);
  const { target, plan } = bundle;
  const findings: BrowserFinding[] = [];
  const basic = { bundleDigest: target.bundleDigest };
  const criteria = [
    "browser-render",
    "axe",
    "keyboard-focus",
    "viewport-overflow",
    "navigation-state",
  ];
  if (
    !plan ||
    !Array.isArray(plan.states) ||
    !Array.isArray(plan.requiredStates)
  ) {
    return {
      target,
      inspectedAt: new Date().toISOString(),
      action: "inspect-only",
      findings: criteria.map((criterion) =>
        finding(
          criterion,
          "UNVERIFIED",
          "MAJOR",
          "Render plan is invalid",
          ["plan.json"],
          basic,
          "Browser execution was not attempted",
        ),
      ),
    };
  }
  const files = new Map([
    ["/", { value: bundle.html, mime: "text/html; charset=utf-8" }],
    ["/prototype.css", { value: bundle.css, mime: "text/css; charset=utf-8" }],
    [
      "/prototype.js",
      { value: bundle.js, mime: "text/javascript; charset=utf-8" },
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
      "x-content-type-options": "nosniff",
    });
    response.end(entry.value);
  });
  let browser = suppliedBrowser;
  let launched = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      launched = true;
    }
    const routes = paths(plan);
    for (const device of devices) {
      let context: BrowserContext | undefined;
      const conditions = {
        ...basic,
        browser: device.name,
        viewportWidth: device.width,
        viewportHeight: device.height,
        synthetic: true,
      };
      try {
        context = await browser.newContext({
          viewport: { width: device.width, height: device.height },
          isMobile: device.mobile,
          hasTouch: device.mobile,
        });
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(base).origin || !files.has(url.pathname))
            void route.abort();
          else void route.continue();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(base);
        const rendered =
          (await page
            .locator(`[data-state="${plan.initialState}"]:not([hidden]) main`)
            .count()) === 1;
        findings.push(
          finding(
            "browser-render",
            rendered && !errors.length ? "PASS" : "FAIL",
            "MAJOR",
            rendered && !errors.length
              ? "Initial generated state rendered without page errors"
              : `Initial render/page error: ${errors.join("; ") || "main missing"}`,
            ["index.html", "prototype.js"],
            conditions,
            "Chromium rendering of a synthetic fixture only",
          ),
        );

        const missing = plan.requiredStates.filter(
          (state) => !routes.has(state),
        );
        const navigation: string[] = missing.map(
          (state) => `${state}: unreachable from ${plan.initialState}`,
        );
        const axe: string[] = [];
        const overflow: string[] = [];
        const keyboard: string[] = [];
        let completed = 0;
        for (const state of plan.requiredStates) {
          const route = routes.get(state);
          if (!route) continue;
          try {
            await servedPage(page, base, route);
            const visible = await page
              .locator(`[data-state="${state}"]:not([hidden]) main`)
              .count();
            const otherVisible = await page
              .locator(`[data-state]:not([hidden])`)
              .count();
            const status = await page
              .locator("#prototype-status")
              .textContent();
            if (
              visible !== 1 ||
              otherVisible !== 1 ||
              status !== `${state} state`
            )
              navigation.push(`${state}: visible state or status inconsistent`);
            const links = await page
              .locator(`[data-state="${state}"] a[href]`)
              .evaluateAll((elements) =>
                elements.map((element) => ({
                  href: element.getAttribute("href") ?? "",
                  target: element.getAttribute("href")?.slice(1) ?? "",
                })),
              );
            for (const link of links) {
              if (
                !link.href.startsWith("#") ||
                !/^[A-Za-z][A-Za-z0-9_-]*$/.test(link.target) ||
                (await page.locator(`[id="${link.target}"]`).count()) !== 1
              )
                navigation.push(
                  `${state}: broken or nonlocal link ${link.href}`,
                );
            }
            const result = await new AxeBuilder({ page }).analyze();
            axe.push(
              ...result.violations.map(
                (violation) =>
                  `${state}:${violation.id}:${violation.nodes.map((node) => node.target.join(" ")).join(",")}`,
              ),
            );
            const size = await page.evaluate(() => ({
              width: document.documentElement.scrollWidth,
              viewport: document.documentElement.clientWidth,
            }));
            if (size.width > size.viewport + 1)
              overflow.push(`${state}: ${size.width}px > ${size.viewport}px`);
            const expected = await page
              .locator(
                `[data-state="${state}"] button, [data-state="${state}"] a[href]`,
              )
              .count();
            if (expected) {
              await page.keyboard.press("Tab");
              const focus = await page.evaluate(() => {
                const active = document.activeElement;
                return (
                  !!active &&
                  active !== document.body &&
                  !!active.closest("[data-state]:not([hidden])") &&
                  getComputedStyle(active).outlineStyle !== "none"
                );
              });
              if (!focus)
                keyboard.push(
                  `${state}: Tab did not visibly focus an active control`,
                );
            }
            completed++;
          } catch (error) {
            navigation.push(`${state}: ${String(error)}`);
          }
        }
        for (const [criterion, failures, severity, limit] of [
          [
            "navigation-state",
            navigation,
            "MAJOR",
            "Only declared reachable states and local fragment targets are checked",
          ],
          [
            "axe",
            axe,
            "MAJOR",
            "Automated axe rules do not establish WCAG 2.2 AA conformance",
          ],
          [
            "viewport-overflow",
            overflow,
            "MINOR",
            "Document width only; visual quality and task success require further review",
          ],
          [
            "keyboard-focus",
            keyboard,
            "MAJOR",
            "First Tab focus and visible outline only; full keyboard operation needs manual inspection",
          ],
        ] as const)
          findings.push(
            finding(
              criterion,
              failures.length
                ? "FAIL"
                : completed < plan.requiredStates.length
                  ? "UNVERIFIED"
                  : "PASS",
              severity,
              failures.join("; ") ||
                (completed < plan.requiredStates.length
                  ? `Only ${completed}/${plan.requiredStates.length} states were reached`
                  : `${criterion} passed in ${completed} declared states`),
              ["index.html", "prototype.css", "prototype.js", "plan.json"],
              conditions,
              limit,
            ),
          );
      } catch (error) {
        for (const criterion of criteria)
          if (
            !findings.some(
              (item) =>
                item.criterion === criterion &&
                item.conditions.browser === device.name,
            )
          )
            findings.push(
              finding(
                criterion,
                "UNVERIFIED",
                "MAJOR",
                `Browser execution failed: ${String(error)}`,
                [],
                conditions,
                "No completed browser observation for this criterion",
              ),
            );
      } finally {
        await context?.close();
      }
    }
  } catch (error) {
    for (const device of devices)
      for (const criterion of criteria)
        findings.push(
          finding(
            criterion,
            "UNVERIFIED",
            "MAJOR",
            `Browser/server launch failed: ${String(error)}`,
            [],
            { ...basic, browser: device.name },
            "No browser observation was made",
          ),
        );
  } finally {
    if (launched) await browser?.close();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return {
    target,
    findings,
    inspectedAt: new Date().toISOString(),
    action: "inspect-only",
  };
}
