import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { HtmlValidate } from "html-validate";
import { ESLint } from "eslint";
import stylelint from "stylelint";
import { canonicalJson } from "../artifact-canonical.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { PrototypeBuilderInput } from "../prototype-builder/index.js";
import { compileApprovedTokenAssets } from "../token-compiler/index.js";

export type GateState = "PASS" | "CONCERN" | "FAIL" | "UNVERIFIED" | "N/A";
export type GateSeverity = "BLOCKER" | "MAJOR" | "MINOR" | "NOTE";
export interface GateFinding {
  readonly criterion: string;
  readonly state: GateState;
  readonly severity: GateSeverity;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly limitations: string;
  readonly conditions: Readonly<Record<string, string | number | boolean>>;
}
export interface GateTarget {
  readonly directory: string;
  readonly bundleDigest: string;
  readonly files: Readonly<Record<string, string>>;
  readonly scenario?: {
    readonly artifactId: string;
    readonly revision: number;
    readonly lockDigest: string;
  };
  readonly planDigest?: string;
}
export interface QualityReport {
  readonly target: GateTarget;
  readonly findings: readonly GateFinding[];
  readonly inspectedAt: string;
  readonly action: "inspect-only";
}
export interface UiContractCheck {
  /** Exact approved Contract is supplied by the caller; it is never inferred from a scenario. */
  readonly artifactId: string;
  readonly revision: number;
  readonly lockDigest: string;
}
export interface GateInput {
  readonly trustedRoot: string;
  readonly directory: string;
  readonly store?: ArtifactStore;
  readonly uiContract?: UiContractCheck;
}
export interface InspectedBundle {
  readonly target: GateTarget;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  readonly plan: PrototypeBuilderInput | undefined;
  readonly manifest: Record<string, unknown> | undefined;
}
const NAMES = [
  "index.html",
  "prototype.css",
  "prototype.js",
  "plan.json",
  "manifest.json",
] as const;
const MAX_BYTES = 2_000_000;
const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown): value is UiContractCheck =>
  object(value) &&
  /^art_[A-Za-z0-9_-]+$/.test(String(value.artifactId)) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) > 0 &&
  /^sha256:[0-9a-f]{64}$/.test(String(value.lockDigest));

function finding(
  criterion: string,
  state: GateState,
  severity: GateSeverity,
  reason: string,
  evidence: readonly string[],
  limitations: string,
  conditions: GateFinding["conditions"] = {},
): GateFinding {
  return {
    criterion,
    state,
    severity,
    reason,
    evidence,
    limitations,
    conditions,
  };
}
function parse(value: string): Record<string, unknown> | undefined {
  try {
    const result: unknown = JSON.parse(value);
    return object(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Read only regular files in a trusted local directory. Never follows symlinks in the bundle. */
export async function inspectBundle(
  input: GateInput,
): Promise<InspectedBundle> {
  const root = await realpath(input.trustedRoot);
  const relative = path.relative(root, input.directory);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Bundle must be a child of trustedRoot");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Bundle path contains a symlink or non-directory");
  }
  if ((await realpath(current)) !== path.resolve(input.directory))
    throw new Error("Bundle escaped trustedRoot");
  const contents: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const name of NAMES) {
    const file = path.join(current, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      throw new Error(`Unsafe bundle file: ${name}`);
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_BYTES)
      throw new Error(`Oversized bundle file: ${name}`);
    contents[name] = bytes.toString("utf8");
    files[name] = digest(bytes);
  }
  const manifest = parse(contents["manifest.json"]!);
  const plan = parse(contents["plan.json"]!) as unknown as
    PrototypeBuilderInput | undefined;
  return {
    target: {
      directory: current,
      files,
      bundleDigest: digest(
        NAMES.map((name) => `${name}\0${files[name]}`).join("\n"),
      ),
      scenario: exact(manifest?.scenario) ? manifest.scenario : undefined,
      planDigest:
        typeof manifest?.planDigest === "string"
          ? manifest.planDigest
          : undefined,
    },
    html: contents["index.html"]!,
    css: contents["prototype.css"]!,
    js: contents["prototype.js"]!,
    plan,
    manifest,
  };
}

function refKey(value: unknown): string | undefined {
  if (!exact(value)) return undefined;
  return `${value.artifactId}@${value.revision}#${value.lockDigest}`;
}

