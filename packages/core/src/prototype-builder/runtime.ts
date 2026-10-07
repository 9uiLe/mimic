/** Emit only fixed browser operations over the validated authored tree. */
export function stateFocusRuntime(): string {
  return `
function focusAfterStateChange(state) {
  const active = document.activeElement;
  if (active && active !== document.body && active.getClientRects().length && !active.closest('[hidden],details:not([open])')) return;
  const view = [...document.querySelectorAll('[data-state]')].find((item) => item.getAttribute('data-state') === state);
  const heading = [...view.querySelectorAll('h1,h2,h3')].find((item) => item.getClientRects().length && !item.closest('[hidden],details:not([open])'));
  const target = heading || view;
  target.tabIndex = -1;
  target.focus();
}
`;
}

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
  if (target && target.getClientRects().length && !target.closest('[hidden],details:not([open])')) {
    target.focus();
    return;
  }
  const details = (target || fallback)?.closest('details:not([open])');
  if (details && details.getClientRects().length && !details.closest('[hidden]')) {
    details.querySelector('summary').focus();
    return;
  }
  if (fallback?.isConnected && fallback.getClientRects().length && !fallback.closest('[hidden]')) {
    fallback.focus();
    return;
  }
  const state = document.querySelector('[data-state]:not([hidden])');
  if (state) focusAfterStateChange(state.getAttribute('data-state'));
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
  if (focused && focused !== document.body) responsiveFocus(nextFocus, focused);
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
  } else if (focused && focused !== document.body) responsiveFocus(nextFocus, focused);
}
function reconcileResponsive() {
  if (responsiveQuery.matches && !mobileApplied) applyResponsive();
  else if (!responsiveQuery.matches && mobileApplied) restoreResponsive();
}
responsiveQuery.addEventListener('change', reconcileResponsive);
reconcileResponsive();
`;
}
