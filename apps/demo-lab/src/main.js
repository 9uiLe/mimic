const fields = ["project", "domain", "direction", "scenario"];
const selects = Object.fromEntries(
  fields.map((name) => [name, document.getElementById(name)]),
);
let frame = document.getElementById("prototype-frame");
const deviceFrame = document.getElementById("device-frame");
const message = document.getElementById("preview-message");
const summary = document.getElementById("selection-summary");
const notice = document.getElementById("mode-notice");
const provenance = document.getElementById("provenance-list");
const standalone = document.getElementById("standalone-link");
const status = document.getElementById("status");
const size = document.getElementById("surface-size");
let entries = [];
let active = {
  project: "",
  domain: "",
  direction: "",
  scenario: "",
  viewport: "desktop",
  mode: "current",
};
let previewState = "loading";
let requestNumber = 0;

function uniqueOptions(items, field) {
  return [
    ...new Map(items.map((item) => [item[field].id, item[field]])).values(),
  ];
}

function optionsFor(field) {
  if (field === "project") return uniqueOptions(entries, field);
  if (field === "domain")
    return uniqueOptions(
      entries.filter((item) => item.project.id === active.project),
      field,
    );
  if (field === "direction")
    return uniqueOptions(
      entries.filter(
        (item) =>
          item.project.id === active.project &&
          item.domain.id === active.domain,
      ),
      field,
    );
  return entries
    .filter(
      (item) =>
        item.project.id === active.project &&
        item.domain.id === active.domain &&
        item.direction.id === active.direction,
    )
    .map((item) => ({ id: item.id, label: item.scenario.label }));
}

function reconcileSelectors() {
  for (const field of fields) {
    const choices = optionsFor(field);
    if (!choices.some((choice) => choice.id === active[field]))
      active[field] = choices[0]?.id ?? "";
    const select = selects[field];
    select.replaceChildren(
      ...choices.map((choice) =>
        Object.assign(document.createElement("option"), {
          textContent: choice.label,
          value: choice.id,
        }),
      ),
    );
    select.value = active[field];
    select.disabled = choices.length === 0;
  }
}

function readLocation() {
  const params = new globalThis.URLSearchParams(globalThis.location.search);
  for (const field of fields) active[field] = params.get(field) ?? "";
  active.viewport = ["desktop", "mobile"].includes(params.get("viewport"))
    ? params.get("viewport")
    : globalThis.matchMedia("(max-width: 600px)").matches
      ? "mobile"
      : "desktop";
  active.mode = params.get("mode") === "proposed" ? "proposed" : "current";
  reconcileSelectors();
}

function writeLocation(replace = false) {
  const params = new globalThis.URLSearchParams();
  for (const field of fields) params.set(field, active[field]);
  params.set("viewport", active.viewport);
  params.set("mode", active.mode);
  globalThis.history[replace ? "replaceState" : "pushState"](
    null,
    "",
    `${globalThis.location.pathname}?${params}`,
  );
}

