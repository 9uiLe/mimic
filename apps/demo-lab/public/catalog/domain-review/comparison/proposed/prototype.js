const allowed = new Set(["loading","empty","partial","success","error","permission","disabled"]);
function show(state) {
  if (!allowed.has(state)) return;
  for (const section of document.querySelectorAll('[data-state]')) section.hidden = section.getAttribute('data-state') !== state;
  document.getElementById('prototype-status').textContent = state + ' state';
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target-state]');
  if (button) show(button.getAttribute('data-target-state'));
});