/** Deterministic, inspect-only checks against the generated files and exact source locks. */
export async function runStaticQualityGates(
  input: GateInput,
): Promise<{ report: QualityReport; bundle: InspectedBundle }> {
  const bundle = await inspectBundle(input);
  const { manifest, plan, target } = bundle;
  const findings: GateFinding[] = [];
  const base = { bundleDigest: target.bundleDigest };
  const planMatches =
    !!plan &&
    !!manifest &&
    manifest.kind === "mimic-prototype-specification" &&
    manifest.productionReady === false &&
    manifest.fixtures === "synthetic" &&
    typeof manifest.planDigest === "string" &&
    manifest.planDigest === digest(canonicalJson(plan));
  findings.push(
    finding(
      "bundle-manifest",
      planMatches ? "PASS" : "FAIL",
      "BLOCKER",
      planMatches
        ? "Manifest describes this exact plan and synthetic specification output"
        : "Missing, malformed, or inconsistent manifest/plan digest",
      ["manifest.json", "plan.json"],
      "A matching plan digest does not approve authored render intent",
      base,
    ),
  );

  const refs: unknown[] = plan
    ? [
        plan.scenario,
        plan.selection?.pattern,
        plan.selection?.layout,
        ...(plan.selection?.components ?? []),
        plan.selection?.responsiveRule,
        plan.selection?.accessibilityRule,
        ...(plan.tokenSources ?? []),
      ]
    : [];
  const manifestRefs =
    manifest && Array.isArray(manifest.selectedAssets)
      ? manifest.selectedAssets
      : [];
  const manifestTokens =
    manifest && Array.isArray(manifest.tokenSources)
      ? manifest.tokenSources
      : [];
  const selectedKinds = [
    "pattern",
    "layout",
    ...(plan?.selection?.components ?? []).map(() => "component"),
    "responsive-rule",
    "accessibility-rule",
  ];
  const sourceMatch =
    !!plan &&
    !!manifest &&
    refKey(plan.scenario) === refKey(manifest.scenario) &&
    refs.every((ref) => !!refKey(ref)) &&
    manifestRefs.length ===
      refs.length - 1 - (plan?.tokenSources.length ?? 0) &&
    manifestRefs.every(
      (ref, index) =>
        refKey(ref) === refKey(refs[index + 1]) &&
        object(ref) &&
        ref.kind === selectedKinds[index],
    ) &&
    manifestTokens.length === (plan.tokenSources?.length ?? 0) &&
    manifestTokens.every(
      (ref, index) => refKey(ref) === refKey(plan.tokenSources[index]),
    );
  findings.push(
    finding(
      "source-locks",
      sourceMatch ? "PASS" : "FAIL",
      "BLOCKER",
      sourceMatch
        ? "Plan and manifest name matching exact source revisions and lock digests"
        : "Source reference or manifest selection differs from the plan",
      ["plan.json", "manifest.json"],
      "Lock declarations alone do not establish source relevance or current approval",
      base,
    ),
  );

  if (input.store && sourceMatch) {
    const errors: string[] = [];
    for (const ref of refs) {
      if (!exact(ref)) continue;
      try {
        const snapshot = await input.store.read(ref.artifactId, ref.revision);
        if (
          snapshot.digest !== ref.lockDigest ||
          snapshot.artifact.lifecycle.status !== "approved" ||
          snapshot.artifact.lifecycle.freshness !== "valid" ||
          snapshot.artifact.approval.status !== "approved"
        )
          errors.push(
            `${ref.artifactId}@${ref.revision}: lock or approval mismatch`,
          );
      } catch (error) {
        errors.push(`${ref.artifactId}@${ref.revision}: ${String(error)}`);
      }
    }
    findings.push(
      finding(
        "artifact-validity",
        errors.length ? "FAIL" : "PASS",
        "BLOCKER",
        errors.length
          ? errors.join("; ")
          : "All declared sources were read, schema-validated, fresh, approved, and exact-locked",
        refs.map((ref) => refKey(ref) ?? "invalid-ref"),
        "Approval of source artifacts does not approve the generated plan",
        base,
      ),
    );
    try {
      const compiled = await compileApprovedTokenAssets(
        input.store,
        plan!.tokenSources,
      );
      const tokensMatch =
        compiled.css.trim() &&
        bundle.css.startsWith(compiled.css) &&
        canonicalJson(manifest?.tokenProvenance) ===
          canonicalJson(
            compiled.tokens.map(({ path, source }) => ({ path, source })),
          ) &&
        [plan!.styleTokens.foreground, plan!.styleTokens.background]
          .filter(Boolean)
          .every((token) =>
            compiled.tokens.some(
              (item) => item.path === token && item.type === "color",
            ),
          );
      findings.push(
        finding(
          "token-resolution",
          tokensMatch ? "PASS" : "FAIL",
          "MAJOR",
          tokensMatch
            ? "Generated CSS includes compiled approved tokens and declared color paths resolve"
            : "Generated CSS or style token paths disagree with compiled approved sources",
          [
            "prototype.css",
            ...plan!.tokenSources.map((ref) => refKey(ref) ?? "invalid-ref"),
          ],
          "Checks compiled token values and paths, not visual suitability",
          base,
        ),
      );
    } catch (error) {
      findings.push(
        finding(
          "token-resolution",
          "FAIL",
          "MAJOR",
          String(error),
          ["prototype.css", "plan.json"],
          "Compiler could not resolve approved token sources",
          base,
        ),
      );
    }
  } else {
    for (const criterion of ["artifact-validity", "token-resolution"])
      findings.push(
        finding(
          criterion,
          "UNVERIFIED",
          "MAJOR",
          input.store ? "Source locks invalid" : "ArtifactStore not supplied",
          ["plan.json"],
          "Exact source validation requires a readable ArtifactStore",
          base,
        ),
      );
  }

  try {
    const result = await new HtmlValidate({
      extends: ["html-validate:recommended"],
      rules: {
        "doctype-style": ["error", { style: "lowercase" }],
        "void-style": ["error", { style: "selfclose" }],
      },
    }).validateString(bundle.html, "index.html");
    findings.push(
      finding(
        "html-lint",
        result.valid ? "PASS" : "FAIL",
        "MAJOR",
        result.valid
          ? "html-validate passed"
          : result.results
              .flatMap((r) =>
                r.messages.map((m) => `${m.ruleId}: ${m.message}`),
              )
              .join("; "),
        ["index.html"],
        "Static HTML rules only",
        base,
      ),
    );
  } catch (error) {
    findings.push(
      finding(
        "html-lint",
        "UNVERIFIED",
        "MAJOR",
        String(error),
        ["index.html"],
        "html-validate did not complete",
        base,
      ),
    );
  }
  try {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          languageOptions: { globals: { document: "readonly" } },
          rules: { "no-undef": "error", "no-unused-vars": "error" },
        },
      ],
    });
    const [result] = await eslint.lintText(bundle.js, {
      filePath: "prototype.js",
    });
    findings.push(
      finding(
        "javascript-lint",
        result && result.errorCount === 0 ? "PASS" : "FAIL",
        "MAJOR",
        result?.messages.map((m) => `${m.ruleId}: ${m.message}`).join("; ") ||
          "ESLint passed",
        ["prototype.js"],
        "Lint cannot establish runtime behavior",
        base,
      ),
    );
  } catch (error) {
    findings.push(
      finding(
        "javascript-lint",
        "UNVERIFIED",
        "MAJOR",
        String(error),
        ["prototype.js"],
        "ESLint did not complete",
        base,
      ),
    );
  }
  try {
    const result = await stylelint.lint({
      code: bundle.css,
      codeFilename: "prototype.css",
      config: {
        rules: {
          "block-no-empty": true,
          "color-no-invalid-hex": true,
          "declaration-block-no-duplicate-properties": true,
        },
      },
    });
    findings.push(
      finding(
        "css-lint",
        result.errored ? "FAIL" : "PASS",
        "MAJOR",
        result.errored
          ? result.results
              .flatMap((r) => r.warnings.map((w) => `${w.rule}: ${w.text}`))
              .join("; ")
          : "Stylelint passed",
        ["prototype.css"],
        "Lint cannot establish rendered layout",
        base,
      ),
    );
  } catch (error) {
    findings.push(
      finding(
        "css-lint",
        "UNVERIFIED",
        "MAJOR",
        String(error),
        ["prototype.css"],
        "Stylelint did not complete",
        base,
      ),
    );
  }

  const contract = input.uiContract;
  if (!contract)
    findings.push(
      finding(
        "ui-contract-consistency",
        "UNVERIFIED",
        "MAJOR",
        "No exact Product UI Contract supplied",
        [],
        "Terminology, entity context and navigation need an exact contract and human review",
        base,
      ),
    );
  else if (!input.store || !exact(contract))
    findings.push(
      finding(
        "ui-contract-consistency",
        "UNVERIFIED",
        "MAJOR",
        "Exact Contract or ArtifactStore unavailable",
        [],
        "No semantic Contract check was possible",
        base,
      ),
    );
  else {
    try {
      const snapshot = await input.store.read(
        contract.artifactId,
        contract.revision,
      );
      const valid =
        snapshot.digest === contract.lockDigest &&
        snapshot.artifact.meta.type === "product-ui-contract" &&
        snapshot.artifact.lifecycle.status === "approved" &&
        snapshot.artifact.lifecycle.freshness === "valid" &&
        snapshot.artifact.approval.status === "approved";
      const scenario =
        plan &&
        (await input.store.read(
          plan.scenario.artifactId,
          plan.scenario.revision,
        ));
      const linked = scenario?.artifact.dependencies.some(
        (ref) => refKey(ref) === refKey(contract),
      );
      findings.push(
        finding(
          "ui-contract-consistency",
          valid && linked ? "CONCERN" : "FAIL",
          "MAJOR",
          !valid
            ? "Product UI Contract lock, type or approval mismatched"
            : !linked
              ? "Scenario does not depend on the exact supplied Product UI Contract"
              : "Exact approved Contract is linked; semantic navigation, terminology and entity-context consistency still require review",
          [refKey(contract)!],
          "No inferred semantic match is claimed from schema or string presence",
          base,
        ),
      );
    } catch (error) {
      findings.push(
        finding(
          "ui-contract-consistency",
          "UNVERIFIED",
          "MAJOR",
          String(error),
          [refKey(contract)!],
          "Contract read failed",
          base,
        ),
      );
    }
  }
  return {
    bundle,
    report: {
      target,
      findings,
      inspectedAt: new Date().toISOString(),
      action: "inspect-only",
    },
  };
}
