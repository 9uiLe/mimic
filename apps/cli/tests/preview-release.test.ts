import { afterEach, expect, test } from "vitest";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  FilePackageSource,
  packageDigest,
  serializePackageDocument,
  sha256,
  type PackageManifest,
  type DesignLock,
  type PackageSnapshot,
} from "@mimic/core";
import {
  setupSystemFirst,
  syntheticHuman,
} from "../../../fixtures/dogfood/system-first/setup.js";
import { EXIT, runCli, type CliHost } from "../src/cli.js";

const cases: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(cases.splice(0).map((item) => item.close()));
});
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
async function call(root: string, args: string[], host: CliHost = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    [...args, "--root", root, "--json"],
    { out: (value) => stdout.push(value), err: (value) => stderr.push(value) },
    host,
  );
  return {
    code,
    stderr,
    value: stdout.length
      ? (JSON.parse(stdout.at(-1)!) as Record<string, unknown>)
      : undefined,
  };
}
async function setup() {
  const value = await setupSystemFirst();
  cases.push(value);
  const root = value.root;
  const scopes = [
    { level: "organization", ownerId: "org_riverbend" },
    {
      level: "product",
      ownerId: "product_riverbend",
      parentId: "org_riverbend",
    },
    {
      level: "domain",
      ownerId: "domain_triage",
      parentId: "product_riverbend",
    },
    {
      level: "domain",
      ownerId: "domain_dispatch",
      parentId: "product_riverbend",
    },
  ];
  await writeFile(
    path.join(root, "scopes.json"),
    JSON.stringify({
      version: 1,
      defaultScope: "product_riverbend",
      scopes,
    }),
  );
  expect((await call(root, ["init", "--scopes", "scopes.json"])).code).toBe(
    EXIT.OK,
  );
  await copyFile(
    path.join(root, "workspace.json"),
    path.join(root, ".mimic", "workspace.json"),
  );
  const seedAuthority = {
    verifyApproval: async (approval: { decisionId: string; actorId: string }) =>
      approval.decisionId === "synthetic_seed" &&
      approval.actorId === syntheticHuman.id,
    verifyDecision: async () => false,
  };
  const release: NonNullable<CliHost["release"]> = {
    packageAuthority: {
      verifyRelease: async (manifest) =>
        manifest.ref.packageId === "product/riverbend-cli" &&
        manifest.ref.version === "0.1.0" &&
        manifest.approval.decisionId === "synthetic_release_cli" &&
        manifest.approval.actorId === syntheticHuman.id,
      verifyPromotion: async () => false,
    },
    licenseAllowed: async () => false,
    policy: {
      assess: async (finding) => ({
        blockRelease: finding.state === "FAIL",
        reason: `Synthetic test review of ${finding.criterion}: ${finding.state}`,
      }),
    },
  };
  const host: CliHost = { seedAuthority, release };
  return { ...value, host };
}
async function previewCase(
  value: Awaited<ReturnType<typeof setup>>,
  kind: "standalone" | "modes",
) {
  const { root, modePlan, refs, host } = value;
  const plan =
    kind === "modes"
      ? { kind, plan: modePlan, uiContract: refs.contract }
      : {
          kind,
          plan: { ...modePlan.current, outputPath: "standalone-cli" },
          uiContract: refs.contract,
        };
  await writeFile(path.join(root, "preview.json"), JSON.stringify(plan));
  const result = await call(root, ["preview", "--file", "preview.json"], host);
  expect(result.code, result.stderr.join("\n")).toBe(EXIT.OK);
  const reports = result.value!.reports as {
    path: string;
    findings: { state: string; criterion: string }[];
  }[];
  expect(reports).toHaveLength(kind === "modes" ? 2 : 1);
  for (const report of reports)
    expect(
      report.findings.filter((finding) => finding.state === "FAIL"),
    ).toEqual([]);
  return result.value!;
}
async function releasePlan(
  value: Awaited<ReturnType<typeof setup>>,
  preview: Record<string, unknown>,
  mode: "reference" | "portable",
) {
  const { root, refs } = value;
  const directories = preview.directories as string[];
  const reports = preview.reports as { path: string }[];
  const included = (
    artifacts: readonly unknown[] = [],
    files: string[] = [],
  ) => ({
    status: "included",
    artifacts,
    files,
    dependencies: [],
  });
  const prototypeFiles = [
    "index.html",
    "prototype.css",
    "prototype.js",
    "plan.json",
    "manifest.json",
  ];
  const files: Record<string, string> = Object.fromEntries(
    prototypeFiles.map((name) => [
      `prototype/${name}`,
      path.join(directories[0]!, name),
    ]),
  );
  for (const name of ["quality/limits.txt", "decisions.txt", "guide.md"]) {
    const local = name.replaceAll("/", "_");
    await writeFile(
      path.join(root, local),
      "Explicit synthetic review evidence\n",
    );
    files[name] = local;
  }
  const plan = {
    ref: { packageId: "product/riverbend-cli", version: "0.1.0" },
    mode,
    scope: {
      level: "product",
      ownerId: "product_riverbend",
      parentId: "org_riverbend",
    },
    schemaVersion: "1.0.0",
    approval: {
      decisionId: "synthetic_release_cli",
      actorId: syntheticHuman.id,
      at: new Date().toISOString(),
    },
    inventory: {
      "product-foundation": included([refs.product, refs.users, refs.current]),
      "experience-structure": included([
        ...refs.domains,
        refs.journey,
        refs.profile,
        refs.references,
        refs.directionA,
      ]),
      "design-system": included(refs.assets),
      "interface-system-boundary": included([refs.contract]),
      prototype: included(
        [],
        prototypeFiles.map((name) => `prototype/${name}`),
      ),
      scenarios: included([refs.scenario]),
      quality: included([], ["quality/limits.txt"]),
      decisions: included([], ["decisions.txt"]),
      handoff: included([], ["guide.md"]),
    },
    files,
    dependencies: [],
    quality: [{ report: reports[0]!.path, artifacts: [refs.scenario] }],
  };
  await writeFile(path.join(root, "release-plan.json"), JSON.stringify(plan));
  await mkdir(path.join(root, "packages"));
  return plan;
}

