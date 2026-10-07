/** Deliberate generated-byte regressions; tests assert observed findings, not preset states. */
export const brokenTransition = "if (button) show('success');";
export const brokenEmptyRecovery =
  "if (button) show(button.closest('[data-state=\"empty\"]') ? 'empty' : button.getAttribute('data-target-state'));";
export const oneShotTransition =
  "if (button) { const key = button.closest('[data-state]').getAttribute('data-state') + '>' + button.getAttribute('data-target-state'); if (seen.has(key)) return; seen.add(key); show(button.getAttribute('data-target-state')); }";
export const inaccessibleImage = '<img src="missing.png">';
export const overflowingUnfocusedCss =
  "\nbody { width: 200vw; }\n:focus-visible { outline: none; }\n";
