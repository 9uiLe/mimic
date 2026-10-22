import { escapeHtml } from './pages-catalog.ts';
import { pageFontHead } from './pages-fonts.ts';
import type { RelationBundle } from './relations.ts';

const conceptHref = (id: string) => `../knowledge/${encodeURIComponent(id)}/index.html`;

export function renderRelationGraph(bundle: RelationBundle, stylesheet: string, pagesAssets = true): string {
  const { graph, vocabulary } = bundle;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const types = new Map(vocabulary.types.map(type => [type.id, type]));
  const conceptLink = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Graph concept missing: ${id}`);
    return `<a href="${conceptHref(id)}">${escapeHtml(node.title)}</a>`;
  };
  const concepts = graph.nodes.map(node => {
    const count = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id).length;
    return `<li id="concept-${escapeHtml(node.id)}">${conceptLink(node.id)} <span class="meta">v${escapeHtml(node.version)} · 関係 ${count}件</span></li>`;
  }).join('\n');
  const relations = graph.edges.map(edge => {
    const type = types.get(edge.type);
    if (!type) throw new Error(`Graph relation type missing: ${edge.type}`);
    const direction = type.directed ? '→' : '↔';
    const directionText = type.directed ? '左の概念から右の概念への関係' : '対称の関係・読む向きによる意味の違いなし';
    const evidence = edge.evidence.map(item => {
      const heading = item.heading.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
      const href = `${conceptHref(item.concept)}#${encodeURIComponent(heading)}`;
      return `<li><a href="${href}">${escapeHtml(nodes.get(item.concept)?.title ?? item.concept)} — ${escapeHtml(item.heading)}</a>`
        + `<blockquote>${escapeHtml(item.quotation)}</blockquote></li>`;
    }).join('\n');
    return `<article id="relation-${escapeHtml(edge.id)}" class="relation-entry" data-relation="${escapeHtml(edge.id)}">`
      + `<h3>${conceptLink(edge.from)} <span aria-label="${directionText}">${direction}</span> ${conceptLink(edge.to)}</h3>`
      + `<p class="relation-kind">${escapeHtml(type.label)} · ${directionText}</p><p>${escapeHtml(edge.statement)}</p>`
      + (edge.scope ? `<p class="relation-scope"><strong>対象範囲</strong> ${escapeHtml(edge.scope)}</p>` : '')
      + `<details><summary>本文の根拠 ${edge.evidence.length}件</summary><ul class="relation-evidence">${evidence}</ul></details></article>`;
  }).join('\n');
  const legend = vocabulary.types.map(type => `<li><strong>${escapeHtml(type.label)}</strong> — ${escapeHtml(type.description)}`
    + ` <span class="meta">${type.directed ? '方向あり →' : '対称 ↔'}</span></li>`).join('\n');
  const serialized = JSON.stringify(bundle).replaceAll('<', '\\u003c');
  const assets = pagesAssets
    ? '<link rel="stylesheet" href="../web/graph.css">\n<script src="../web/graph.js" defer></script>' : '';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${pageFontHead('graph/index.html', pagesAssets, pagesAssets)}
<title>知識の関係グラフ — Mimic</title><style>\n${stylesheet}\n</style>
${assets}</head><body class="relation-page">
<a class="skip" href="#content">本文へ</a>
<header><div class="topline"><a class="brand" href="../index.html">Mimic</a>
<div class="toplinks"><a href="../index.html">概念の一覧</a><a href="../guideline/">利用ガイド</a></div></div>
<div class="hero"><p class="context">概念をつなぐ、意味を読む</p><h1>知識の関係グラフ</h1>
<p>概念同士の関係をたどり、気になる概念から本文へ進めます。</p>
<p class="meta">${graph.nodes.length}概念 · ${graph.edges.length}関係。線は登録された関係を表します。線のない概念同士に、関係がないと断定するものではありません。</p></div></header>
<main id="content" tabindex="-1">
<section id="graph-explorer" class="graph-explorer" hidden aria-labelledby="explorer-title">
<h2 id="explorer-title">つながりを探す</h2>
<div class="graph-controls"><label>概念名で検索<input id="graph-search" type="search" placeholder="例：余白、Typography" autocomplete="off"></label>
<label>関係の種類<select id="graph-type"><option value="">すべての関係</option>${vocabulary.types.map(type =>
    `<option value="${escapeHtml(type.id)}">${escapeHtml(type.label)}</option>`).join('')}</select></label>
<button id="graph-reset" type="button">全体に戻る</button></div>
<p id="graph-status" class="meta" role="status" aria-live="polite"></p>
<p id="graph-help" class="meta">配置の上下や距離は、階層や関係の強さを表しません。
概念を選ぶと、その概念につながる線を強調します。矢印は関係の向きです。Tabキーで概念へ移動し、EnterまたはSpaceキーで選べます。</p>
<div class="graph-scroll" tabindex="0" role="region" aria-label="知識の関係グラフ。狭い画面では横にスクロールできます。">
<svg id="relation-graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 940" role="group" aria-labelledby="explorer-title" aria-describedby="graph-help"></svg></div>
<div id="graph-selection" class="graph-selection" aria-labelledby="selection-title"><h2 id="selection-title">概念を選んで関係を読む</h2>
<p>グラフの概念を選ぶと、向き・意味・対象範囲・本文の根拠をここで確認できます。</p></div>
</section>
<section class="graph-reading" aria-labelledby="concepts-title"><h2 id="concepts-title">すべての概念</h2><ul class="graph-concepts">${concepts}</ul></section>
<section class="graph-reading" aria-labelledby="relations-title"><h2 id="relations-title">意味と根拠から読む</h2>
<p>グラフと同じ関係を、文章でも読めます。矢印は説明上の関係の向きで、読む順番の指定ではありません。</p>
<details id="graph-legend"><summary>関係の種類</summary><ul>${legend}</ul></details>
<details id="graph-fallback" open><summary>すべての意味関係 ${graph.edges.length}件</summary>
<div id="graph-relations">${relations || '<p>登録された関係はありません。</p>'}</div></details></section>
</main><footer><div><a href="../index.html">概念の一覧に戻る</a> · <a href="../relations/graph.json">関係データ JSON</a> ·
<a href="../relations/vocabulary.json">関係語彙 JSON</a> · <a href="../relations/index.html">関係データの読み方</a></div></footer>
<script id="relation-bundle" type="application/json">${serialized}</script>
</body></html>\n`;
}
