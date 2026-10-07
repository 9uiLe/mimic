import { createHash } from "node:crypto";
import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact-store.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import { compileApprovedTokenAssets } from "../token-compiler/index.js";
import { PrototypeOutputError, publishPrototypeBundle } from "./output.js";
import { responsiveErrors, type ResponsivePlan } from "./responsive.js";
import { responsiveRuntime, stateFocusRuntime } from "./runtime.js";
export type {
  ResponsivePlan,
  ResponsiveStatePlan,
  ResponsiveOperation,
  ResponsiveIdentity,
} from "./responsive.js";

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
  | "a"
  | "input";
export interface PrototypeNode {
  readonly tag: PrototypeTag;
  readonly id?: string;
  readonly componentId?: string;
  readonly text?: string;
  readonly fixtureKey?: string;
  readonly href?: string;
  readonly targetState?: PrototypeState;
  /** Journey-only, labeled text control; absent in legacy plans. */
  readonly inputKind?: "text" | "search";
  readonly ariaLabel?: string;
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
  /** Optional versioned, authored mobile operation program. Legacy plans omit it. */
  readonly responsive?: ResponsivePlan;
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
  "input",
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
      "responsive",
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
export interface PrototypeCompileOptions {
  readonly journeyControls?: ReadonlySet<string>;
  readonly journeyInputs?: ReadonlySet<string>;
}

function renderNode(
  node: PrototypeNode,
  state: PrototypeState,
  fixtures: PrototypeBuilderInput["fixtures"],
  renderedStates: ReadonlySet<PrototypeState>,
  componentIds: Set<string>,
  ids: Set<string>,
  depth: number,
  budget: { count: number },
  interactiveAncestor: boolean,
  options: PrototypeCompileOptions,
): { html: string; hasText: boolean } {
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
      "inputKind",
      "ariaLabel",
      "children",
    ],
    "node",
  );
  if (
    !TAGS.includes(node.tag) ||
    (node.tag === "input" && !options.journeyInputs)
  )
    revision(`Unsupported semantic element: ${String(node.tag)}`);
  const interactive =
    node.tag === "button" || node.tag === "a" || node.tag === "input";
  if (interactiveAncestor && interactive)
    revision("Nested interactive controls are unsupported");
  if (node.id !== undefined) {
    if (typeof node.id !== "string" || !ID.test(node.id) || ids.has(node.id))
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
    if (typeof node.fixtureKey !== "string" || !ID.test(node.fixtureKey))
      fail("INVALID", "Fixture key must be a safe string");
    if (!Object.hasOwn(fixtures[state]!, node.fixtureKey))
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
    (node.tag !== "a" ||
      typeof node.href !== "string" ||
      !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(node.href))
  )
    fail("INVALID", "Only local fragment URLs are allowed");
  if (node.tag === "a" && !node.href)
    revision("Link needs a local fragment target");
  if (
    node.tag === "button" &&
    !node.targetState &&
    !options.journeyControls?.has(node.id ?? "")
  )
    revision("Button needs a declared state transition");
  if (node.tag === "input") {
    if (
      !node.id ||
      !options.journeyInputs?.has(node.id) ||
      !["text", "search"].includes(node.inputKind ?? "") ||
      !node.ariaLabel ||
      node.children?.length ||
      node.text !== undefined ||
      node.fixtureKey !== undefined ||
      node.targetState !== undefined ||
      node.href !== undefined
    )
      fail(
        "INVALID",
        "Journey input requires an ID, supported kind, and accessible label",
      );
    assertText(node.ariaLabel, "input ariaLabel");
  } else if (node.inputKind !== undefined || node.ariaLabel !== undefined)
    fail("INVALID", "Input attributes require an input node");
  if (node.targetState !== undefined && !renderedStates.has(node.targetState))
    revision(`Missing transition target state ${node.targetState}`);
  if (node.children !== undefined && !Array.isArray(node.children))
    fail("INVALID", "children must be an array");
  const attrs = `${node.id ? ` id="${node.id}"` : ""}${node.componentId ? ` data-component="${escapeHtml(node.componentId)}"` : ""}${node.href ? ` href="${node.href}"` : ""}${node.targetState ? ` type="button" data-target-state="${node.targetState}"` : options.journeyControls?.has(node.id ?? "") ? ` type="button"` : ""}`;
  if (node.tag === "input")
    return {
      html: `<input${attrs} type="${node.inputKind}" aria-label="${escapeHtml(node.ariaLabel!)}"/>`,
      hasText: false,
    };
  const renderedChildren =
    node.children?.map((child) =>
      renderNode(
        child,
        state,
        fixtures,
        renderedStates,
        componentIds,
        ids,
        depth + 1,
        budget,
        interactiveAncestor || interactive,
        options,
      ),
    ) ?? [];
  const hasText =
    Boolean(value?.trim()) || renderedChildren.some((child) => child.hasText);
  if ((interactive || /^h[123]$/.test(node.tag)) && !hasText)
    revision(`${node.tag} needs a discernible text label`);
  const children = renderedChildren.map((child) => child.html).join("");
  // The document owns one main landmark; authored state roots stay as view containers.
  const tag = node.tag === "main" ? "div" : node.tag;
  return {
    html: `<${tag}${attrs}>${value ? escapeHtml(value) : ""}${children}</${tag}>`,
    hasText,
  };
}
function linksExactCompositionRef(
  entry: ArtifactSnapshot["provenance"][number],
  ref: ExactArtifactRef,
): boolean {
  if (!Array.isArray(entry.inputRefs)) return false;
  const identity = `${ref.artifactId}@${ref.revision}`;
  const matching = entry.inputRefs.filter(
    (value) =>
      typeof value === "string" &&
      (value === identity || value.startsWith(`${identity}#`)),
  );
  return (
    matching.length > 0 &&
    matching.every(
      (value) =>
        value === identity || value === `${identity}#${ref.lockDigest}`,
    )
  );
}
/** Compile a reviewable, deterministic specification prototype from explicit composition input. */
export interface CompiledPrototypeBundle {
  readonly plan: PrototypeBuilderInput;
  readonly planDigest: string;
  readonly files: Readonly<Record<string, string>>;
  readonly sections: readonly string[];
  readonly css: string;
  readonly responsiveProgram:
    | readonly {
        readonly state: string;
        readonly operations: readonly unknown[];
      }[]
    | undefined;
  readonly tokenCss: string;
}

