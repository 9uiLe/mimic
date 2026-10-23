const encode = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const headingId = value => value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
const select = document.getElementById('concept-select');
const selection = document.getElementById('graph-selection');
const edgesList = document.getElementById('graph-edges');
const status = document.getElementById('graph-status');
const loading = document.getElementById('graph-load-status');
const interactive = document.getElementById('graph-interactive');
try {
const bundle = JSON.parse(document.getElementById('relation-bundle').textContent);
const graphData = { nodes: bundle.graph.nodes.map(node => ({ ...node, route: `../knowledge/${node.id}/index.html` })),
  edges: bundle.graph.edges, vocabulary: bundle.vocabulary.types };
function context() {
  const from = new URLSearchParams(location.search).get('from');
  return from && /^q-[a-z]+$/.test(from) ? from : '';
}
function readLink(node, heading = '') {
  return node.route + (context() ? `?from=${encodeURIComponent(context())}` : '') + (heading ? `#${headingId(heading)}` : '');
}
function graphLink(id) {
  const parameters = new URLSearchParams({ concept: id });
  if (context()) parameters.set('from', context());
  return `index.html?${parameters}`;
}
function showSelection() {
  const id = new URLSearchParams(location.search).get('concept') || 'grouping';
  const nodes = new Map(graphData.nodes.map(node => [node.id, node]));
  const node = nodes.get(id);
  if (!node) {
    selection.innerHTML = '<h2 class="type-section">この知識は見つかりませんでした。</h2><p>一覧から関係を見たい知識を選び直してください。</p>';
    status.textContent = ''; edgesList.replaceChildren(); select.selectedIndex = -1;
    return;
  }
  select.value = id;
  const edges = graphData.edges.filter(edge => edge.from === id || edge.to === id);
  selection.innerHTML = `<div class="selected-concept"><h2 class="type-section" id="selected-concept-title" tabindex="-1">${encode(node.title)}</h2>
<p>v${encode(node.version)}</p><p><a href="${readLink(node)}">本文を読む ↗</a></p></div>`;
  status.textContent = edges.length ? `${edges.length}件の関係`
    : 'この知識の関係は、まだ登録されていません。ほかの知識と無関係だという意味ではありません。本文の関連する項目も参照できます。';
  edgesList.innerHTML = edges.map(edge => {
    const type = graphData.vocabulary.find(type => type.id === edge.type);
    const from = nodes.get(edge.from); const to = nodes.get(edge.to);
    const nodeLink = current => `<a class="graph-node" data-selected="${current.id === id}" href="${graphLink(current.id)}">${encode(current.title)}</a>`;
    return `<li class="edge"><div class="relation-path">${nodeLink(from)}
<span class="edge-symbol"><span aria-label="${type.directed ? '前の知識から次の知識への関係' : '対称な関係'}">${type.directed ? '→' : '↔'}
</span><span>${encode(type.label)}</span></span>${nodeLink(to)}</div>
<p>${encode(edge.statement)}</p><details><summary>適用範囲と根拠</summary><p>${encode(type.description)}</p>${edge.scope ? `<p>この関係の範囲：${encode(edge.scope)}</p>` : ''}
${edge.evidence.map(evidence => {
      const source = nodes.get(evidence.concept);
      return `<blockquote>${encode(evidence.quotation)}</blockquote><p><a href="${readLink(source, evidence.heading)}">${encode(source.title)}「${encode(evidence.heading)}」</a></p>`;
    }).join('')}</details></li>`;
  }).join('');
  for (const link of document.querySelectorAll('[data-home]')) link.href = `../index.html${context() ? '#' + context() : ''}`;
  for (const link of document.querySelectorAll('[data-graph]')) link.href = graphLink(id);
}
select.addEventListener('change', () => {
  history.pushState(null, '', graphLink(select.value));
  showSelection();
});
edgesList.addEventListener('click', event => {
  const link = event.target.closest('a.graph-node');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  showSelection();
  const heading = document.getElementById('selected-concept-title');
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: 'nearest' });
});
addEventListener('popstate', () => { if (graphData) showSelection(); });
// Static relations remain available when the enhancement is unavailable.
select.disabled = false;
loading.hidden = true;
showSelection();
const fallback = document.getElementById('graph-fallback');
if (fallback) fallback.open = false;
interactive.hidden = false;
} catch {
  interactive.hidden = true;
  loading.hidden = false;
  loading.textContent = '選択表示を利用できません。知識と意味関係の一覧から、本文や根拠を読めます。';
}
