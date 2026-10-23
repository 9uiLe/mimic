import path from 'node:path';
import { renderTopicGuides } from './pages-catalog.ts';
import type { RelationBundle } from './relations.ts';

type Candidate = { id: string; angle: string; reason: string; heading: string; quotation: string };
type ReadingPath = { id: string; title: string; description: string; introduction: string; concepts: Candidate[] };
const escape = (value: string) => value.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const local = (route: string, target: string) => path.posix.relative(path.posix.dirname(route), target) || path.posix.basename(target);
const headingId = (value: string) => value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';

export function validateReadingPaths(source: unknown, entries: ReadonlyMap<string, string>): ReadingPath[] {
  if (!Array.isArray(source) || !source.length) throw new Error('Reading paths must be a nonempty array');
  const ids = new Set<string>();
  const textFields = ['title', 'description', 'introduction'];
  for (const item of source) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z]+$/.test(item.id)
      || ids.has(item.id) || textFields.some(field => typeof item[field] !== 'string' || !item[field].trim())
      || !Array.isArray(item.concepts) || !item.concepts.length) throw new Error('Invalid reading path');
    ids.add(item.id);
    const candidates = new Set<string>();
    for (const candidate of item.concepts) {
      if (!candidate || typeof candidate !== 'object'
        || ['id', 'angle', 'reason', 'heading', 'quotation'].some(field => typeof candidate[field] !== 'string' || !candidate[field].trim())) {
        throw new Error(`Invalid reading candidate: ${item.id}`);
      }
      const document = entries.get(candidate.id);
      const section = document?.split(`## ${candidate.heading}\n`)[1]?.split(/^## /m)[0];
      if (!document || candidates.has(candidate.id) || !document.includes(`## ${candidate.heading}\n`)
        || !section?.includes(candidate.quotation)) throw new Error(`Reading path basis differs from source: ${item.id}/${candidate.id}`);
      candidates.add(candidate.id);
    }
  }
  return source as ReadingPath[];
}

function frame(route: string, head: string, content: string, bodyClass: string, selectedId?: string) {
  const home = local(route, 'index.html');
  const graph = local(route, 'graph/index.html') + (selectedId ? `?concept=${encodeURIComponent(selectedId)}` : '');
  return `<!doctype html>
<html lang="ja" id="top"><head>${head}
<script src="${local(route, 'web/reading.js')}" defer></script></head>
<body class="${bodyClass}"><a class="skip" href="#content">本文へ</a>
<header class="site-header"><div class="site-header-inner">
<a class="brand" href="${home}" data-home="${home}">Mimic<span>UI設計の知識</span></a>
<nav aria-label="サイト内"><a href="${home}" data-home="${home}">疑問から探す</a>
<a href="${graph}" data-graph>関係から探す</a><a href="${home}#all-concepts">知識の一覧</a></nav></div></header>
${content}
<footer class="site-footer"><div>
<a href="${local(route, 'guideline/design-system.html')}">デザインシステム</a>
<a href="${local(route, 'guideline/index.html')}">利用ガイド</a>
<a href="${home}" data-home="${home}">入口へ戻る</a></div></footer></body></html>\n`;
}