test.each(["standalone", "modes"] as const)(
  "CLI preview uses exact Core artifacts for %s",
  async (kind) => {
    const value = await setup();
    await previewCase(value, kind);
  },
);

test.each(["reference", "portable"] as const)(
  "CLI prepares and publishes a synthetic %s candidate only with exact confirmation",
  async (mode) => {
    const value = await setup();
    const preview = await previewCase(value, "standalone");
    const plan = await releasePlan(value, preview, mode);
    const args = [
      "release",
      "prepare",
      "--id",
      "candidate",
      "--file",
      "release-plan.json",
      "--destination",
      "packages",
    ];
    expect((await call(value.root, args)).code).toBe(EXIT.UNSUPPORTED);
    const prepared = await call(value.root, args, value.host);
    expect(prepared.code, prepared.stderr.join("\n")).toBe(EXIT.OK);
    const review = JSON.parse(
      await readFile(
        path.join(value.root, prepared.value!.reviewPath as string),
        "utf8",
      ),
    ) as {
      request: {
        ref: { packageId: string; version: string };
        mode: string;
        digest: string;
      };
      destination: string;
      requestDigest: string;
    };
    expect(review.request.mode).toBe(mode);
    expect(
      (
        await call(
          value.root,
          ["release", "publish", "candidate", "--confirmation", "missing.json"],
          value.host,
        )
      ).code,
    ).toBe(EXIT.INVALID);
    const confirmation = {
      version: 1,
      action: "release",
      hostId: "synthetic-test-host",
      humanActorId: syntheticHuman.id,
      confirmedAt: new Date().toISOString(),
      requestId: "synthetic_release_cli",
      requestDigest: review.requestDigest,
      packageId: review.request.ref.packageId,
      packageVersion: review.request.ref.version,
      mode,
      digest: review.request.digest,
      destination: review.destination,
    };
    await writeFile(
      path.join(value.root, "confirmation.json"),
      JSON.stringify({ ...confirmation, digest: hash(plan) }),
    );
    expect(
      (
        await call(
          value.root,
          [
            "release",
            "publish",
            "candidate",
            "--confirmation",
            "confirmation.json",
          ],
          value.host,
        )
      ).code,
    ).toBe(EXIT.INVALID);
    await writeFile(
      path.join(value.root, "confirmation.json"),
      JSON.stringify(confirmation),
    );
    const published = await call(
      value.root,
      [
        "release",
        "publish",
        "candidate",
        "--confirmation",
        "confirmation.json",
      ],
      value.host,
    );
    expect(published.code, published.stderr.join("\n")).toBe(EXIT.OK);
    expect(published.value?.status).toBe("published");
    const bytes = await new FilePackageSource(
      path.join(value.root, "packages"),
    ).read(review.request.ref);
    expect(packageDigest(bytes!)).toBe(review.request.digest);
    const retry = await call(
      value.root,
      [
        "release",
        "publish",
        "candidate",
        "--confirmation",
        "confirmation.json",
      ],
      value.host,
    );
    expect(retry.value?.status).toBe("recovered");
    expect((await call(value.root, args, value.host)).code).toBe(EXIT.OK);
    await writeFile(
      path.join(value.root, "release-plan.json"),
      JSON.stringify({ ...plan, schemaVersion: "2.0.0" }),
    );
    expect((await call(value.root, args, value.host)).code).toBe(EXIT.CONFLICT);
  },
  20_000,
);

