const allowed = new Set(["loading","empty","partial","success","error","permission","disabled"]);
function show(state) {
  if (!allowed.has(state)) return;
  for (const section of document.querySelectorAll('[data-state]')) section.hidden = section.getAttribute('data-state') !== state;
  document.getElementById('prototype-status').textContent = state + ' state';
  focusAfterStateChange(state);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target-state]');
  if (button) show(button.getAttribute('data-target-state'));
});

function focusAfterStateChange(state) {
  const active = document.activeElement;
  if (active && active !== document.body && active.getClientRects().length && !active.closest('[hidden],details:not([open])')) return;
  const view = [...document.querySelectorAll('[data-state]')].find((item) => item.getAttribute('data-state') === state);
  const heading = [...view.querySelectorAll('h1,h2,h3')].find((item) => item.getClientRects().length && !item.closest('[hidden],details:not([open])'));
  const target = heading || view;
  target.tabIndex = -1;
  target.focus();
}
