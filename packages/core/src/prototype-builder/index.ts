import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact-store.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import { compileApprovedTokenAssets } from "../token-compiler/index.js";

/** This authored render plan is a generation input, not a canonical artifact or an approval. */
export type PrototypeState =
  | "loading"
  | "empty"
  | "partial"
  | "success"
  | "error"
  | "permission"
  | "disabled";
export type PrototypeTag =
  | "main"
  | "section"
  | "article"
  | "header"
  | "nav"
  | "h1"
  | "h2"
  | "h3"
  | "p"
  | "ul"
  | "li"
  | "span"
  | "strong"
  | "button"
  | "a";
export interface PrototypeNode {
  readonly tag: PrototypeTag;
  readonly id?: string;
  readonly componentId?: string;
  readonly text?: string;
  readonly fixtureKey?: string;
  readonly href?: string;
  readonly targetState?: PrototypeState;
  readonly children?: readonly PrototypeNode[];
}
export interface PrototypeStatePlan {
  readonly name: PrototypeState;
  readonly root: PrototypeNode;
}
export interface PrototypeBuilderInput {
  readonly scenario: ExactArtifactRef;
  readonly selection: {
    readonly pattern: ExactArtifactRef;
    readonly layout: ExactArtifactRef;
    readonly components: readonly ExactArtifactRef[];
    readonly responsiveRule: ExactArtifactRef;
    readonly accessibilityRule: ExactArtifactRef;
  };
  readonly tokenSources: readonly ExactArtifactRef[];
  readonly title: string;
  readonly initialState: PrototypeState;
  readonly requiredStates: readonly PrototypeState[];
  readonly states: readonly PrototypeStatePlan[];
  readonly fixtures: Readonly<
    Partial<Record<PrototypeState, Readonly<Record<string, string>>>>
  >;
  /** Explicit narrow layout treatment; dimensions are backed by the locked responsive rule. */
  readonly layout: {
    readonly breakpointPx: number;
    readonly desktopColumns: number;
    readonly mobileColumns: number;
  };
  readonly styleTokens: {
    readonly foreground: string;
    readonly background?: string;
  };
  readonly outputPath: string;
}
export interface PrototypeBuildResult {
  readonly directory: string;
  readonly planDigest: string;
  readonly files: readonly string[];
}
export class PrototypeBuilderError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "INTEGRITY"
      | "UNAPPROVED"
      | "UPSTREAM_REVISION_REQUIRED"
      | "PATH",
    message: string,
    readonly upstreamRevisionRequest?: string,
  ) {
    super(message);
    this.name = "PrototypeBuilderError";
  }
}
const STATES: readonly PrototypeState[] = [
  "loading",
  "empty",
  "partial",
  "success",
  "error",
  "permission",
  "disabled",
];
const TAGS: readonly PrototypeTag[] = [
  "main",
  "section",
  "article",
  "header",
  "nav",
  "h1",
  "h2",
  "h3",
  "p",
  "ul",
  "li",
  "span",
  "strong",
  "button",
  "a",
];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const REF_ID = /^art_[A-Za-z0-9_-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function fail(code: PrototypeBuilderError["code"], message: string): never {
  throw new PrototypeBuilderError(code, message);
}
function revision(message: string): never {
  throw new PrototypeBuilderError(
    "UPSTREAM_REVISION_REQUIRED",
    message,
    message,
  );
}
function refCopy(ref: ExactArtifactRef): ExactArtifactRef {
  if (
    !ref ||
    typeof ref !== "object" ||
    !REF_ID.test(ref.artifactId) ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision < 1 ||
    !DIGEST.test(ref.lockDigest)
  )
    fail("INVALID", "Invalid exact artifact reference");
  return Object.freeze({
    artifactId: ref.artifactId,
    revision: ref.revision,
    lockDigest: ref.lockDigest,
  });
}
function same(a: ExactArtifactRef, b: ExactArtifactRef): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.revision === b.revision &&
    a.lockDigest === b.lockDigest
  );
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function assertText(value: unknown, at: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })
  )
    fail("INVALID", `${at} must be nonempty safe text`);
}
function assertKeys(value: object, keys: readonly string[], at: string): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail("INVALID", `${at}: unsupported field ${key}`);
}
function content(asset: ArtifactSnapshot): {
  assetKind: string;
  definition: unknown;
} {
  if (
    asset.meta.type !== "design-system-asset" ||
    !asset.content ||
    typeof asset.content !== "object" ||
    Array.isArray(asset.content)
  )
    fail("INVALID", `Not a Design System asset: ${asset.meta.id}`);
  return asset.content as { assetKind: string; definition: unknown };
}
function requireApproved(artifact: ArtifactSnapshot): void {
  if (
    artifact.lifecycle.status !== "approved" ||
    artifact.lifecycle.freshness !== "valid" ||
    artifact.approval.status !== "approved"
  )
    fail(
      "UNAPPROVED",
      `Required input is not fresh and approved: ${artifact.meta.id}`,
    );
}
async function exactRead(
  store: ArtifactStore,
  ref: ExactArtifactRef,
): Promise<ArtifactSnapshot> {
  const snapshot = await store.read(ref.artifactId, ref.revision);
  if (snapshot.digest !== ref.lockDigest)
    fail("INTEGRITY", `Exact lock mismatch: ${ref.artifactId}@${ref.revision}`);
  requireApproved(snapshot.artifact);
  return snapshot.artifact;
}
function validatePlan(plan: PrototypeBuilderInput): void {
  assertKeys(
    plan,
    [
      "scenario",
      "selection",
      "tokenSources",
      "title",
      "initialState",
      "requiredStates",
      "states",
      "fixtures",
      "layout",
      "styleTokens",
      "outputPath",
    ],
    "plan",
  );
  if (
    !plan.selection ||
    typeof plan.selection !== "object" ||
    !Array.isArray(plan.selection.components)
  )
    revision(
      "Supply exact selected pattern, layout, component and rule references",
    );
  assertKeys(
    plan.selection,
    ["pattern", "layout", "components", "responsiveRule", "accessibilityRule"],
    "selection",
  );
  if (!Array.isArray(plan.tokenSources) || !plan.tokenSources.length)
    revision("Supply at least one approved exact token source");
  assertText(plan.title, "title");
  if (!STATES.includes(plan.initialState))
    fail("INVALID", "Unsupported initial state");
  if (
    !Array.isArray(plan.requiredStates) ||
    !plan.requiredStates.length ||
    !plan.requiredStates.includes("success") ||
    new Set(plan.requiredStates).size !== plan.requiredStates.length ||
    plan.requiredStates.some((state) => !STATES.includes(state))
  )
    revision("Declare a unique supported required-state set including success");
  if (
    !Array.isArray(plan.states) ||
    plan.states.length !== plan.requiredStates.length ||
    new Set(plan.states.map((state) => state.name)).size !==
      plan.states.length ||
    plan.states.some((state) => !plan.requiredStates.includes(state.name))
  )
    revision("Author one semantic DOM tree for each required UI state");
  if (!plan.requiredStates.includes(plan.initialState))
    fail("INVALID", "Initial state is not rendered");
  if (!plan.layout || typeof plan.layout !== "object")
    revision(
      "Supply explicit desktop/mobile layout decisions linked to the responsive rule",
    );
  assertKeys(
    plan.layout,
    ["breakpointPx", "desktopColumns", "mobileColumns"],
    "layout",
  );
  const { breakpointPx, desktopColumns, mobileColumns } = plan.layout;
  if (
    !Number.isSafeInteger(breakpointPx) ||
    breakpointPx < 320 ||
    breakpointPx > 1600 ||
    !Number.isSafeInteger(desktopColumns) ||
    desktopColumns < 1 ||
    desktopColumns > 6 ||
    !Number.isSafeInteger(mobileColumns) ||
    mobileColumns < 1 ||
    mobileColumns > 3
  )
    revision(
      "Supply bounded desktop/mobile columns and breakpoint in the render plan",
    );
  if (!plan.styleTokens || typeof plan.styleTokens !== "object")
    revision("Bind approved color token paths for prototype styling");
  assertKeys(plan.styleTokens, ["foreground", "background"], "styleTokens");
  assertText(plan.styleTokens.foreground, "styleTokens.foreground");
  if (plan.styleTokens.background !== undefined)
    assertText(plan.styleTokens.background, "styleTokens.background");
  if (
    !plan.fixtures ||
    typeof plan.fixtures !== "object" ||
    Array.isArray(plan.fixtures)
  )
    fail("INVALID", "Synthetic fixture map required");
  for (const state of plan.states) {
    assertKeys(state, ["name", "root"], `state ${state.name}`);
    if (
      !plan.fixtures[state.name as PrototypeState] ||
      typeof plan.fixtures[state.name as PrototypeState] !== "object"
    )
      revision(`Supply synthetic fixture values for ${state.name}`);
    for (const [key, value] of Object.entries(
      plan.fixtures[state.name as PrototypeState]!,
    )) {
      if (!ID.test(key)) fail("INVALID", `Unsafe fixture key: ${key}`);
      assertText(value, `fixture ${state.name}.${key}`);
    }
  }
}
function renderNode(
  node: PrototypeNode,
  state: PrototypeState,
  fixtures: PrototypeBuilderInput["fixtures"],
  componentIds: Set<string>,
  ids: Set<string>,
  depth: number,
  budget: { count: number },
): string {
  if (
    !node ||
    typeof node !== "object" ||
    Array.isArray(node) ||
    depth > 16 ||
    ++budget.count > 1000
  )
    revision(
      "Author a bounded semantic DOM tree (at most 1000 nodes and 16 levels)",
    );
  assertKeys(
    node,
    [
      "tag",
      "id",
      "componentId",
      "text",
      "fixtureKey",
      "href",
      "targetState",
      "children",
    ],
    "node",
  );
  if (!TAGS.includes(node.tag))
    revision(`Unsupported semantic element: ${String(node.tag)}`);
  if (node.id !== undefined) {
    if (!ID.test(node.id) || ids.has(node.id))
      fail("INVALID", `Unsafe or duplicate DOM id: ${node.id}`);
    ids.add(node.id);
  }
  if (node.componentId !== undefined && !componentIds.has(node.componentId))
    revision(`Component ${node.componentId} is not an exact selected asset`);
  if (node.tag === "button" && !node.componentId)
    revision("Every button needs an exact selected component binding");
  if (node.text !== undefined && node.fixtureKey !== undefined)
    fail("INVALID", "Node cannot combine text and fixtureKey");
  if (node.text !== undefined) assertText(node.text, "node text");
  let value = node.text;
  if (node.fixtureKey !== undefined) {
    if (
      !ID.test(node.fixtureKey) ||
      !Object.hasOwn(fixtures[state]!, node.fixtureKey)
    )
      revision(`Missing synthetic fixture ${state}.${node.fixtureKey}`);
    value = fixtures[state]![node.fixtureKey];
  }
  if (
    node.targetState !== undefined &&
    (node.tag !== "button" || !STATES.includes(node.targetState))
  )
    fail("INVALID", "Only buttons may use supported state transitions");
  if (
    node.href !== undefined &&
    (node.tag !== "a" || !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(node.href))
  )
    fail("INVALID", "Only local fragment URLs are allowed");
  if (node.tag === "a" && !node.href)
    revision("Link needs a local fragment target");
  if (node.tag === "button" && !node.targetState)
    revision("Button needs a declared state transition");
  if (
    node.targetState !== undefined &&
    !Object.hasOwn(fixtures, node.targetState)
  )
    revision(`Missing transition target state ${node.targetState}`);
  if (node.children !== undefined && !Array.isArray(node.children))
    fail("INVALID", "children must be an array");
  if (
    (node.tag === "button" || node.tag === "a" || /^h[123]$/.test(node.tag)) &&
    !value &&
    !node.children?.length
  )
    revision(`${node.tag} needs a discernible label`);
  const attrs = `${node.id ? ` id="${node.id}"` : ""}${node.componentId ? ` data-component="${escapeHtml(node.componentId)}"` : ""}${node.href ? ` href="${node.href}"` : ""}${node.targetState ? ` type="button" data-target-state="${node.targetState}"` : ""}`;
  const children =
    node.children
      ?.map((child) =>
        renderNode(
          child,
          state,
          fixtures,
          componentIds,
          ids,
          depth + 1,
          budget,
        ),
      )
      .join("") ?? "";
  return `<${node.tag}${attrs}>${value ? escapeHtml(value) : ""}${children}</${node.tag}>`;
}
async function outputDirectory(
  root: string,
  relative: string,
): Promise<string> {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    relative.includes("\\")
  )
    fail("PATH", "Output path must be a contained relative directory");
  const base = await realpath(root);
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail(
          "PATH",
          `Output path contains a symlink or non-directory: ${segment}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  if (path.relative(base, await realpath(current)).startsWith(".."))
    fail("PATH", "Output escapes root");
  return current;
}
/** Compile a reviewable, deterministic specification prototype from explicit composition input. */
export async function buildPrototype(
  store: ArtifactStore,
  supplied: PrototypeBuilderInput,
  outputRoot: string,
): Promise<PrototypeBuildResult> {
  // JSON copy freezes the caller's intent before any asynchronous read; canonicalJson rejects non-JSON inputs.
  const plan = jsonCopy(
    supplied as unknown as JsonValue,
  ) as unknown as PrototypeBuilderInput;
  validatePlan(plan);
  const scenarioRef = refCopy(plan.scenario);
  const selection = [
    ["pattern", refCopy(plan.selection.pattern)],
    ["layout", refCopy(plan.selection.layout)],
    ...plan.selection.components.map(
      (ref) => ["component", refCopy(ref)] as const,
    ),
    ["responsive-rule", refCopy(plan.selection.responsiveRule)],
    ["accessibility-rule", refCopy(plan.selection.accessibilityRule)],
  ] as const;
  if (!plan.selection.components.length)
    revision("Select at least one exact component dependency");
  const tokenRefs = plan.tokenSources.map(refCopy);
  const scenario = await exactRead(store, scenarioRef);
  if (
    scenario.meta.type !== "scenario" ||
    scenario.meta.schemaVersion !== "1.0.0"
  )
    fail("INVALID", "Source is not a canonical v1 scenario");
  const rationale = scenario.provenance.some(
    (entry) =>
      entry.path.startsWith("/content") &&
      typeof entry.rationale === "string" &&
      /Task\s*→.*pattern\s*→.*layout\s*→.*component/i.test(entry.rationale) &&
      selection.every(
        ([, ref]) =>
          Array.isArray(entry.inputRefs) &&
          entry.inputRefs.includes(`${ref.artifactId}@${ref.revision}`),
      ),
  );
  if (!rationale)
    revision(
      "Revise scenario provenance with linked Task → Pattern → Layout → Components rationale",
    );
  for (const [kind, ref] of selection) {
    if (!scenario.dependencies.some((dependency) => same(dependency, ref)))
      revision(
        `Add exact selected ${kind} ${ref.artifactId}@${ref.revision} to scenario dependencies`,
      );
    const asset = await exactRead(store, ref);
    if (content(asset).assetKind !== kind)
      revision(
        `Selected ${ref.artifactId}@${ref.revision} must be a ${kind} asset`,
      );
    if (kind === "responsive-rule") {
      const definition = content(asset).definition as Record<string, unknown>;
      for (const key of [
        "breakpointPx",
        "desktopColumns",
        "mobileColumns",
      ] as const)
        if (definition?.[key] !== plan.layout[key])
          revision(
            `Render-plan ${key} must match locked responsive rule ${ref.artifactId}@${ref.revision}`,
          );
    }
  }
  for (const ref of tokenRefs)
    if (!scenario.dependencies.some((dependency) => same(dependency, ref)))
      revision(
        `Add exact token source ${ref.artifactId}@${ref.revision} to scenario dependencies`,
      );
  const compiled = await compileApprovedTokenAssets(store, tokenRefs);
  const colorTokens = [
    plan.styleTokens.foreground,
    plan.styleTokens.background,
  ].filter((value): value is string => Boolean(value));
  for (const tokenPath of colorTokens)
    if (
      !compiled.tokens.some(
        (token) => token.path === tokenPath && token.type === "color",
      )
    )
      revision(`Bind an approved compiled color token: ${tokenPath}`);
  const componentIds = new Set(
    plan.selection.components.map((ref) => ref.artifactId),
  );
  const ids = new Set<string>();
  const budget = { count: 0 };
  const sections = plan.states.map((state) => {
    if (state.root.tag !== "main")
      revision(`State ${state.name} must begin with a main landmark`);
    const rendered = renderNode(
      state.root,
      state.name,
      plan.fixtures,
      componentIds,
      ids,
      0,
      budget,
    );
    return `<div data-state="${state.name}"${state.name === plan.initialState ? "" : " hidden"}>${rendered}</div>`;
  });
  const referencedFragments = [
    ...sections.join("").matchAll(/ href="#([A-Za-z][A-Za-z0-9_-]*)"/g),
  ].map((match) => match[1]!);
  for (const fragment of referencedFragments)
    if (!ids.has(fragment)) revision(`Fragment target ${fragment} is absent`);
  const planDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(plan as unknown as JsonValue))
    .digest("hex")}`;
  const manifest = {
    kind: "mimic-prototype-specification",
    productionReady: false,
    fixtures: "synthetic",
    scenario: scenarioRef,
    selectedAssets: selection.map(([kind, ref]) => ({ kind, ...ref })),
    tokenSources: compiled.sources,
    tokenProvenance: compiled.tokens.map(({ path: tokenPath, source }) => ({
      path: tokenPath,
      source,
    })),
    planDigest,
    requiredStates: plan.requiredStates,
  };
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(plan.title)}</title><link rel="stylesheet" href="prototype.css"><script type="module" src="prototype.js"></script></head><body><header><p>Specification prototype · synthetic fixture data · not a production app</p><h1>${escapeHtml(plan.title)}</h1></header>${sections.join("")}<p role="status" aria-live="polite" id="prototype-status">${escapeHtml(plan.initialState)} state</p></body></html>\n`;
  const css = `${compiled.css}\nbody { color: var(--mimic-${plan.styleTokens.foreground.replaceAll(".", "-")});${plan.styleTokens.background ? ` background: var(--mimic-${plan.styleTokens.background.replaceAll(".", "-")});` : ""} }\n[data-state][hidden] { display: none !important; }\n[data-state] main { display: grid; grid-template-columns: repeat(${plan.layout.desktopColumns}, minmax(0, 1fr)); gap: 1rem; }\n:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }\n@media (max-width: ${plan.layout.breakpointPx}px) { [data-state] main { grid-template-columns: repeat(${plan.layout.mobileColumns}, minmax(0, 1fr)); } }\n`;
  const js = `const allowed = new Set(${JSON.stringify(plan.requiredStates)});\nfunction show(state) {\n  if (!allowed.has(state)) return;\n  for (const section of document.querySelectorAll('[data-state]')) section.hidden = section.getAttribute('data-state') !== state;\n  document.getElementById('prototype-status').textContent = state + ' state';\n}\ndocument.addEventListener('click', (event) => {\n  const button = event.target.closest('button[data-target-state]');\n  if (button) show(button.getAttribute('data-target-state'));\n});\n`;
  const files = {
    "index.html": html,
    "prototype.css": css,
    "prototype.js": js,
    "manifest.json": `${canonicalJson(manifest as unknown as JsonValue)}\n`,
    "plan.json": `${canonicalJson(plan as unknown as JsonValue)}\n`,
  };
  const directory = await outputDirectory(outputRoot, plan.outputPath);
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(directory, name);
    try {
      await lstat(destination);
      fail("PATH", `Output file already exists: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(destination, contents, { flag: "wx" });
  }
  return Object.freeze({
    directory,
    planDigest,
    files: Object.freeze(Object.keys(files)),
  });
}