test("preview rejects changed source locks and paths outside the workspace", async () => {
  const value = await setup();
  const wrong = structuredClone(value.modePlan.current);
  wrong.scenario.lockDigest = `sha256:${"0".repeat(64)}`;
  await writeFile(
    path.join(value.root, "preview.json"),
    JSON.stringify({ kind: "standalone", plan: wrong }),
  );
  expect(
    (await call(value.root, ["preview", "--file", "preview.json"], value.host))
      .code,
  ).toBe(EXIT.INVALID);
  expect(
    (
      await call(
        value.root,
        ["preview", "--file", "../outside.json"],
        value.host,
      )
    ).code,
  ).toBe(EXIT.INVALID);
});

test("release preparation rejects stale evidence, unapproved artifacts, and escaped file paths", async () => {
  const value = await setup();
  const preview = await previewCase(value, "standalone");
  const plan = await releasePlan(value, preview, "reference");
  const args = [
    "release",
    "prepare",
    "--id",
    "candidate",
    "--file",
    "release-plan.json",
    "--destination",
    "packages",
  ];
  const invalidArtifact = structuredClone(plan);
  invalidArtifact.inventory["interface-system-boundary"].artifacts.push(
    value.refs.request,
  );
  await writeFile(
    path.join(value.root, "release-plan.json"),
    JSON.stringify(invalidArtifact),
  );
  expect((await call(value.root, args, value.host)).code).toBe(EXIT.INVALID);
  const escaped = structuredClone(plan);
  escaped.files["guide.md"] = "../outside.txt";
  await writeFile(
    path.join(value.root, "release-plan.json"),
    JSON.stringify(escaped),
  );
  expect((await call(value.root, args, value.host)).code).toBe(EXIT.INVALID);
  await writeFile(
    path.join(value.root, "release-plan.json"),
    JSON.stringify(plan),
  );
  const prototype = path.join(value.root, plan.files["prototype/index.html"]!);
  await writeFile(
    prototype,
    `${await readFile(prototype, "utf8")}<!-- changed after inspection -->`,
  );
  expect((await call(value.root, args, value.host)).code).toBe(EXIT.INVALID);
}, 15_000);

