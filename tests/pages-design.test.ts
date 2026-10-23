import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'bun:test';
import { compileDesignTokens } from '../scripts/design-tokens.ts';
import { renderGraphPage, renderReader, validateReadingPaths } from '../scripts/pages-design.ts';

test('design tokens resolve typed aliases and generate the CSS used by reading roles', () => {
  const compiled = compileDesignTokens({ base: { ink: { type: 'color', value: '#171717' } },
    role: { text: { type: 'color', value: '{base.ink}' } } });
  assert.equal(compiled.resolved['role.text'], '#171717', 'a role alias must resolve to its referenced base value');
  assert.ok(compiled.css.includes('--role-text: var(--base-ink);'), 'CSS must preserve the editable alias relationship');
  for (const invalid of [
    { role: { text: { type: 'color', value: '{missing.ink}' } } },
    { first: { type: 'color', value: '{second}' }, second: { type: 'color', value: '{first}' } },
    { base: { type: 'number', value: 12 }, role: { type: 'color', value: '{base}' } },
    { body: { type: 'typography', value: { fontSize: '1rem' } } },
    { color: { type: 'color', value: 'red; display: none' } },
  ]) assert.throws(() => compileDesignTokens(invalid), /Unknown token|Token cycle|Alias type mismatch|Incomplete typography|Invalid color/);
  const typography = { family: { type: 'fontFamily', value: ['Example Sans', 'sans-serif'] },
    size: { type: 'dimension', value: '1rem' }, weight: { type: 'fontWeight', value: 400 },
    tracking: { type: 'dimension', value: '0rem' }, line: { type: 'number', value: 1.9 },
    body: { type: 'typography', value: { fontFamily: '{family}', fontSize: '{size}', fontWeight: '{weight}',
      letterSpacing: '{tracking}', lineHeight: '{line}' } } };
  assert.deepEqual(compileDesignTokens(typography).resolved.body, {
    fontFamily: ['Example Sans', 'sans-serif'], fontSize: '1rem', fontWeight: 400, letterSpacing: '0rem', lineHeight: 1.9,
  });
  typography.body.value.fontSize = '{line}';
  assert.throws(() => compileDesignTokens(typography), /Alias type mismatch/, 'typography sub-values must retain their declared types');
});

test('reading paths require a matching knowledge heading and quotation', () => {
  const entries = new Map([['grouping', 'title: グルーピング\n\n## 分類\n\n分類を決める。\n']]);
  const paths = [{ id: 'structure', title: '情報を分けたい', description: '分類に迷う', introduction: '分け方から考える。',
    concepts: [{ id: 'grouping', angle: '分類を考える', reason: '情報の区切りを決める。', heading: '分類', quotation: '分類を決める。' }] }];
  assert.equal(validateReadingPaths(paths, entries)[0]!.id, 'structure');
  paths[0]!.concepts[0]!.quotation = '本文にない説明。';
  assert.throws(() => validateReadingPaths(paths, entries), /basis differs from source/,
    'unmatched editorial evidence must stop the build');
});

test('the Pages frame retains the entire rendered article and source provenance', () => {
  const article = '<section id="scope"><h2>対象範囲</h2><p>全文を保持。</p><table><tr><td>値</td></tr></table></section>';
  const provenance = '<details id="source-provenance"><summary>原文</summary><dl><dt>source SHA-256</dt><dd>abc</dd></dl></details>';
  const original = `<html><head><meta charset="utf-8"><title>題名</title></head><body><header><h1 id="title">題名</h1></header>`
    + `<main><nav aria-label="目次"><details><summary>目次</summary><ol><li><a href="#scope">対象範囲</a></li></ol></details></nav>`
    + `<article>${article}</article></main><footer><div>${provenance}</div></footer></body></html>`;
  const html = renderReader(original, 'knowledge/grouping/index.html', 'knowledge/grouping/KNOWLEDGE.md');
  assert.ok(html.includes(`<article class="prose">${article}</article>`), 'the reader frame must retain the complete rendered article');
  assert.ok(html.includes(provenance), 'the reader frame must retain the source provenance');
  assert.ok(html.includes('href="../../graph/index.html?concept=grouping"'), 'knowledge must open its selected graph');
  assert.ok(html.includes('href="../../index.html#all-concepts"'), 'the shared navigation must open the knowledge catalog');
  assert.throws(() => renderReader(original.replace('<article>', '<article></article><article>'), 'index.html', 'source.md'),
    /Ambiguous reader frame/, 'an ambiguous frame must reject instead of dropping an article');
});

