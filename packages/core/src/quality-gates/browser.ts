/// <reference lib="dom" />
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AxeBuilder } from "@axe-core/playwright";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { PrototypeBuilderInput } from "../prototype-builder/index.js";
import { canonicalJson } from "../artifact-canonical.js";
import {
  inspectBundle,
  type GateFinding,
  type GateInput,
  type QualityReport,
} from "./index.js";
import { qualityPlan } from "./plan.js";

type BrowserFinding = GateFinding;
const devices = [
  { width: 1280, height: 800, mobile: false },
  { width: 390, height: 844, mobile: true },
] as const;
interface Edge {
  from: string;
  to: string;
  ordinal: number;
  label: string;
}
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
function transitions(plan: PrototypeBuilderInput): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  for (const state of plan.states) {
    const edges: Edge[] = [];
    const walk = (node: typeof state.root): void => {
      if (node.tag === "button" && node.targetState)
        edges.push({
          from: state.name,
          to: node.targetState,
          ordinal: edges.length,
          label: node.text ?? node.fixtureKey ?? "",
        });
      for (const child of node.children ?? []) walk(child);
    };
    walk(state.root);
    graph.set(state.name, edges);
  }
  return graph;
}
function fragments(plan: PrototypeBuilderInput): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const state of plan.states) {
    const hrefs: string[] = [];
    const walk = (node: typeof state.root): void => {
      if (node.tag === "a" && node.href) hrefs.push(node.href);
      for (const child of node.children ?? []) walk(child);
    };
    walk(state.root);
    result.set(state.name, hrefs);
  }
  return result;
}
function executionUnavailable(
  error: unknown,
  page: Page,
  browser: Browser,
): boolean {
  if (page.isClosed() || !browser.isConnected()) return true;
  return /(?:target page|browser|context|connection).*(?:closed|disconnected)|(?:ECONNRESET|ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE)/i.test(
    String(error),
  );
}
function paths(graph: Map<string, Edge[]>, start: string): Map<string, Edge[]> {
  const result = new Map<string, Edge[]>([[start, []]]);
  const queue: string[] = [start];
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
  path: Edge[],
): Promise<void> {
  await page.goto(base, { waitUntil: "load" });
  for (const edge of path) await clickEdge(page, edge);
}
async function clickEdge(page: Page, edge: Edge): Promise<void> {
  const button = page
    .locator(
      `[data-state="${edge.from}"]:not([hidden]) button[data-target-state]`,
    )
    .nth(edge.ordinal);
  const actual = await button.getAttribute("data-target-state", {
    timeout: 2_000,
  });
  if (actual !== edge.to)
    throw new Error(
      `${edge.from} → ${edge.to} ${edge.label}: rendered target is ${actual}`,
    );
  await button.click({ timeout: 2_000 });
  await page
    .locator(`[data-state="${edge.to}"]:not([hidden])`)
    .waitFor({ timeout: 2_000 });
  const status = await page.locator("#prototype-status").textContent();
  if (status !== `${edge.to} state`)
    throw new Error(
      `${edge.from} → ${edge.to} ${edge.label}: status ${status}`,
    );
}

