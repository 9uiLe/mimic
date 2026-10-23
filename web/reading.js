const questionIds = new Set([...document.querySelectorAll('.question')].map(question => question.id));
const siteRoot = new URL('../', document.currentScript.src);

// This is the initial state only. User toggles and later resizing keep their state.
if (!matchMedia('(max-width: 60rem)').matches) {
  for (const toc of document.querySelectorAll('.toc')) toc.open = true;
}

function originQuestion() {
  const current = location.hash.slice(1);
  if (questionIds.has(current)) return current;
  const from = new URLSearchParams(location.search).get('from');
  return from && /^q-[a-z]+$/.test(from) ? from : '';
}

function updateLinks() {
  const from = originQuestion();
  for (const link of document.querySelectorAll('a[href]')) {
    if (link.hasAttribute('data-home')) {
      link.href = link.dataset.home + (from ? `#${from}` : '');
      continue;
    }
    const target = new URL(link.href, location.href);
    if (!from || target.origin !== siteRoot.origin || !target.pathname.startsWith(siteRoot.pathname)
      || !(/\.html$|\/$/.test(target.pathname))) continue;
    target.searchParams.set('from', from);
    link.href = target.href;
  }
}

function revealQuestion() {
  const question = document.getElementById(location.hash.slice(1));
  if (question?.matches('.question')) question.open = true;
  updateLinks();
}
revealQuestion();
addEventListener('hashchange', revealQuestion);
addEventListener('popstate', revealQuestion);
document.addEventListener('click', event => {
  if (event.target.closest('a[href]')) updateLinks();
});
for (const question of document.querySelectorAll('.question')) {
  question.addEventListener('toggle', () => {
    if (question.open) {
      const target = new URL(location.href);
      target.hash = question.id;
      history.replaceState(null, '', target.href);
      updateLinks();
    }
  });
}