test("release confirmation rejects self approval and changed destination; exact retry recovers interruption", async () => {
  const value = await setup();
  const preview = await previewCase(value, "standalone");
  await releasePlan(value, preview, "reference");
  const prepared = await call(
    value.root,
    [
      "release",
      "prepare",
      "--id",
      "candidate",
      "--file",
      "release-plan.json",
      "--destination",
      "packages",
    ],
    value.host,
  );
  expect(prepared.code).toBe(EXIT.OK);
  const review = JSON.parse(
    await readFile(
      path.join(value.root, prepared.value!.reviewPath as string),
      "utf8",
    ),
  ) as {
    request: {
      ref: { packageId: string; version: string };
      mode: string;
      digest: string;
    };
    destination: string;
    requestDigest: string;
  };
  const confirmation = {
    version: 1,
    action: "release",
    hostId: "synthetic-test-host",
    humanActorId: syntheticHuman.id,
    confirmedAt: new Date().toISOString(),
    requestId: "synthetic_release_cli",
    requestDigest: review.requestDigest,
    packageId: review.request.ref.packageId,
    packageVersion: review.request.ref.version,
    mode: review.request.mode,
    digest: review.request.digest,
    destination: review.destination,
  };
  const publish = [
    "release",
    "publish",
    "candidate",
    "--confirmation",
    "confirmation.json",
  ];
  await writeFile(
    path.join(value.root, "confirmation.json"),
    JSON.stringify({ ...confirmation, humanActorId: "cli" }),
  );
  expect((await call(value.root, publish, value.host)).code).toBe(EXIT.INVALID);
  await writeFile(
    path.join(value.root, "confirmation.json"),
    JSON.stringify({ ...confirmation, destination: "other" }),
  );
  expect((await call(value.root, publish, value.host)).code).toBe(EXIT.INVALID);
  await writeFile(
    path.join(value.root, "confirmation.json"),
    JSON.stringify(confirmation),
  );
  const interrupted = await call(value.root, publish, {
    ...value.host,
    release: {
      ...value.host.release!,
      afterPublished: () => {
        throw new Error("synthetic interruption");
      },
    },
  });
  expect(interrupted.code).toBe(EXIT.IO);
  const retry = await call(value.root, publish, value.host);
  expect(retry.code, retry.stderr.join("\n")).toBe(EXIT.OK);
  expect(retry.value?.status).toBe("recovered");
  expect(
    (
      await call(
        value.root,
        [
          "release",
          "prepare",
          "--id",
          "another",
          "--file",
          "release-plan.json",
          "--destination",
          "packages",
        ],
        value.host,
      )
    ).code,
  ).toBe(EXIT.CONFLICT);
}, 20_000);

test("portable dependency requires both trusted license policy and exact redistribution grant", async () => {
  const value = await setup();
  const preview = await previewCase(value, "standalone");
  const plan = await releasePlan(value, preview, "portable");
  const ref = { packageId: "org/synthetic-cli-token", version: "1.0.0" };
  const content = new TextEncoder().encode("synthetic token bytes\n");
  const approval = {
    decisionId: "synthetic_child_release",
    actorId: syntheticHuman.id,
    at: new Date().toISOString(),
  };
  const manifest: PackageManifest = {
    format: 1,
    ref,
    kind: "design-system",
    mode: "reference",
    scope: { level: "organization", ownerId: "org_riverbend" },
    schemaVersion: "1.0.0",
    approval,
    files: [{ path: "token.txt", digest: sha256(content) }],
    assets: [],
    artifacts: [],
    dependencies: [],
  };
  const lock: DesignLock = {
    format: 1,
    root: ref,
    assets: [],
    artifacts: [],
    packages: [],
  };
  const snapshot: PackageSnapshot = {
    manifestBytes: serializePackageDocument(manifest),
    lockBytes: serializePackageDocument(lock),
    files: { "token.txt": content },
  };
  const childDir = path.join(
    value.root,
    "packages",
    "org",
    "synthetic-cli-token",
    ref.version,
  );
  await mkdir(childDir, { recursive: true });
  await writeFile(path.join(childDir, "manifest.json"), snapshot.manifestBytes);
  await writeFile(path.join(childDir, "design.lock.yaml"), snapshot.lockBytes);
  await writeFile(path.join(childDir, "token.txt"), content);
  const dep = {
    ref,
    digest: packageDigest(snapshot),
    source: "synthetic local child",
    license: "Synthetic-Grant",
  };
  const linked = {
    ...plan,
    dependencies: [dep],
    inventory: {
      ...plan.inventory,
      "design-system": {
        ...plan.inventory["design-system"],
        dependencies: [ref],
      },
    },
  };
  await writeFile(
    path.join(value.root, "release-plan.json"),
    JSON.stringify(linked),
  );
  const args = [
    "release",
    "prepare",
    "--id",
    "candidate",
    "--file",
    "release-plan.json",
    "--destination",
    "packages",
  ];
  const childAuthority = {
    ...value.host.release!,
    packageAuthority: {
      verifyRelease: async (item: PackageManifest) =>
        (item.ref.packageId === ref.packageId &&
          item.approval.decisionId === approval.decisionId) ||
        (item.ref.packageId === plan.ref.packageId &&
          item.approval.decisionId === plan.approval.decisionId),
      verifyPromotion: async () => false,
    },
  };
  expect(
    (await call(value.root, args, { ...value.host, release: childAuthority }))
      .code,
  ).toBe(EXIT.INVALID);
  const licensed = {
    ...childAuthority,
    licenseAllowed: async (license: string) => license === "Synthetic-Grant",
  };
  expect(
    (await call(value.root, args, { ...value.host, release: licensed })).code,
  ).toBe(EXIT.INVALID);
  const granted = {
    ...licensed,
    redistribution: [
      {
        ref,
        digest: dep.digest,
        allowed: true,
        evidence: "Explicit synthetic fixture grant",
      },
    ],
  };
  const prepared = await call(value.root, args, {
    ...value.host,
    release: granted,
  });
  expect(prepared.code, prepared.stderr.join("\n")).toBe(EXIT.OK);
}, 20_000);