function updateButtons() {
  for (const button of document.querySelectorAll("[data-viewport]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.viewport === active.viewport),
    );
  for (const button of document.querySelectorAll("[data-mode]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === active.mode),
    );
  deviceFrame.className = `device-frame ${active.viewport}`;
  size.textContent =
    active.viewport === "mobile" ? "390px canvas" : "880px canvas";
}

function showMessage(text, kind = "loading") {
  message.textContent = text;
  message.dataset.kind = kind;
  message.hidden = false;
}

function showNotice(text, tone) {
  notice.textContent = text;
  notice.dataset.tone = tone;
  notice.hidden = !text;
}

function exact(ref) {
  return `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`;
}

function addProvenance(label, value) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  provenance.append(row);
}

async function fetchText(url) {
  const response = await globalThis.fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`Local asset unavailable (${response.status})`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function renderSandbox(html, css, js) {
  const styleTag = '<link rel="stylesheet" href="prototype.css">';
  const scriptTag = '<script type="module" src="prototype.js"></script>';
  if (!html.includes(styleTag) || !html.includes(scriptTag))
    throw new Error("Generated bundle has an unsupported document shape");
  // The saved standalone files remain byte-for-byte builder output. Inline only in the
  // opaque-origin review frame so its script can run without same-origin parent access.
  return html
    .replace(styleTag, `<style>${css}</style>`)
    .replace(scriptTag, `<script>${js}</script>`);
}

async function renderPreview() {
  const sequence = ++requestNumber;
  const entry = entries.find((item) => item.id === active.scenario);
  updateButtons();
  frame?.remove();
  frame = null;
  standalone.hidden = true;
  provenance.replaceChildren();
  status.textContent = "";
  previewState = "loading";
  showNotice("", "info");
  if (!entry) {
    summary.textContent = "No scenario is available for this selection.";
    showMessage("No generated prototype is available.", "empty");
    addProvenance("Status", "No catalog entry");
    return;
  }
  summary.textContent = `${entry.domain.label}  /  ${entry.scenario.label}`;
  showMessage("Loading generated prototype…");
  try {
    const base = `/catalog/${entry.id}/comparison`;
    const comparison = await fetchJson(`${base}/comparison.json`);
    if (sequence !== requestNumber) return;
    if (
      comparison.kind !== "mimic-prototype-mode-comparison" ||
      comparison.scenario.artifactId !== entry.scenario.artifactId ||
      comparison.scenario.revision !== entry.scenario.revision ||
      comparison.scenario.lockDigest !== entry.scenario.lockDigest ||
      comparison.current?.path !== "current" ||
      (comparison.proposed && comparison.proposed.path !== "proposed")
    )
      throw new Error("Catalog and comparison provenance disagree");
    const fallback = active.mode === "proposed" && !comparison.proposed;
    const actualMode = fallback ? "current" : active.mode;
    const bundle = comparison[actualMode];
    if (!bundle) throw new Error("Selected mode has no generated bundle");
    const bundleRoot = `${base}/${actualMode}`;
    const [manifest, html, css, js] = await Promise.all([
      fetchJson(`${bundleRoot}/manifest.json`),
      fetchText(`${bundleRoot}/index.html`),
      fetchText(`${bundleRoot}/prototype.css`),
      fetchText(`${bundleRoot}/prototype.js`),
    ]);
    if (sequence !== requestNumber) return;
    if (
      manifest.kind !== "mimic-prototype-specification" ||
      manifest.planDigest !== bundle.planDigest ||
      manifest.scenario.lockDigest !== comparison.scenario.lockDigest ||
      manifest.scenario.artifactId !== comparison.scenario.artifactId ||
      manifest.scenario.revision !== comparison.scenario.revision
    )
      throw new Error(
        "Generated bundle provenance does not match its comparison",
      );
    if (fallback) {
      showNotice(
        `Proposed unavailable: ${comparison.fallback ?? "no Proposed bundle"}. Showing the generated Current mode for this same scenario.`,
        "fallback",
      );
    } else if (actualMode === "proposed") {
      const request = comparison.choices.find(
        (choice) => choice.status !== "current",
      )?.systemRequest;
      showNotice(
        `Proposed capability is not implemented. System Request ${request ? exact(request) : "not recorded"}. The authored plans still require review.`,
        "proposed",
      );
    } else {
      showNotice(
        "Current mode is based on approved fixture capabilities. The authored render plan still requires review.",
        "current",
      );
    }
    addProvenance(
      "Displayed mode",
      fallback
        ? "Current fallback (Proposed requested)"
        : actualMode === "current"
          ? "Current"
          : "Proposed",
    );
    addProvenance("Scenario", exact(comparison.scenario));
    addProvenance("UI contract", exact(comparison.contract));
    addProvenance("Mode plan digest", comparison.modePlanDigest);
    addProvenance("Render plan digest", manifest.planDigest);
    addProvenance("Decision context", comparison.decisionContext.kind);
    for (const request of comparison.decisionContext.requests)
      addProvenance("Decision request", exact(request));
    addProvenance("Fixtures", manifest.fixtures);
    addProvenance("Plan review", comparison.review);
    const nextFrame = document.createElement("iframe");
    nextFrame.id = "prototype-frame";
    nextFrame.title = "Generated specification prototype";
    nextFrame.setAttribute("sandbox", "allow-scripts");
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.srcdoc = renderSandbox(html, css, js);
    const frameLoaded = new Promise((resolve, reject) => {
      nextFrame.addEventListener("load", resolve, { once: true });
      nextFrame.addEventListener(
        "error",
        () => reject(new Error("Frame could not load")),
        { once: true },
      );
    });
    deviceFrame.append(nextFrame);
    frame = nextFrame;
    await frameLoaded;
    if (sequence !== requestNumber) return;
    standalone.href = `${bundleRoot}/index.html`;
    standalone.hidden = false;
    previewState = "ready";
    message.hidden = true;
  } catch (error) {
    if (sequence !== requestNumber) return;
    previewState = "error";
    showNotice("", "info");
    showMessage(
      `Unable to load this generated prototype. ${error.message}`,
      "error",
    );
    addProvenance(
      "Status",
      "Generated files could not be verified for display",
    );
  }
}

function changeSelection() {
  reconcileSelectors();
  writeLocation();
  renderPreview();
}

for (const field of fields) {
  selects[field].addEventListener("change", (event) => {
    active[field] = event.target.value;
    changeSelection();
  });
}
for (const button of document.querySelectorAll("[data-viewport]")) {
  button.addEventListener("click", () => {
    if (button.dataset.viewport === active.viewport) return;
    active.viewport = button.dataset.viewport;
    writeLocation();
    updateButtons();
  });
}
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => {
    if (button.dataset.mode === active.mode) return;
    active.mode = button.dataset.mode;
    writeLocation();
    renderPreview();
  });
}
document.getElementById("preview").addEventListener("click", () => {
  status.textContent =
    previewState === "ready"
      ? "Preview ready"
      : previewState === "error"
        ? "Preview unavailable"
        : "Preview loading";
  if (previewState === "ready")
    provenance.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
globalThis.addEventListener("popstate", () => {
  readLocation();
  renderPreview();
});

async function loadCatalog() {
  try {
    const catalog = await fetchJson("/catalog/index.json");
    if (
      catalog.schemaVersion !== 1 ||
      catalog.synthetic !== true ||
      !Array.isArray(catalog.entries)
    )
      throw new Error("Unsupported catalog format");
    entries = catalog.entries.filter(
      (entry) =>
        /^[a-z0-9-]+$/.test(entry.id) &&
        entry.comparisonPath === `/catalog/${entry.id}/comparison` &&
        entry.project?.id &&
        entry.domain?.id &&
        entry.direction?.id &&
        entry.scenario?.artifactId &&
        entry.scenario?.lockDigest,
    );
    readLocation();
    writeLocation(true);
    await renderPreview();
  } catch (error) {
    entries = [];
    reconcileSelectors();
    summary.textContent = "Catalog unavailable";
    showMessage(
      `Could not load the local synthetic catalog. ${error.message}`,
      "error",
    );
    provenance.replaceChildren();
    addProvenance("Status", "Catalog load failed");
    previewState = "error";
  }
}

loadCatalog();
