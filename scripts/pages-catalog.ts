import path from 'node:path';
import { pageFontHead } from './pages-fonts.ts';

export const conceptIds = Object.freeze([
  'ecological-interface-design', 'external-representations', 'conceptual-models', 'grouping', 'visual-hierarchy',
  'lightness-and-luminance', 'color-contrast', 'design-tokens', 'ai-slop', 'aesthetic-and-minimalist-design',
  'typography', 'layout-spacing', 'alignment-and-grids', 'color-context', 'ui-layering',
  'human-centered-design', 'user-journeys', 'information-architecture',
  'interaction-design', 'design-systems', 'usability-testing',
]);
export const conceptFiles = Object.freeze(conceptIds.flatMap(id => [
  `knowledge/${id}/KNOWLEDGE.md`, `knowledge/${id}/references/sources.md`,
]));
export const exampleFiles = Object.freeze([
  'knowledge/external-representations/examples/temperature.md',
  'knowledge/grouping/examples/schedule.md',
  'knowledge/visual-hierarchy/examples/schedule.md',
  'knowledge/design-tokens/examples/color-presentation.md',
  'knowledge/ai-slop/examples/ui-decisions.md',
  'knowledge/typography/examples/mixed-ui-copy.md',
  'knowledge/layout-spacing/examples/component-spacing.md',
  'knowledge/alignment-and-grids/examples/alignment.md',
  'knowledge/color-context/examples/surrounding-colors.md',
  'knowledge/ui-layering/examples/overlap.md',
  'knowledge/ui-layering/examples/layer-order.md',
  'knowledge/interaction-design/examples/recording-app.md',
]);
export const additionalSources = Object.freeze([
  'knowledge/README.md', 'topics/color.md', 'topics/ai-slop.md', 'topics/product-ui-design.md',
]);
export const readerViews: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ['knowledge/README.md', 'index.html'],
  ['guideline/README.md', 'guideline/index.html'],
  ['guideline/ai.md', 'guideline/ai.html'],
  ['relations/README.md', 'relations/index.html'],
  ['topics/decision-material-selection.md', 'topics/decision-material-selection.html'],
  ...[...conceptFiles, ...exampleFiles, 'topics/color.md', 'topics/ai-slop.md', 'topics/product-ui-design.md'].map(file => [
    file, file.endsWith('/KNOWLEDGE.md') ? file.replace(/KNOWLEDGE\.md$/, 'index.html') : file.replace(/\.md$/, '.html'),
  ]),
]));
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function readerHref(href: string, sourceFile: string, outFile: string, views: Readonly<Record<string, string>>) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return href;
  const [, pathname = '', suffix = ''] = href.match(/^([^?#]*)(.*)$/s)!;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), decodeURI(pathname)));
  const destination = views[target] ?? target;
  const relative = path.posix.relative(path.posix.dirname(outFile), destination);
  return relative + (pathname.endsWith('/') && !views[target] ? '/' : '') + suffix;
}

export function renderCatalog(index: string, entries: ReadonlyMap<string, string>, stylesheet: string, pagesAssets = false) {
  const rows = index.split('\n').filter(line => /^\| `[^`]+` \|/.test(line));
  const listedIds = rows.map(row => row.split('|')[1]!.trim().replaceAll('`', ''));
  if (JSON.stringify(listedIds) !== JSON.stringify(conceptIds)) throw new Error('Catalog must describe every reviewed concept, in index order');
  const items = rows.map(row => {
    const columns = row.split('|').slice(1, -1).map(column => column.trim());
    const id = columns[0]!.replaceAll('`', '');
    const source = entries.get(id);
    if (!source) throw new Error(`Catalog source missing: ${id}`);
    const title = source.match(/^title: (.+)$/m)?.[1];
    const version = source.match(/^version: "?([^"\n]+)"?$/m)?.[1];
    if (!title || !version) throw new Error(`Catalog metadata missing: ${id}`);
    return `<li><h3><a href="knowledge/${id}/">${escapeHtml(title)}</a></h3>`
      + `<p>${escapeHtml(columns[2]!)}</p><p class="meta">v${escapeHtml(version)}</p></li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ja" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${pageFontHead('index.html', pagesAssets)}
<title>Mimic — デザインの知識</title><style>\n${stylesheet}\n</style></head><body>
<a class="skip" href="#content">本文へ</a>
<header><div class="topline"><a class="brand" href="index.html">Mimic</a><div class="toplinks">
<a href="graph/">関係グラフ</a><a href="guideline/">利用ガイド</a></div></div>
<div class="hero"><h1>デザインの知識</h1><p>デジタルUIの概念・思想・哲学を、定義と背景、関連する考え方、出典から読む。</p></div></header>
<main id="content" class="catalog" tabindex="-1"><section aria-labelledby="concepts"><h2 id="concepts">概念から読む</h2>
<ul class="concept-list">${items}</ul></section>
<section class="topic-list" aria-labelledby="topics"><h2 id="topics">複数の概念から読む</h2>
<ul><li><a href="topics/product-ui-design.html">プロダクト全体のUI設計</a></li>
<li><a href="topics/decision-material-selection.html">判断材料の選定</a></li>
<li><a href="topics/color.html">色の知識</a></li><li><a href="topics/ai-slop.html">AI Slopに関する知識</a></li></ul></section></main>
<footer><div><a href="knowledge/README.md">知識の索引のMarkdown</a> · <a href="guideline/">利用ガイド</a></div></footer>
</body></html>\n`;
}
