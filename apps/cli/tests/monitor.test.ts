import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import {
  artifactDigest,
  buildPrototype,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
} from "@mimic/core";
import { setupApprovedPrototypeFixture } from "../../../fixtures/prototypes/approved.js";
import { startMonitor } from "../src/monitor.js";
import { runCli } from "../src/cli.js";
import {
  FileSessionStore,
  sessionDigest,
  type SessionCheckpoint,
} from "../src/agent/session.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const monitors: Awaited<ReturnType<typeof startMonitor>>[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const actor = { kind: "agent" as const, id: "test_monitor" };
const at = "2026-10-09T12:00:00Z";
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-monitor-"));
  roots.push(root);
  expect(
    await runCli(["init", "--root", root], { out: () => {}, err: () => {} }),
  ).toBe(0);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, ".mimic/workspace.json")),
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    [{ level: "organization", ownerId: "org_local" }],
    { verify: async () => false, allowCommit: async () => false },
  );
  await runtime.registry.start({
    id: "run_monitor",
    scope: "org_local",
    entryMode: "system-first",
    base: [],
    reused: [],
    safeActions: ["task_monitor"],
    actor,
    at,
    reason: "private-run-reason",
  });
  return { root, runtime };
}
async function server(root: string, preview?: string) {
  const monitor = await startMonitor({ root, port: 0, preview });
  monitors.push(monitor);
  return monitor;
}
async function state(url: string) {
  const response = await fetch(url + "/api/state");
  expect(response.status).toBe(200);
  return response.json();
}
async function status(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.once("error", reject);
    request.end();
  });
}
async function files(
  root: string,
  relative = "",
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(root, name));
    else if (entry.isFile())
      result[name] = await readFile(path.join(root, name), "base64");
  }
  return result;
}
function checkpoint(
  stop: SessionCheckpoint["stop"] = "unknown-outcome",
  accepted = false,
): SessionCheckpoint {
  const digest = sessionDigest("private-context");
  return {
    version: 1,
    sessionId: "session_monitor",
    binding: {
      runId: "run_monitor",
      planDigest: digest,
      settings: {
        provider: "codex",
        billingMode: "subscription-only",
        model: "private-model",
      },
    },
    generationCount: 1,
    status: "stopped",
    stop,
    questionIds: ["private-question"],
    tasks: {
      task_monitor: {
        binding: {
          taskId: "task_monitor",
          inputDigest: digest,
          packageDigest: digest,
          contextDigest: digest,
          packageVersion: "1.0.0",
          inputRefs: [],
        },
        phase: accepted ? "accepted" : "executing",
        ...(accepted
          ? { work: { path: "private-work-path", digest }, outputRefs: [] }
          : {}),
        diagnostics: {
          version: 1,
          stage: "generation",
          backendReach: "unknown",
        },
      },
    },
  };
}
async function bundle() {
  const fixture = await setupApprovedPrototypeFixture();
  roots.push(fixture.root);
  return (await buildPrototype(fixture.store, fixture.input, fixture.root))
    .directory;
}

