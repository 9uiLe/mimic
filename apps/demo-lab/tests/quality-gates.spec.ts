import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildPrototype } from "../../../packages/core/src/prototype-builder/index.js";
import type { PrototypeBuilderInput } from "../../../packages/core/src/prototype-builder/index.js";
import { canonicalJson } from "../../../packages/core/src/artifact-canonical.js";
import { runBrowserQualityGates } from "../../../packages/core/src/quality-gates/browser.js";
import { setupApprovedPrototypeFixture } from "../../../fixtures/prototypes/approved.js";
import {
  brokenTransition,
  brokenEmptyRecovery,
  oneShotTransition,
  inaccessibleImage,
  overflowingUnfocusedCss,
} from "../../../fixtures/quality-gates/regressions.js";

test("browser gates inspect generated states and detect a broken transition", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(300_000);
  const fixture = await setupApprovedPrototypeFixture();
  try {
    const output = await buildPrototype(
      fixture.store,
      fixture.input,
      fixture.root,
    );
    const input = { trustedRoot: fixture.root, directory: output.directory };
    const good = await runBrowserQualityGates(input, browser);
    const unavailable = await runBrowserQualityGates(input, {
      async newContext() {
        throw new Error("synthetic browser launch failure");
      },
    } as unknown as Browser);
    expect(
      unavailable.findings.filter((item) => item.state === "UNVERIFIED"),
    ).toHaveLength(10);
    expect(good.target.planDigest).toBe(output.planDigest);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      for (const criterion of [
        "browser-render",
        "axe",
        "keyboard-focus",
        "viewport-overflow",
        "navigation-state",
      ])
        expect(
          good.findings.find(
            (item) =>
              item.criterion === criterion &&
              item.conditions.browser === device,
          )?.state,
          JSON.stringify(
            good.findings.find(
              (item) =>
                item.criterion === criterion &&
                item.conditions.browser === device,
            ),
          ),
        ).toBe("PASS");

    const script = path.join(output.directory, "prototype.js");
    const originalScript = await readFile(script, "utf8");
    const switchStatement =
      "if (button) show(button.getAttribute('data-target-state'));";
    await writeFile(
      script,
      originalScript.replace(switchStatement, brokenEmptyRecovery),
    );
    const recovery = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`]) {
      const navigation = recovery.findings.find(
        (item) =>
          item.criterion === "navigation-state" &&
          item.conditions.browser === device,
      );
      expect(navigation?.state, `${device}: ${navigation?.reason}`).toBe(
        "FAIL",
      );
      expect(navigation?.reason).toContain("empty");
    }
    await writeFile(script, originalScript);
    const htmlFile = path.join(output.directory, "index.html");
    const originalHtml = await readFile(htmlFile, "utf8");
    await writeFile(
      htmlFile,
      originalHtml.replace(
        '<div data-state="empty" hidden>',
        '<div data-state="empty" hidden><button type="button" data-target-state="success">Undeclared action</button>',
      ),
    );
    const surplus = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`]) {
      const navigation = surplus.findings.find(
        (item) =>
          item.criterion === "navigation-state" &&
          item.conditions.browser === device,
      );
      expect(navigation?.state).toBe("FAIL");
      expect(navigation?.reason).toContain("rendered buttons differ");
    }
    await writeFile(htmlFile, originalHtml);
    await writeFile(
      script,
      originalScript
        .replace(
          "document.addEventListener",
          "const seen = new Set();\ndocument.addEventListener",
        )
        .replace(switchStatement, oneShotTransition),
    );
    const oneShot = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`]) {
      const navigation = oneShot.findings.find(
        (item) =>
          item.criterion === "navigation-state" &&
          item.conditions.browser === device,
      );
      expect(navigation?.state, `${device}: ${navigation?.reason}`).toBe(
        "FAIL",
      );
    }
    await writeFile(script, originalScript);
    await writeFile(
      script,
      originalScript.replace(switchStatement, brokenTransition),
    );
    const broken = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      expect(
        broken.findings.find(
          (item) =>
            item.criterion === "navigation-state" &&
            item.conditions.browser === device,
        )?.state,
      ).toBe("FAIL");
    expect(broken.target.bundleDigest).not.toBe(good.target.bundleDigest);
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace(
        brokenTransition,
        "if (button) show(button.getAttribute('data-target-state'));",
      ),
    );
    await writeFile(
      htmlFile,
      (await readFile(htmlFile, "utf8")).replace(
        "</body>",
        `${inaccessibleImage}</body>`,
      ),
    );
    const cssFile = path.join(output.directory, "prototype.css");
    await writeFile(
      cssFile,
      (await readFile(cssFile, "utf8")) + overflowingUnfocusedCss,
    );
    const impaired = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      for (const criterion of ["axe", "viewport-overflow", "keyboard-focus"])
        expect(
          impaired.findings.find(
            (item) =>
              item.criterion === criterion &&
              item.conditions.browser === device,
          )?.state,
          `${device} ${criterion}`,
        ).toBe("FAIL");

    const planFile = path.join(output.directory, "plan.json");
    const manifestFile = path.join(output.directory, "manifest.json");
    const plan = JSON.parse(await readFile(planFile, "utf8"));
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    plan.requiredStates = [];
    plan.states = [];
    manifest.requiredStates = [];
    manifest.planDigest = `sha256:${createHash("sha256")
      .update(canonicalJson(plan))
      .digest("hex")}`;
    await writeFile(planFile, `${canonicalJson(plan)}\n`);
    await writeFile(manifestFile, `${canonicalJson(manifest)}\n`);
    const empty = await runBrowserQualityGates(input, browser);
    expect(empty.target.planDigest).toBe(manifest.planDigest);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      for (const criterion of [
        "axe",
        "keyboard-focus",
        "viewport-overflow",
        "navigation-state",
      ])
        expect(
          empty.findings.find(
            (item) =>
              item.criterion === criterion &&
              item.conditions.browser === device,
          )?.state,
          `${device} ${criterion} cannot pass with zero inspected states`,
        ).not.toBe("PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("browser transport loss is unverified after an initial render", async ({
  browser,
  browserName,
}) => {
  const fixture = await setupApprovedPrototypeFixture();
  try {
    const output = await buildPrototype(
      fixture.store,
      fixture.input,
      fixture.root,
    );
    const interrupted = new Proxy(browser, {
      get(target, property) {
        if (property === "newContext")
          return async (...args: Parameters<Browser["newContext"]>) => {
            const context = await target.newContext(...args);
            const newPage = context.newPage.bind(context);
            context.newPage = async () => {
              const page = await newPage();
              const goto = page.goto.bind(page);
              let visits = 0;
              page.goto = async (...visitArgs) => {
                if (++visits === 2) {
                  await page.close();
                  throw new Error(
                    "Target page, context or browser has been closed",
                  );
                }
                return goto(...visitArgs);
              };
              return page;
            };
            return context;
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const report = await runBrowserQualityGates(
      { trustedRoot: fixture.root, directory: output.directory },
      interrupted,
    );
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`]) {
      const navigation = report.findings.find(
        (item) =>
          item.criterion === "navigation-state" &&
          item.conditions.browser === device,
      );
      expect(navigation?.state).toBe("UNVERIFIED");
      expect(navigation?.reason).toContain("closed");
      expect(
        report.findings.find(
          (item) =>
            item.criterion === "axe" && item.conditions.browser === device,
        )?.state,
      ).toBe("UNVERIFIED");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fragment-only navigation is checked and empty navigation is N/A", async ({
  browser,
  browserName,
}) => {
  const fixture = await setupApprovedPrototypeFixture();
  try {
    const plan: PrototypeBuilderInput = {
      ...fixture.input,
      initialState: "success",
      requiredStates: ["success"],
      states: [
        {
          name: "success",
          root: {
            tag: "main",
            children: [
              { tag: "h1", text: "Single state" },
              { tag: "a", href: "#details", text: "Read details" },
              { tag: "p", id: "details", text: "Synthetic details" },
            ],
          },
        },
      ],
      fixtures: { success: { message: "Synthetic details" } },
    };
    const output = await buildPrototype(fixture.store, plan, fixture.root);
    const input = { trustedRoot: fixture.root, directory: output.directory };
    const good = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`]) {
      const navigation = good.findings.find(
        (item) =>
          item.criterion === "navigation-state" &&
          item.conditions.browser === device,
      );
      expect(navigation?.state).toBe("PASS");
      expect(navigation?.conditions.fragmentLinksChecked).toBe(1);
    }
    const htmlFile = path.join(output.directory, "index.html");
    await writeFile(
      htmlFile,
      (await readFile(htmlFile, "utf8")).replace(
        'href="#details"',
        'href="#missing"',
      ),
    );
    const broken = await runBrowserQualityGates(input, browser);
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      expect(
        broken.findings.find(
          (item) =>
            item.criterion === "navigation-state" &&
            item.conditions.browser === device,
        )?.state,
      ).toBe("FAIL");

    const noNavigation = await buildPrototype(
      fixture.store,
      {
        ...plan,
        outputPath: "generated-without-navigation",
        states: [
          {
            name: "success",
            root: {
              tag: "main",
              children: [{ tag: "h1", text: "Single state" }],
            },
          },
        ],
      },
      fixture.root,
    );
    const none = await runBrowserQualityGates(
      { trustedRoot: fixture.root, directory: noNavigation.directory },
      browser,
    );
    for (const device of [`${browserName}-desktop`, `${browserName}-mobile`])
      expect(
        none.findings.find(
          (item) =>
            item.criterion === "navigation-state" &&
            item.conditions.browser === device,
        )?.state,
      ).toBe("N/A");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