test("cooperating concurrent publishers cannot publish two versions", async () => {
  const value = await setup();
  const preview = await previewCase(value, "standalone");
  await releasePlan(value, preview, "reference");
  const prepared = await call(
    value.root,
    [
      "release",
      "prepare",
      "--id",
      "candidate",
      "--file",
      "release-plan.json",
      "--destination",
      "packages",
    ],
    value.host,
  );
  expect(prepared.code).toBe(EXIT.OK);
  const review = JSON.parse(
    await readFile(
      path.join(value.root, prepared.value!.reviewPath as string),
      "utf8",
    ),
  ) as {
    request: {
      ref: { packageId: string; version: string };
      mode: string;
      digest: string;
    };
    destination: string;
    requestDigest: string;
  };
  await writeFile(
    path.join(value.root, "confirmation.json"),
    JSON.stringify({
      version: 1,
      action: "release",
      hostId: "synthetic-test-host",
      humanActorId: syntheticHuman.id,
      confirmedAt: new Date().toISOString(),
      requestId: "synthetic_release_cli",
      requestDigest: review.requestDigest,
      packageId: review.request.ref.packageId,
      packageVersion: review.request.ref.version,
      mode: review.request.mode,
      digest: review.request.digest,
      destination: review.destination,
    }),
  );
  const args = [
    "release",
    "publish",
    "candidate",
    "--confirmation",
    "confirmation.json",
  ];
  const results = await Promise.all([
    call(value.root, args, value.host),
    call(value.root, args, value.host),
  ]);
  expect(results.some((item) => item.code === EXIT.OK)).toBe(true);
  expect(
    results.every((item) => [EXIT.OK, EXIT.CONFLICT].includes(item.code)),
  ).toBe(true);
  const bytes = await new FilePackageSource(
    path.join(value.root, "packages"),
  ).read(review.request.ref);
  expect(packageDigest(bytes!)).toBe(review.request.digest);
}, 20_000);

