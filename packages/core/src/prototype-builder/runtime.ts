/** Emit only fixed browser operations over the validated authored tree. */
export function responsiveRuntime(
  program: readonly {
    readonly state: string;
    readonly operations: readonly unknown[];
  }[],
  breakpointPx: number,
): string {
  return `
const responsiveProgram = ${JSON.stringify(program)};
const responsiveQuery = document.defaultView.matchMedia('(max-width: ${breakpointPx}px)');
const responsiveUndo = [];
const disclosureOpen = new Map();
let mobileApplied = false;
function responsiveFocus(id, fallback) {
  const target = id && document.getElementById(id);
  if (target && target.getClientRects().length && !target.closest('details:not([open])')) {
    target.focus();
    return;
  }
  const details = target?.closest('details:not([open])');
  (details?.querySelector('summary') || fallback)?.focus();
}
function applyResponsive() {
  const focused = document.activeElement;
  const focusedId = focused?.id;
  let nextFocus = focusedId;
  for (const entry of responsiveProgram) {
    for (const [index, operation] of entry.operations.entries()) {
      const key = entry.state + '/' + index;
      if (operation.kind === 'reorder') {
        const parent = document.getElementById(operation.parentId);
        const original = [...parent.children];
        responsiveUndo.push(() => original.forEach((child) => parent.append(child)));
        operation.childIds.forEach((id) => parent.append(document.getElementById(id)));
      } else if (operation.kind === 'collapse' || operation.kind === 'progressive-disclose') {
        const target = document.getElementById(operation.targetId);
        const details = document.createElement('details');
        details.dataset.responsiveDetails = operation.kind;
        details.dataset.responsiveTarget = operation.targetId;
        const summary = document.createElement('summary');
        summary.textContent = operation.summary;
        target.replaceWith(details);
        details.append(summary, target);
        details.open = disclosureOpen.get(key) ?? false;
        details.addEventListener('toggle', () => disclosureOpen.set(key, details.open));
        responsiveUndo.push(() => { disclosureOpen.set(key, details.open); details.replaceWith(target); });
      } else {
        const target = document.getElementById(operation.targetId);
        const template = document.createElement('template');
        template.innerHTML = operation.html;
        const replacement = template.content.firstElementChild;
        for (const mapping of operation.focusMap) if (focusedId === mapping.desktopId) nextFocus = mapping.mobileId;
        target.replaceWith(replacement);
        responsiveUndo.push(() => { replacement.replaceWith(target); });
      }
    }
  }
  mobileApplied = true;
  if (focused && focused !== document.body) responsiveFocus(nextFocus);
}
function restoreResponsive() {
  const focused = document.activeElement;
  const focusedId = focused?.id;
  const summaryTarget = focused?.tagName === 'SUMMARY' ? focused.parentElement.dataset.responsiveTarget : null;
  let nextFocus = focusedId;
  for (const entry of responsiveProgram) for (const operation of entry.operations) {
    if (operation.kind === 'replace') for (const mapping of operation.focusMap) {
      if (focusedId === mapping.mobileId) nextFocus = mapping.desktopId;
    }
  }
  while (responsiveUndo.length) responsiveUndo.pop()();
  mobileApplied = false;
  if (summaryTarget) {
    const group = document.getElementById(summaryTarget);
    const target = group?.querySelector('button,a[href]') || group;
    if (group && target === group) group.tabIndex = -1;
    target?.focus();
  } else if (focused && focused !== document.body) responsiveFocus(nextFocus);
}
function reconcileResponsive() {
  if (responsiveQuery.matches && !mobileApplied) applyResponsive();
  else if (!responsiveQuery.matches && mobileApplied) restoreResponsive();
}
responsiveQuery.addEventListener('change', reconcileResponsive);
reconcileResponsive();
`;
}