/** Compile without publishing so journey views reuse the same validator and renderer. */
export async function compilePrototypeBundle(
  store: ArtifactStore,
  supplied: PrototypeBuilderInput,
  options: PrototypeCompileOptions = {},
): Promise<CompiledPrototypeBundle> {
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
  const compositionRefs = selection
    .filter(
      ([kind]) =>
        kind === "pattern" || kind === "layout" || kind === "component",
    )
    .map(([, ref]) => ref);
  const rationale = scenario.provenance.some(
    (entry) =>
      entry.path.startsWith("/content") &&
      entry.kind === "derived" &&
      typeof entry.rationale === "string" &&
      Boolean(entry.rationale.trim()) &&
      compositionRefs.every((ref) => linksExactCompositionRef(entry, ref)),
  );
  if (!rationale)
    revision(
      "Revise scenario provenance with exact selected pattern, layout and component links plus composition rationale",
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
  const ids = new Set<string>(["prototype-status"]);
  const renderedStates = new Set(plan.requiredStates);
  const budget = { count: 0 };
  const sections = plan.states.map((state) => {
    if (state.root.tag !== "main")
      revision(`State ${state.name} must begin with a main landmark`);
    const rendered = renderNode(
      state.root,
      state.name,
      plan.fixtures,
      renderedStates,
      componentIds,
      ids,
      0,
      budget,
      false,
      options,
    );
    return `<div data-state="${state.name}"${state.name === plan.initialState ? "" : " hidden"}>${rendered.html}</div>`;
  });
  const referencedFragments = [
    ...sections.join("").matchAll(/ href="#([A-Za-z][A-Za-z0-9_-]*)"/g),
  ].map((match) => match[1]!);
  for (const fragment of referencedFragments)
    if (!ids.has(fragment)) revision(`Fragment target ${fragment} is absent`);
  const responsiveProblems = responsiveErrors(
    plan,
    options.journeyControls,
    options.journeyInputs,
  );
  if (responsiveProblems.length)
    fail(
      "INVALID",
      `Invalid responsive plan: ${responsiveProblems.join("; ")}`,
    );
  const responsiveProgram = plan.responsive?.states.map((entry) => ({
    state: entry.state,
    operations: entry.operations.map((operation) => {
      if (operation.kind !== "replace") return operation;
      const replacement = renderNode(
        operation.with,
        entry.state,
        plan.fixtures,
        renderedStates,
        componentIds,
        ids,
        0,
        budget,
        false,
        options,
      );
      return { ...operation, html: replacement.html };
    }),
  }));
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
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(plan.title)}</title><link rel="stylesheet" href="prototype.css"/><script type="module" src="prototype.js"></script></head><body><header><p>Specification prototype · synthetic fixture data · not a production app</p><h1>${escapeHtml(plan.title)}</h1></header><main>${sections.join("")}</main><p role="status" aria-live="polite" id="prototype-status">${escapeHtml(plan.initialState)} state</p></body></html>\n`;
  const css = `${compiled.css}\nbody { color: var(--mimic-${plan.styleTokens.foreground.replaceAll(".", "-")});${plan.styleTokens.background ? ` background: var(--mimic-${plan.styleTokens.background.replaceAll(".", "-")});` : ""} }\n[data-state][hidden] { display: none !important; }\n[data-state] > div { display: grid; grid-template-columns: repeat(${plan.layout.desktopColumns}, minmax(0, 1fr)); gap: 1rem; }\n:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }\n@media (max-width: ${plan.layout.breakpointPx}px) { [data-state] > div { grid-template-columns: repeat(${plan.layout.mobileColumns}, minmax(0, 1fr)); } }\n${plan.responsive ? "[data-responsive-details] { min-width: 0; }\n[data-responsive-details] > summary { cursor: pointer; }\n" : ""}`;
  const js = `const allowed = new Set(${JSON.stringify(plan.requiredStates)});\nfunction show(state) {\n  if (!allowed.has(state)) return;\n  for (const section of document.querySelectorAll('[data-state]')) section.hidden = section.getAttribute('data-state') !== state;\n  document.getElementById('prototype-status').textContent = state + ' state';\n  focusAfterStateChange(state);\n}\ndocument.addEventListener('click', (event) => {\n  const button = event.target.closest('button[data-target-state]');\n  if (button) show(button.getAttribute('data-target-state'));\n});\n${stateFocusRuntime()}${responsiveProgram ? responsiveRuntime(responsiveProgram, plan.layout.breakpointPx) : ""}`;
  const files = {
    "index.html": html,
    "prototype.css": css,
    "prototype.js": js,
    "manifest.json": `${canonicalJson(manifest as unknown as JsonValue)}\n`,
    "plan.json": `${canonicalJson(plan as unknown as JsonValue)}\n`,
  };
  return {
    plan,
    planDigest,
    files,
    sections,
    css,
    responsiveProgram,
    tokenCss: compiled.css,
  };
}

/** Publish the legacy single-view bundle without changing its saved bytes. */
export async function buildPrototype(
  store: ArtifactStore,
  supplied: PrototypeBuilderInput,
  outputRoot: string,
): Promise<PrototypeBuildResult> {
  const built = await compilePrototypeBundle(store, supplied);
  let directory: string;
  try {
    directory = await publishPrototypeBundle(
      outputRoot,
      built.plan.outputPath,
      built.files,
    );
  } catch (error) {
    if (error instanceof PrototypeOutputError) fail("PATH", error.message);
    throw error;
  }
  return Object.freeze({
    directory,
    planDigest: built.planDigest,
    files: Object.freeze(Object.keys(built.files)),
  });
}