test('reading navigation retains origin questions and initializes the TOC only once', async () => {
  const script = await readFile(new URL('../web/reading.js', import.meta.url), 'utf8');
  const events = new Map<string, () => void>();
  const home = { href: 'https://example.test/mimic/index.html', dataset: { home: '../../index.html' },
    hasAttribute: (name: string) => name === 'data-home' };
  const graph = { href: 'https://example.test/mimic/graph/index.html?concept=grouping', dataset: {}, hasAttribute: () => false };
  const related = { href: 'https://example.test/mimic/knowledge/typography/index.html#文字', dataset: {}, hasAttribute: () => false };
  const toc = { open: false };
  const location = { href: 'https://example.test/mimic/knowledge/grouping/index.html?from=q-structure#分類',
    search: '?from=q-structure', hash: '#分類' };
  const document = { currentScript: { src: 'https://example.test/mimic/web/reading.js' },
    querySelectorAll: (selector: string) => selector === '.question' ? [] : selector === '.toc' ? [toc] : [home, graph, related],
    getElementById: () => null, addEventListener: (name: string, action: () => void) => events.set(name, action) };
  runInNewContext(script, { document, location, URL, URLSearchParams, history: {}, matchMedia: () => ({ matches: false }),
    addEventListener: (name: string, action: () => void) => events.set(name, action) });
  assert.equal(toc.open, true, 'wide TOC must start open');
  assert.equal(home.href, '../../index.html#q-structure', 'home navigation must return to the origin question');
  assert.equal(graph.href, 'https://example.test/mimic/graph/index.html?concept=grouping&from=q-structure',
    'graph navigation must retain both selected knowledge and origin question');
  assert.equal(new URL(related.href).hash, '#%E6%96%87%E5%AD%97', 'propagating an origin must retain the section fragment');
  toc.open = false;
  events.get('popstate')!();
  assert.equal(toc.open, false, 'history updates must retain the user TOC state');
  assert.ok(!events.has('resize'), 'resizing must not overwrite the user TOC state');
});

test('graph enhancement failures keep a usable static fallback instead of a loading state', async () => {
  const script = await readFile(new URL('../web/graph.js', import.meta.url), 'utf8');
  const interactive = { hidden: true };
  const loading = { hidden: false, textContent: '' };
  const fallback = { open: true };
  const document = { getElementById: (id: string) => id === 'relation-bundle' ? { textContent: '{invalid' }
    : id === 'graph-interactive' ? interactive : id === 'graph-load-status' ? loading : id === 'graph-fallback' ? fallback : {} };
  runInNewContext(script, { document });
  assert.equal(interactive.hidden, true, 'a failed graph enhancement must retain the static view');
  assert.equal(fallback.open, true);
  assert.ok(loading.textContent.includes('選択表示を利用できません'), 'a graph parse failure must explain the unavailable selection view');
  const html = renderGraphPage('<html><head><title>関係</title></head><body><main>'
    + '<section class="graph-reading" aria-labelledby="concepts-title"><h2>知識</h2></section></main>'
    + '<script id="relation-bundle" type="application/json">{}</script></body></html>',
  { graph: { schema_version: 1, coverage: {}, nodes: [], edges: [] },
    vocabulary: { schema_version: 1, interpretation: {}, types: [] } });
  assert.ok(html.includes('id="graph-interactive" class="graph-layout" hidden'),
    'the initial HTML must expose only the usable static graph until enhancement succeeds');
  assert.ok(!html.includes('読み込んでいます'), 'unreachable scripts must not leave a perpetual loading message');
});