function originalHead(html: string) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1];
  if (!head) throw new Error('Reader head missing');
  // Only the external reading enhancement runs; Markdown remains non-executable.
  return head.includes("script-src 'self'") ? head : head.replace(/(form-action 'none')(">)/, "$1; script-src 'self'$2");
}

export function renderHome(catalogHtml: string, paths: ReadingPath[], entries: ReadonlyMap<string, string>) {
  const catalog = catalogHtml.match(/<ul class="concept-list">([\s\S]*?)<\/ul>/)?.[1];
  if (catalog === undefined) throw new Error('Reviewed catalog content missing');
  const topics = renderTopicGuides();
  const questions = paths.map(item => {
    const candidates = item.concepts.map(candidate => {
      const title = entries.get(candidate.id)!.match(/^title: (.+)$/m)![1]!;
      const href = `knowledge/${candidate.id}/index.html?from=q-${item.id}`;
      return `<li class="candidate"><h3 class="type-subheading"><a href="${href}">${escape(title)}</a></h3>
<p class="candidate-angle type-label">${escape(candidate.angle)}</p><p>${escape(candidate.reason)}</p>
<a class="evidence type-supporting" href="${href}#${escape(headingId(candidate.heading))}">「${escape(candidate.heading)}」を読む ↗</a></li>`;
    }).join('\n');
    return `<details class="question" id="q-${item.id}" name="questions"><summary>
<span><span class="question-title type-subheading">${escape(item.title)}</span>
<span class="question-description type-supporting">${escape(item.description)}</span></span>
<span class="question-icon" aria-hidden="true"></span></summary><div class="question-content">
<p class="question-introduction">${escape(item.introduction)}</p><ul class="candidate-list">${candidates}</ul></div></details>`;
  }).join('\n');
  const content = `<main id="content" tabindex="-1">
<section class="home-section questions-section" aria-labelledby="questions-title"><div class="section-intro">
<h1 class="type-section" id="questions-title">疑問から探す</h1>
<p class="type-supporting">疑問を開くと、関連する知識を比べられます。</p></div>
<div class="questions">${questions}<p class="editorial-note type-supporting">本文をもとに組み合わせた案内です。読む順序は決まっていません。</p></div></section>
<section class="home-section catalog-section" id="all-concepts" aria-labelledby="catalog-title"><div class="section-intro">
<h2 class="type-section" id="catalog-title">知識の一覧</h2><p class="type-supporting">収録している20件から、名前で探せます。</p></div>
<ul class="catalog-list">${catalog}</ul></section>
<section class="home-section guides-section" aria-labelledby="guides-title"><div class="section-intro">
<h2 class="type-section" id="guides-title">複数の知識をつなぐ</h2></div><ul class="guide-list">
<li><a href="graph/index.html">知識の関係から探す</a><p class="type-supporting">知識どうしの違いやつながりを調べる。</p></li>${topics}</ul></section></main>`;
  return frame('index.html', originalHead(catalogHtml), content, 'home');
}

/** Reuses the validated Markdown renderer's complete article and provenance. */
export function renderReader(html: string, route: string, sourceFile: string, specimens = '') {
  if ((html.match(/<article(?:\s|>)/g) ?? []).length !== 1 || (html.match(/<footer>/g) ?? []).length !== 1
    || (html.match(/<h1(?:\s|>)/g) ?? []).length !== 1) throw new Error(`Ambiguous reader frame: ${route}`);
  const article = html.match(/<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/)?.[1];
  const title = html.match(/<h1 id="title">([\s\S]*?)<\/h1>/)?.[1];
  const toc = html.match(/<nav aria-label="目次">([\s\S]*?)<\/nav>/)?.[1] ?? '';
  const footer = html.match(/<footer><div>([\s\S]*?)<\/div><\/footer>/)?.[1];
  if (article === undefined || title === undefined || footer === undefined) throw new Error(`Reader content missing: ${route}`);
  const id = sourceFile.startsWith('knowledge/') ? sourceFile.split('/')[1] : undefined;
  const version = html.match(/<meta name="knowledge-version" content="([^"]+)">/)?.[1];
  const context = html.match(/<p class="context">([\s\S]*?)<\/p>/)?.[0] ?? '';
  const kind = sourceFile.endsWith('/references/sources.md') ? '出典' : sourceFile.includes('/examples/') ? '説明例'
    : sourceFile.startsWith('topics/') ? '読書案内' : sourceFile.startsWith('guideline/') ? '利用ガイド' : '';
  const home = local(route, 'index.html');
  const graph = id ? `<a class="concept-graph-link type-supporting" data-graph
href="${local(route, 'graph/index.html')}?concept=${encodeURIComponent(id)}">この知識の関係を見る ↗</a>` : '';
  const source = local(route, sourceFile);
  const sources = sourceFile.endsWith('/KNOWLEDGE.md') ? `<a href="references/sources.html">出典を読む</a><span aria-hidden="true"> · </span>` : '';
  const content = `<main id="content" class="reader" tabindex="-1"><div class="reader-heading">
<div class="reader-kind type-supporting">${kind ? `<span>${kind}</span>` : ''}${version ? `<span>v${version}</span>` : ''}</div>
<div>${context}<h1 class="type-title" id="title">${title}</h1><p class="reading-status type-supporting">
${sources}<a href="${source}">Markdown原文</a><span> · 全文</span></p></div></div>
<div class="reader-layout"><aside class="reader-aside">${graph}
${toc ? `<nav aria-label="このページの目次">${toc.replace('<details>', '<details class="toc">')}</nav>` : ''}
<a class="back-link type-supporting" href="${home}" data-home="${home}">← 疑問から探す</a></aside>
<div class="reader-content"><article class="prose">${article}</article>${specimens}
<div class="reading-end"><a href="${home}" data-home="${home}">← 入口へ戻る</a><a href="#top">ページ上部へ ↑</a></div>
<div class="reader-provenance type-supporting">${footer}</div></div></div></main>`;
  const result = frame(route, originalHead(html), content, 'reading', id);
  if (!result.includes(`<article class="prose">${article}</article>`) || !result.includes(footer)) {
    throw new Error(`Reader frame lost source content: ${route}`);
  }
  return result;
}

