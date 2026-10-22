(() => {
  const embedded = document.getElementById('relation-bundle');
  const explorer = document.getElementById('graph-explorer');
  if (!embedded || !explorer) return;
  const bundle = JSON.parse(embedded.textContent);
  const { nodes, edges } = bundle.graph;
  const types = new Map(bundle.vocabulary.types.map(type => [type.id, type]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const svg = document.getElementById('relation-graph');
  const search = document.getElementById('graph-search');
  const typeSelect = document.getElementById('graph-type');
  const status = document.getElementById('graph-status');
  const selection = document.getElementById('graph-selection');
  let selected = new URLSearchParams(location.search).get('concept');
  if (!nodeById.has(selected)) selected = null;

  const element = (tag, attributes = {}, text) => {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([name, value]) => child.setAttribute(name, String(value)));
    if (text !== undefined) child.textContent = text;
    return child;
  };
  const html = (tag, className, text) => {
    const child = document.createElement(tag);
    if (className) child.className = className;
    if (text !== undefined) child.textContent = text;
    return child;
  };
  const link = (node) => {
    const child = html('a', '', `${node.title}の本文を読む`);
    child.href = `../knowledge/${encodeURIComponent(node.id)}/index.html`;
    return child;
  };
  const defs = element('defs');
  const arrow = element('marker', {
    id: 'graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  });
  arrow.append(element('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'graph-arrow' }));
  defs.append(arrow);
  svg.append(defs);
  const edgeLayer = element('g', { 'aria-hidden': 'true' });
  const nodeLayer = element('g');
  svg.append(edgeLayer, nodeLayer);
  const columns = Math.min(4, Math.max(nodes.length, 1));
  const rowCount = Math.ceil(nodes.length / columns);
  const height = Math.max(280, rowCount * 220 + 60);
  svg.setAttribute('viewBox', `0 0 1200 ${height}`);
  const positions = new Map(nodes.map((node, index) => [node.id, {
    x: 150 + (index % columns) * 300,
    y: 130 + Math.floor(index / columns) * 220,
  }]));
  const endpoint = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const ratio = Math.min(112 / (Math.abs(dx) || 1), 47 / (Math.abs(dy) || 1));
    return { x: from.x + dx * ratio, y: from.y + dy * ratio };
  };
  const paths = new Map();
  edges.forEach((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const start = endpoint(from, to);
    const end = endpoint(to, from);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const bend = 24 + (index % 4) * 16;
    const cx = (start.x + end.x) / 2 - dy / length * bend;
    const cy = (start.y + end.y) / 2 + dx / length * bend;
    const attributes = {
      d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
      class: 'graph-edge', 'marker-end': 'url(#graph-arrow)',
    };
    if (!types.get(edge.type).directed) attributes['marker-start'] = 'url(#graph-arrow)';
    const path = element('path', attributes);
    path.append(element('title', {}, `${types.get(edge.type).label}: ${edge.statement}`));
    edgeLayer.append(path);
    paths.set(edge.id, path);
  });
  const nodeButtons = new Map();
  const wrapTitle = (title) => {
    const lines = [''];
    let width = 0;
    for (const character of title) {
      const unit = /[ -~]/.test(character) ? .55 : 1;
      if (width + unit > 12.5) {
        const previous = lines[lines.length - 1];
        const space = previous.lastIndexOf(' ');
        const carry = space > previous.length / 2 ? previous.slice(space + 1) : '';
        if (carry) lines[lines.length - 1] = previous.slice(0, space);
        lines.push(carry);
        width = [...carry].reduce((total, part) => total + (/[ -~]/.test(part) ? .55 : 1), 0);
      }
      lines[lines.length - 1] += character;
      width += unit;
    }
    return lines;
  };
  nodes.forEach(node => {
    const { x, y } = positions.get(node.id);
    const button = element('g', {
      class: 'graph-node', role: 'button', tabindex: 0, 'aria-pressed': 'false',
      'aria-label': `${node.title}の関係を読む`, transform: `translate(${x},${y})`,
    });
    button.append(element('rect', { x: -112, y: -47, width: 224, height: 94, rx: 5 }));
    const lines = wrapTitle(node.title);
    const title = element('text', { 'text-anchor': 'middle', y: lines.length > 1 ? -13 : -3 });
    lines.forEach((line, index) => title.append(element('tspan', { x: 0, dy: index ? 22 : 0 }, line)));
    button.append(title);
    const count = element('text', { 'text-anchor': 'middle', y: 31, class: 'graph-node-count' });
    button.append(count);
    const choose = () => {
      selected = selected === node.id ? null : node.id;
      update();
    };
    button.addEventListener('click', choose);
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      if (event.key === 'Escape') { selected = null; update(); }
    });
    nodeButtons.set(node.id, { button, count });
    nodeLayer.append(button);
  });

  function showSelection(filteredEdges) {
    selection.replaceChildren();
    const title = html('h2', '', selected ? nodeById.get(selected).title : '概念を選んで関係を読む');
    title.id = 'selection-title';
    selection.append(title);
    if (!selected) {
      selection.append(html('p', '', 'グラフの概念を選ぶと、向き・意味・対象範囲・本文の根拠をここで確認できます。'));
      return;
    }
    selection.append(link(nodeById.get(selected)));
    const incident = filteredEdges.filter(edge => edge.from === selected || edge.to === selected);
    if (!incident.length) {
      selection.append(html('p', '', '現在の絞り込みに、この概念の関係はありません。本文から概念を読めます。'));
      return;
    }
    const groups = [
      ['出る関係 → この概念から相手へ', edge => types.get(edge.type).directed && edge.from === selected],
      ['入る関係 ← 相手からこの概念へ', edge => types.get(edge.type).directed && edge.to === selected],
      ['対称の関係 ↔ 向きによる意味の違いなし', edge => !types.get(edge.type).directed],
    ];
    groups.forEach(([label, matches]) => {
      const groupEdges = incident.filter(matches);
      if (!groupEdges.length) return;
      const section = html('section');
      section.append(html('h3', 'selection-directions', `${label} · ${groupEdges.length}件`));
      groupEdges.forEach(edge => {
        const original = document.getElementById(`relation-${edge.id}`);
        const article = original.cloneNode(true);
        article.removeAttribute('id');
        section.append(article);
      });
      selection.append(section);
    });
  }

  function update() {
    const query = search.value.trim().toLocaleLowerCase('ja');
    const matches = new Set(nodes.filter(node => `${node.title} ${node.id}`.toLocaleLowerCase('ja').includes(query)).map(node => node.id));
    const filteredEdges = edges.filter(edge => (!typeSelect.value || edge.type === typeSelect.value)
      && (!query || matches.has(edge.from) || matches.has(edge.to)));
    const visible = new Set(filteredEdges.flatMap(edge => [edge.from, edge.to]));
    if (!typeSelect.value && !query) nodes.forEach(node => visible.add(node.id));
    if (query) matches.forEach(id => visible.add(id));
    if (selected && !visible.has(selected)) selected = null;
    const neighbors = new Set([selected]);
    filteredEdges.forEach(edge => {
      if (edge.from === selected) neighbors.add(edge.to);
      if (edge.to === selected) neighbors.add(edge.from);
    });
    const visibleEdgeIds = new Set(filteredEdges.map(edge => edge.id));
    edges.forEach(edge => {
      const path = paths.get(edge.id);
      path.hidden = !visibleEdgeIds.has(edge.id);
      path.style.display = path.hidden ? 'none' : '';
      path.classList.toggle('is-near', !!selected && (edge.from === selected || edge.to === selected));
      path.classList.toggle('is-muted', !!selected && edge.from !== selected && edge.to !== selected);
    });
    nodes.forEach(node => {
      const { button, count } = nodeButtons.get(node.id);
      const shown = visible.has(node.id);
      button.style.display = shown ? '' : 'none';
      button.setAttribute('tabindex', shown ? '0' : '-1');
      button.setAttribute('aria-pressed', String(selected === node.id));
      button.classList.toggle('is-selected', selected === node.id);
      button.classList.toggle('is-muted', !!selected && !neighbors.has(node.id));
      count.textContent = `関係 ${filteredEdges.filter(edge => edge.from === node.id || edge.to === node.id).length}件`;
    });
    status.textContent = visible.size ? `${visible.size} / ${nodes.length}概念、${filteredEdges.length} / ${edges.length}関係を表示。`
      + (selected ? `${nodeById.get(selected).title}を選択中。` : '') : '一致する概念や関係はありません。検索語や関係の種類を変えてください。';
    showSelection(filteredEdges);
  }
  search.addEventListener('input', update);
  typeSelect.addEventListener('change', update);
  document.getElementById('graph-reset').addEventListener('click', () => {
    selected = null; search.value = ''; typeSelect.value = ''; update();
  });
  update();
  explorer.hidden = false;
  document.getElementById('graph-fallback').open = false;
})();