test("live Core records, exact artifacts and validated stops are projected without private contents or writes", async () => {
  const { root, runtime } = await setup();
  await mkdir(path.join(root, ".mimic/runs"), { recursive: true });
  await writeFile(
    path.join(root, ".mimic/runs/run_monitor.json"),
    JSON.stringify([
      {
        id: "task_monitor",
        outputType: "system-capability",
        humanBrief: "private-prompt",
        evidenceFiles: ["private-account-path"],
      },
    ]),
  );
  await new FileSessionStore(root).write(checkpoint());
  const template = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/system-capability.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  const artifact = {
    ...template,
    scope: { level: "organization" as const, ownerId: "org_local" },
    meta: {
      ...template.meta,
      id: "art_run_mimic_monitor_design_v5_20261009_s09_workspace_monitor_reference_selection",
    },
    origin: {
      actorKind: "agent" as const,
      actorId: actor.id,
      runId: "run_monitor",
      createdAt: at,
    },
    content: { ...template.content, summary: "private-generated-content" },
  };
  await runtime.artifacts.create(artifact);
  const exact = {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
  await runtime.registry.produce({
    runId: "run_monitor",
    ref: exact,
    inputs: [],
    actor,
    at,
    reason: "private-output-reason",
  });
  const before = await files(root);
  const monitor = await server(root);
  const initial = await state(monitor.url);
  expect(initial.runs[0]).toMatchObject({
    runId: "run_monitor",
    state: "active",
    tasks: [
      {
        taskId: "task_monitor",
        outputType: "system-capability",
        stage: "system",
        phase: "unknown-outcome",
      },
    ],
    artifacts: [{ ref: exact, type: "system-capability" }],
    sessions: [
      {
        status: "stopped",
        stop: "unknown-outcome",
        tasks: [{ phase: "executing", stage: "generation" }],
      },
    ],
  });
  expect(JSON.stringify(initial)).not.toMatch(
    /private-|rationale|questionIds|prompt|"model"|"work"|receipt|token|stdout|stderr/,
  );
  expect(await files(root)).toEqual(before);
  await new FileSessionStore(root).write(checkpoint("approval", true));
  const updated = await state(monitor.url);
  expect(updated.runs[0].tasks[0].phase).toBe("approval");
  expect(updated.runs[0].sessions[0].tasks[0].phase).toBe("accepted");
  await runtime.registry.start({
    id: "run_latest",
    scope: "org_local",
    entryMode: "system-first",
    base: [],
    reused: [],
    safeActions: [],
    actor,
    at,
    reason: "private-latest-reason",
  });
  const latest = await state(monitor.url);
  expect(latest.runs[0]).toMatchObject({
    runId: "run_latest",
    state: "closed",
    tasks: [],
  });
});

test("Core freeform safe work without a plan remains readable through active-to-closed polling", async () => {
  const { root, runtime } = await setup();
  const monitor = await server(root);
  await runtime.registry.start({
    id: "run_freeform",
    scope: "org_local",
    entryMode: "system-first",
    base: [],
    reused: [],
    safeActions: [
      "private-action with spaces",
      "Operate existing product preview",
      "private_receipt_label",
    ],
    actor,
    at,
    reason: "private-reason",
  });
  const active = await state(monitor.url);
  expect(active.runs[0]).toMatchObject({
    runId: "run_freeform",
    state: "active",
    safeWorkCount: 3,
    tasks: [],
  });
  expect(active.runs).toHaveLength(2);
  expect(JSON.stringify(active)).not.toMatch(
    /private-action|Operate existing|private_receipt_label/,
  );
  await runtime.registry.setWork({
    runId: "run_freeform",
    safeActions: [],
    blockers: {},
    actor,
    at,
    reason: "private-finish",
  });
  expect((await state(monitor.url)).runs[0]).toMatchObject({
    runId: "run_freeform",
    state: "closed",
    safeWorkCount: 0,
    tasks: [],
  });
});

test("loopback fixed routes reject Host/origin/method/traversal and never expose private files", async () => {
  const { root } = await setup();
  const monitor = await server(root);
  expect(monitor.server.address()).toMatchObject({ address: "127.0.0.1" });
  for (const options of [
    { headers: { Host: "attacker.invalid" } },
    { headers: { Origin: "https://attacker.invalid" } },
    { headers: { Origin: "null" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
    { headers: { "Sec-Fetch-Dest": "iframe" } },
  ])
    expect(
      await status(
        monitor.url + "/api/state",
        options.headers as Record<string, string>,
      ),
    ).toBe(403);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"])
    expect((await fetch(monitor.url + "/api/state", { method })).status).toBe(
      405,
    );
  for (const route of [
    "/.mimic/workspace.json",
    "/manifest.json",
    "/plan.json",
    "/index.html",
    "/prototype.js",
    "/%2e%2e/private",
    "/api/state?file=private",
    "/preview",
  ]) {
    const response = await fetch(monitor.url + route);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"not-found"}');
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(
    (
      await fetch(monitor.url + "/api/state", {
        headers: { Origin: monitor.url },
      })
    ).status,
  ).toBe(200);
});

test("forged/malformed checkpoints, private errors and metadata links fail closed", async () => {
  const { root } = await setup();
  const store = new FileSessionStore(root);
  await store.write(checkpoint());
  const monitor = await server(root);
  const file = path.join(store.directory, "session_monitor.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.checkpoint.tasks.task_monitor.diagnostics.rawMessage = "private-token";
  raw.digest = sessionDigest(raw.checkpoint);
  await writeFile(file, JSON.stringify(raw));
  let response = await fetch(monitor.url + "/api/state");
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"workspace-unavailable"}');
  await rm(file);
  await symlink(path.join(root, ".mimic/workspace.json"), file);
  response = await fetch(monitor.url + "/api/state");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(root);
});

test("preview reads only four bounded regular files, ignores extras and hides the manifest", async () => {
  const { root } = await setup();
  const preview = await bundle();
  await writeFile(path.join(preview, "plan.json"), "private-auth-receipt");
  const monitor = await server(root, preview);
  expect((await state(monitor.url)).preview.state).toBe("available");
  const response = await fetch(monitor.url + "/preview");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain("allow-same-origin");
  expect(html).not.toMatch(
    /private-auth|tokenProvenance|tokenSources|planDigest/,
  );
  expect(response.headers.get("content-security-policy")).toContain(
    "connect-src 'none'",
  );
  for (const route of [
    "/manifest.json",
    "/plan.json",
    "/prototype.css",
    "/prototype.js",
  ])
    expect((await fetch(monitor.url + route)).status).toBe(404);
  await rm(path.join(preview, "prototype.js"));
  await symlink(
    path.join(root, ".mimic/workspace.json"),
    path.join(preview, "prototype.js"),
  );
  const linked = await server(root, preview);
  expect((await state(linked.url)).preview.state).toBe("unavailable");
  const selectedLink = preview + "-link";
  await symlink(preview, selectedLink);
  roots.push(selectedLink);
  const linkedDirectory = await server(root, selectedLink);
  expect((await state(linkedDirectory.url)).preview.state).toBe("unavailable");
});

test("browser observes actual Core polling, stopped/accepted checkpoints and interactive isolated new tab", async () => {
  const { root, runtime } = await setup();
  const preview = await bundle();
  const originalScript = await readFile(
    path.join(preview, "prototype.js"),
    "utf8",
  );
  await writeFile(
    path.join(preview, "prototype.js"),
    originalScript +
      '\ndocument.body.dataset.literal = "$&|$`|$\'|</script>"; document.body.dataset.controlsReady = String(document.querySelectorAll("button").length > 0);',
  );
  await writeFile(
    path.join(preview, "prototype.css"),
    (await readFile(path.join(preview, "prototype.css"), "utf8")) +
      '\nbody { --literal: "$&|$`|$\'"; }',
  );
  const monitor = await server(root, preview);
  const browser = await chromium.launch({
    executablePath: process.env.MIMIC_CHROME_EXECUTABLE,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(monitor.url);
    await page.locator('[data-run-id="run_monitor"]').waitFor();
    await page.locator("#run-search").fill("missing-run");
    expect(await page.locator('[data-run-id="run_monitor"]').isHidden()).toBe(
      true,
    );
    expect(await page.locator("#run-detail").textContent()).toContain(
      "run_monitor",
    );
    expect(await page.locator("#selection-note").textContent()).toContain(
      "検索結果の外",
    );
    await page.locator("#run-search").fill("run_monitor");
    expect(await page.locator('[data-run-id="run_monitor"]').isVisible()).toBe(
      true,
    );
    expect(
      await page
        .locator("#product-preview-link")
        .evaluate(
          (link) =>
            !!(
              link.compareDocumentPosition(document.getElementById("runs")!) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
    ).toBe(true);
    expect(
      await page
        .locator('[data-testid="connection-status"]')
        .getAttribute("data-state"),
    ).toBe("connected");
    expect(
      await page.locator('[data-run-id="run_monitor"]').textContent(),
    ).toContain("進行可能");
    await page.locator('[data-run-id="run_monitor"]').click();
    expect(
      await page
        .locator('[data-run-id="run_monitor"]')
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(await page.locator("#run-detail").textContent()).toContain(
      "Core の保存状態",
    );
    await runtime.registry.setWork({
      runId: "run_monitor",
      safeActions: [],
      blockers: {},
      actor,
      at,
      reason: "private-core-transition",
    });
    await expect
      .poll(async () => page.locator("#run-detail").textContent(), {
        timeout: 6000,
      })
      .toContain("Run 終了");
    expect(
      await page
        .locator('[data-run-id="run_monitor"]')
        .getAttribute("aria-current"),
    ).toBe("true");
    await new FileSessionStore(root).write(checkpoint());
    await expect
      .poll(async () => page.locator("#run-detail").textContent(), {
        timeout: 6000,
      })
      .toContain("結果不明・要照合");
    await new FileSessionStore(root).write(checkpoint("approval", true));
    await expect
      .poll(async () => page.locator("#run-detail").textContent(), {
        timeout: 6000,
      })
      .toContain("提出済み");
    expect(await page.locator("#run-detail").textContent()).toContain(
      "人の承認待ち",
    );
    await page.locator("#run-search").clear();
    await runtime.registry.start({
      id: "run_second",
      scope: "org_local",
      entryMode: "system-first",
      base: [],
      reused: [],
      safeActions: ["task_second"],
      actor,
      at,
      reason: "second-run-selection",
    });
    await page.locator('[data-run-id="run_second"]').waitFor({ timeout: 6000 });
    expect(await page.locator("#run-count").textContent()).toContain("2 / 2");
    await page.locator('[data-run-id="run_second"]').focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#run-detail h2").textContent()).toBe(
      "run_second",
    );
    await runtime.registry.setWork({
      runId: "run_second",
      safeActions: [],
      blockers: {},
      actor,
      at,
      reason: "focused-run-transition",
    });
    await expect
      .poll(
        async () => page.locator('[data-run-id="run_second"]').textContent(),
        { timeout: 6000 },
      )
      .toContain("Run 終了");
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-run-id"),
      ),
    ).toBe("run_second");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.locator('[data-run-id="run_monitor"]').click();
    expect(await page.locator("#run-detail h2").textContent()).toBe(
      "run_monitor",
    );
    expect(await page.locator(".table-scroll").getAttribute("tabindex")).toBe(
      "0",
    );
    const opened = context.waitForEvent("page");
    await page.locator("#product-preview-link").click();
    const tab = await opened;
    await tab.waitForLoadState();
    expect(await tab.evaluate(() => window.opener === null)).toBe(true);
    expect(
      await tab
        .getByRole("link", { name: "Run 一覧に戻る" })
        .getAttribute("href"),
    ).toBe("/");
    const frame = tab.frameLocator('iframe[title="Product preview"]');
    await frame
      .getByRole("button", { name: "Show success", exact: true })
      .click();
    await frame
      .getByRole("button", { name: "Choose candidate", exact: true })
      .click();
    expect(await frame.locator("#prototype-status").textContent()).toContain(
      "disabled",
    );
    await frame
      .getByRole("button", { name: "Show success", exact: true })
      .click();
    expect(await frame.locator("#prototype-status").textContent()).toContain(
      "success",
    );
    const child = tab
      .frames()
      .find((candidate) => candidate !== tab.mainFrame())!;
    expect(await child.evaluate(() => document.body.dataset.literal)).toBe(
      "$&|$`|$'|</script>",
    );
    expect(
      await child.evaluate(() => document.body.dataset.controlsReady),
    ).toBe("true");
    expect(
      await child.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue("--literal"),
      ),
    ).toContain("$&|$`|$'");
    await page.route("**/api/state", (route) => route.abort());
    const deliveredRequests: string[] = [];
    monitor.server.on("request", (request) =>
      deliveredRequests.push(request.url!),
    );
    const failedRequests: string[] = [];
    tab.on("requestfailed", (request) =>
      failedRequests.push(request.failure()!.errorText),
    );
    const attemptedRequests: string[] = [];
    tab.on("request", (request) => attemptedRequests.push(request.url()));
    const isolation = await child.evaluate(async (origin) => {
      let parentBlocked = false,
        apiBlocked = false,
        externalBlocked = false;
      const violations: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.disposition === "enforce")
          violations.push(event.effectiveDirective);
      });
      try {
        void parent.document.body.innerHTML;
      } catch {
        parentBlocked = true;
      }
      try {
        await fetch(origin + "/api/state");
      } catch {
        apiBlocked = true;
      }
      try {
        await fetch("https://example.invalid/private");
      } catch {
        externalBlocked = true;
      }
      const nonce =
        document.querySelector<HTMLScriptElement>("script[nonce]")!.nonce;
      const script = document.createElement("script");
      script.nonce = nonce;
      script.src = origin + "/monitor.js";
      document.head.append(script);
      const link = document.createElement("link");
      link.nonce = nonce;
      link.rel = "stylesheet";
      link.href = origin + "/monitor.js";
      document.head.append(link);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { parentBlocked, apiBlocked, externalBlocked, violations };
    }, monitor.url);
    expect(isolation).toMatchObject({
      parentBlocked: true,
      apiBlocked: true,
      externalBlocked: true,
    });
    expect(isolation.violations).toEqual(
      expect.arrayContaining([
        "connect-src",
        "script-src-elem",
        "style-src-elem",
      ]),
    );
    expect(deliveredRequests).toEqual([]);
    expect(attemptedRequests.length).toBeGreaterThan(0);
    expect(failedRequests.length).toBe(attemptedRequests.length);
    await page.unroute("**/api/state");
    expect(await page.locator("body").textContent()).not.toMatch(
      /private-|private-work|private-model/,
    );
    await monitor.close();
    monitors.splice(monitors.indexOf(monitor), 1);
    await expect
      .poll(
        async () => page.locator("#connection").getAttribute("data-state"),
        { timeout: 6000 },
      )
      .toBe("disconnected");
    expect(await page.locator("#run-browser").getAttribute("data-stale")).toBe(
      "true",
    );
  } finally {
    await browser.close();
  }
}, 60_000);

test("production CLI monitor starts/stops and rejects invalid options without disclosing paths", async () => {
  const { root } = await setup();
  const errors: string[] = [];
  expect(
    await runCli(["monitor", "--root", root, "--port", "invalid"], {
      out: () => {},
      err: (line) => errors.push(line),
    }),
  ).toBe(2);
  expect(errors.join("\n")).not.toContain(root);
  const child = spawn(
    process.execPath,
    [
      path.join(repo, "apps/cli/dist/main.js"),
      "monitor",
      "--root",
      root,
      "--port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) =>
        resolve(chunk.toString().trim()),
      );
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Early CLI exit")));
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await state(url)).readOnly).toBe(true);
    const ended = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    child.kill("SIGTERM");
    expect(await ended).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