export function renderGraphPage(html: string, bundle: RelationBundle) {
  const fallback = html.match(/<section class="graph-reading" aria-labelledby="concepts-title">([\s\S]*?)<\/main>/)?.[0];
  const embedded = html.match(/<script id="relation-bundle"[\s\S]*?<\/script>/)?.[0];
  if (!fallback || !embedded) throw new Error('Graph fallback content missing');
  const options = bundle.graph.nodes.map(node => `<option value="${escape(node.id)}">${escape(node.title)}</option>`).join('\n');
  const content = `<main id="content" class="graph-page" tabindex="-1"><header class="graph-intro">
<h1 class="type-title">知識の関係</h1><p>知識を選ぶと、ほかの知識との違いやつながりを確認できます。</p></header>
<p id="graph-load-status" class="type-supporting" role="status">知識と意味関係の一覧から、本文や根拠を読めます。</p>
<div id="graph-interactive" class="graph-layout" hidden><aside class="graph-selector">
<label for="concept-select" class="type-label">関係を見たい知識</label>
<div class="concept-select-wrap"><select id="concept-select" disabled>${options}</select></div>
<p class="type-supporting">線の向きは関係の向きです。読む順序や必読条件ではありません。</p>
<p class="type-supporting">配置の上下や距離は、階層や関係の強さを表しません。</p>
<a class="back-link type-supporting" href="../index.html" data-home="../index.html">← 疑問から探す</a></aside>
<section class="graph-panel" aria-label="選択した知識の関係">
<div id="graph-selection"></div><p id="graph-status" class="graph-status type-supporting" role="status"></p>
<ul id="graph-edges" class="edge-list"></ul></section></div>
<div class="graph-catalog">${fallback.replaceAll('すべての概念', '知識の一覧').replaceAll('左の概念から右の概念への関係', '左の知識から右の知識への関係')
    .replace('</main>', '')}</div>
<p class="type-supporting"><a href="../relations/graph.json">関係データ JSON</a> ·
<a href="../relations/vocabulary.json">関係語彙 JSON</a> · <a href="../relations/index.html">関係データの読み方</a></p>
<noscript><p>選択表示にはJavaScriptを使います。知識と意味関係の一覧から、本文や根拠を読めます。</p></noscript>
</main>${embedded}`;
  return frame('graph/index.html', originalHead(html), content, 'graph-reading');
}