/** Execute Chromium checks on a controlled in-memory copy of the inspected local bundle. */
export async function runBrowserQualityGates(
  input: GateInput,
  suppliedBrowser?: Browser,
): Promise<QualityReport> {
  const bundle = await inspectBundle(input);
  const { target, manifest } = bundle;
  const checked = qualityPlan(bundle.plan);
  const plan = checked.plan;
  const trustedRoot = await realpath(input.trustedRoot);
  const findings: BrowserFinding[] = [];
  const basic = { bundleDigest: target.bundleDigest };
  const criteria = [
    "browser-render",
    "axe",
    "keyboard-focus",
    "viewport-overflow",
    "navigation-state",
  ];
  try {
    if (
      !plan ||
      !manifest ||
      manifest.kind !== "mimic-prototype-specification" ||
      manifest.planDigest !==
        `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}` ||
      canonicalJson(manifest.requiredStates) !==
        canonicalJson(plan.requiredStates) ||
      path.resolve(trustedRoot, plan.outputPath) !== target.directory
    )
      checked.errors.push(
        "manifest, plan, required states, or output directory differ",
      );
  } catch {
    checked.errors.push("manifest or plan cannot be canonicalized");
  }
  if (checked.errors.length) {
    return {
      target,
      inspectedAt: new Date().toISOString(),
      action: "inspect-only",
      findings: devices.flatMap((device) =>
        criteria.map((criterion) =>
          finding(
            criterion,
            criterion === "navigation-state" ? "FAIL" : "UNVERIFIED",
            "MAJOR",
            `Invalid generated plan: ${checked.errors.join("; ")}`,
            ["plan.json", "manifest.json"],
            {
              ...basic,
              browser: `${suppliedBrowser?.browserType?.().name() ?? "chromium"}-${device.mobile ? "mobile" : "desktop"}`,
            },
            "Browser execution was not attempted for the invalid plan",
          ),
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
  let engine = "chromium";
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
    engine = browser.browserType().name();
    const graph = transitions(plan!);
    const plannedFragments = fragments(plan!);
    const routes = paths(graph, plan!.initialState);
    for (const device of devices) {
      const deviceName = `${engine}-${device.mobile ? "mobile" : "desktop"}`;
      let context: BrowserContext | undefined;
      const conditions = {
        ...basic,
        browser: deviceName,
        viewportWidth: device.width,
        viewportHeight: device.height,
        mobileViewportOnly: device.mobile && engine === "firefox",
        synthetic: true,
      };
      try {
        context = await browser.newContext({
          viewport: { width: device.width, height: device.height },
          isMobile: device.mobile && engine !== "firefox",
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
        const renderedNames = await page
          .locator("[data-state]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-state")),
          );
        const complete =
          renderedNames.length === plan!.requiredStates.length &&
          new Set(renderedNames).size === renderedNames.length &&
          renderedNames.every((state) =>
            plan!.requiredStates.includes(
              state as PrototypeBuilderInput["initialState"],
            ),
          );
        const rendered =
          complete &&
          (await page
            .locator(`[data-state="${plan!.initialState}"]:not([hidden]) main`)
            .count()) === 1;
        findings.push(
          finding(
            "browser-render",
            rendered && !errors.length ? "PASS" : "FAIL",
            "MAJOR",
            rendered && !errors.length
              ? "Every declared state rendered; initial state has a main and no page errors"
              : `Render/state mismatch: ${errors.join("; ") || `expected ${plan!.requiredStates.join(",")}, got ${renderedNames.join(",")}`}`,
            ["index.html", "prototype.js"],
            conditions,
            `${engine} rendering of a synthetic fixture only`,
          ),
        );

        const missing = plan!.requiredStates.filter(
          (state) => !routes.has(state),
        );
        const navigation: string[] = missing.map(
          (state) => `${state}: unreachable from ${plan!.initialState}`,
        );
        const unknownNavigation: string[] = [];
        const axe: string[] = [];
        const overflow: string[] = [];
        const keyboard: string[] = [];
        const unverified = new Map<string, string[]>();
        const recordUnknown = (
          criterion: string,
          state: string,
          error: unknown,
        ) => {
          const messages = unverified.get(criterion) ?? [];
          messages.push(`${state}: ${String(error)}`);
          unverified.set(criterion, messages);
        };
        let completed = 0;
        let linksChecked = 0;
        for (const state of plan!.requiredStates) {
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
            const renderedButtons = await page
              .locator(`[data-state="${state}"] button`)
              .count();
            const declaredButtons = graph.get(state)?.length ?? 0;
            if (renderedButtons !== declaredButtons)
              navigation.push(
                `${state}: ${renderedButtons} rendered buttons differ from ${declaredButtons} declared transitions`,
              );
            const links = await page
              .locator(`[data-state="${state}"] a[href]`)
              .evaluateAll((elements) =>
                elements.map((element) => ({
                  href: element.getAttribute("href") ?? "",
                  target: element.getAttribute("href")?.slice(1) ?? "",
                })),
              );
            const declaredLinks = plannedFragments.get(state) ?? [];
            if (
              links.length !== declaredLinks.length ||
              links.some((link, index) => link.href !== declaredLinks[index])
            )
              navigation.push(
                `${state}: rendered links differ from declared fragments`,
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
            linksChecked += links.length;
            try {
              const result = await new AxeBuilder({ page }).analyze();
              axe.push(
                ...result.violations.map(
                  (violation) =>
                    `${state}:${violation.id}:${violation.nodes.map((node) => node.target.join(" ")).join(",")}`,
                ),
              );
            } catch (error) {
              recordUnknown("axe", state, error);
            }
            try {
              const size = await page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                viewport: document.documentElement.clientWidth,
              }));
              if (size.width > size.viewport + 1)
                overflow.push(`${state}: ${size.width}px > ${size.viewport}px`);
            } catch (error) {
              recordUnknown("viewport-overflow", state, error);
            }
            try {
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
            } catch (error) {
              recordUnknown("keyboard-focus", state, error);
            }
            completed++;
          } catch (error) {
            (executionUnavailable(error, page, browser)
              ? unknownNavigation
              : navigation
            ).push(`${state}: ${String(error)}`);
          }
        }
        const totalEdges = [...graph.values()].reduce(
          (count, edges) => count + edges.length,
          0,
        );
        let edgesChecked = 0;
        let repeatedEdges = 0;
        for (const [from, edges] of graph) {
          const toSource = routes.get(from);
          if (!toSource) continue;
          for (const edge of edges) {
            try {
              await servedPage(page, base, toSource);
              await clickEdge(page, edge);
              if (
                (await page.locator("[data-state]:not([hidden])").count()) !== 1
              )
                throw new Error("more than one state is visible");
              edgesChecked++;
              const back = paths(graph, edge.to).get(from);
              if (back?.length) {
                for (const returnEdge of back)
                  await clickEdge(page, returnEdge);
                await clickEdge(page, edge);
                repeatedEdges++;
              }
            } catch (error) {
              (executionUnavailable(error, page, browser)
                ? unknownNavigation
                : navigation
              ).push(
                `${edge.from} → ${edge.to} ${edge.label}: ${String(error)}`,
              );
            }
          }
        }
        const totalLinks = [...plannedFragments.values()].reduce(
          (count, hrefs) => count + hrefs.length,
          0,
        );
        const navigationState = navigation.length
          ? "FAIL"
          : unknownNavigation.length
            ? "UNVERIFIED"
            : totalEdges === 0 && totalLinks === 0
              ? "N/A"
              : completed === plan!.requiredStates.length &&
                  edgesChecked === totalEdges &&
                  linksChecked === totalLinks
                ? "PASS"
                : "UNVERIFIED";
        for (const [criterion, failures, severity, limit] of [
          [
            "navigation-state",
            navigation,
            "MAJOR",
            "Every declared transition and fragment link is checked; repeat checks use a same-session return path when one exists",
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
              criterion === "navigation-state"
                ? navigationState
                : failures.length
                  ? "FAIL"
                  : completed < plan!.requiredStates.length ||
                      unverified.has(criterion)
                    ? "UNVERIFIED"
                    : "PASS",
              severity,
              (criterion === "navigation-state" && !failures.length
                ? navigationState === "N/A"
                  ? "One state has no transition controls or fragment links; navigation does not apply"
                  : navigationState === "UNVERIFIED"
                    ? `Navigation incomplete: ${unknownNavigation.join("; ") || `${completed}/${plan!.requiredStates.length} states reached`}`
                    : `${edgesChecked}/${totalEdges} transitions and ${linksChecked}/${totalLinks} fragment links checked; ${repeatedEdges} repeated after same-session return`
                : failures.join("; ")) ||
                (completed < plan!.requiredStates.length ||
                unverified.has(criterion)
                  ? `Only ${completed}/${plan!.requiredStates.length} states were reached; ${unverified.get(criterion)?.join("; ") ?? ""}`
                  : `${criterion} passed in ${completed} declared states`),
              ["index.html", "prototype.css", "prototype.js", "plan.json"],
              criterion === "navigation-state"
                ? {
                    ...conditions,
                    transitionsChecked: edgesChecked,
                    fragmentLinksChecked: linksChecked,
                  }
                : conditions,
              limit,
            ),
          );
      } catch (error) {
        for (const criterion of criteria)
          if (
            !findings.some(
              (item) =>
                item.criterion === criterion &&
                item.conditions.browser === deviceName,
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
        try {
          await context?.close();
        } catch {
          // A lost browser transport cannot invalidate findings already recorded.
        }
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
            {
              ...basic,
              browser: `${engine}-${device.mobile ? "mobile" : "desktop"}`,
            },
            "No browser observation was made",
          ),
        );
  } finally {
    if (launched) {
      try {
        await browser?.close();
      } catch {
        // A failed cleanup cannot replace the recorded tool outcome.
      }
    }
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