test("cooperative local host can use the standalone release commands for a dependency-free candidate", async () => {
  const value = await setup();
  const preview = await previewCase(value, "standalone");
  await releasePlan(value, preview, "reference");
  const host: CliHost = { seedAuthority: value.host.seedAuthority };
  const inspected = await call(
    value.root,
    ["release", "inspect", "--file", "release-plan.json"],
    host,
  );
  expect(inspected.code).toBe(EXIT.OK);
  const matrix = inspected.value!.reports as {
    reportDigest: string;
    findings: { criterion: string; state: string; severity: string }[];
  }[];
  const localPolicy = {
    version: 1,
    action: "release-policy",
    hostId: "synthetic-local-host",
    confirmedAt: new Date().toISOString(),
    planDigest: inspected.value!.planDigest,
    decisions: matrix.flatMap(({ reportDigest, findings }) =>
      findings.map((finding) => ({
        reportDigest,
        ...finding,
        blockRelease: finding.state === "FAIL",
        reason: `Synthetic local policy review: ${finding.criterion}`,
      })),
    ),
  };
  await writeFile(
    path.join(value.root, "local-policy.json"),
    JSON.stringify(localPolicy),
  );
  const prepare = [
    "release",
    "prepare",
    "--id",
    "candidate",
    "--file",
    "release-plan.json",
    "--destination",
    "packages",
    "--policy-confirmation",
    "local-policy.json",
  ];
  await writeFile(
    path.join(value.root, "local-policy.json"),
    JSON.stringify({
      ...localPolicy,
      decisions: localPolicy.decisions.slice(1),
    }),
  );
  expect((await call(value.root, prepare, host)).code).toBe(EXIT.INVALID);
  for (const decisions of [
    [...localPolicy.decisions, localPolicy.decisions[0]],
    [
      { ...localPolicy.decisions[0], state: "FAIL" },
      ...localPolicy.decisions.slice(1),
    ],
    [
      { ...localPolicy.decisions[0], severity: "NOTE" },
      ...localPolicy.decisions.slice(1),
    ],
    [
      { ...localPolicy.decisions[0], reportDigest: `sha256:${"0".repeat(64)}` },
      ...localPolicy.decisions.slice(1),
    ],
  ]) {
    await writeFile(
      path.join(value.root, "local-policy.json"),
      JSON.stringify({ ...localPolicy, decisions }),
    );
    expect((await call(value.root, prepare, host)).code).toBe(EXIT.INVALID);
  }
  const reportPath = (preview.reports as { path: string }[])[0]!.path;
  const reportFile = path.join(value.root, reportPath);
  const originalReport = await readFile(reportFile, "utf8");
  const changedReport = JSON.parse(originalReport) as { inspectedAt: string };
  changedReport.inspectedAt = "2099-01-01T00:00:00.000Z";
  await writeFile(reportFile, JSON.stringify(changedReport));
  await writeFile(
    path.join(value.root, "local-policy.json"),
    JSON.stringify(localPolicy),
  );
  expect((await call(value.root, prepare, host)).code).toBe(EXIT.INVALID);
  await writeFile(reportFile, originalReport);
  await writeFile(
    path.join(value.root, "local-policy.json"),
    JSON.stringify(localPolicy),
  );
  const prepared = await call(value.root, prepare, host);
  expect(prepared.code, prepared.stderr.join("\n")).toBe(EXIT.OK);
  const review = JSON.parse(
    await readFile(
      path.join(value.root, prepared.value!.reviewPath as string),
      "utf8",
    ),
  ) as {
    request: {
      ref: { packageId: string; version: string };
      mode: string;
      digest: string;
    };
    destination: string;
    requestDigest: string;
  };
  await writeFile(
    path.join(value.root, "confirmation.json"),
    JSON.stringify({
      version: 1,
      action: "release",
      hostId: "synthetic-local-host",
      humanActorId: syntheticHuman.id,
      confirmedAt: new Date().toISOString(),
      requestId: "synthetic_release_cli",
      requestDigest: review.requestDigest,
      packageId: review.request.ref.packageId,
      packageVersion: review.request.ref.version,
      mode: review.request.mode,
      digest: review.request.digest,
      destination: review.destination,
    }),
  );
  const published = await call(
    value.root,
    ["release", "publish", "candidate", "--confirmation", "confirmation.json"],
    host,
  );
  expect(published.code, published.stderr.join("\n")).toBe(EXIT.OK);
  expect(published.value?.status).toBe("published");
}, 20_000);
