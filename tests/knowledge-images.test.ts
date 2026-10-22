import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'bun:test';
import { renderDocument } from '../scripts/build-guideline.ts';
import { makeAiMarkdown, renderKnowledge } from '../scripts/build-knowledge.ts';
import { approvedImage, renderImage, validateFigure } from '../scripts/knowledge-images.ts';
import { pageFontHead } from '../scripts/pages-fonts.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = 'knowledge/alignment-and-grids/examples/alignment.md';
const figure = 'knowledge/alignment-and-grids/examples/alignment.svg';
const sourcePath = path.join(root, 'knowledge/alignment-and-grids/KNOWLEDGE.md');
const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
const { marked } = await import(markedUrl) as typeof import('marked');
const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 450"><title>説明図</title><rect width="100" height="100" fill="#fff"/></svg>';
const canonical = `---
id: alignment-and-grids
title: 整列とグリッド
version: "1.0.0"
scope: 説明図の参照
related:
---
# 整列とグリッド

## 説明例

![基準線が別々の配置と共通の列に整列した配置](examples/alignment.svg)

[原寸の図](examples/alignment.svg)。
`;

test('reviewed static SVG validates while executable, external, malformed, and unlisted figures reject', () => {
  assert.doesNotThrow(() => validateFigure(figure, Buffer.from(validSvg)));
  assert.doesNotThrow(() => validateFigure(figure, Buffer.from(validSvg.replace('viewBox="0 0 1100 450"', 'width="1100" height="450"'))));
  for (const svg of [
    validSvg.replace('<rect ', '<script '),
    validSvg.replace('<rect ', '<foreignObject '),
    validSvg.replace('<rect ', '<image href="https://example.test/image.svg" '),
    validSvg.replace('fill="#fff"', 'fill="url(https://example.test/image.svg)"'),
    validSvg.replace('fill="#fff"', 'onclick="alert(1)"'),
    validSvg.replace('viewBox="0 0 1100 450"', 'viewBox="0 0 0 450"'),
    validSvg.replace('</svg>', '</g>'),
    `${validSvg}${validSvg}`,
    '<!DOCTYPE svg [<!ENTITY remote SYSTEM "https://example.test/">]>' + validSvg,
  ]) assert.throws(() => validateFigure(figure, Buffer.from(svg)), /static SVG/, 'unsafe static SVG must reject');
  for (const control of ['\u0000', '\u0001', '\u000b', '\ufffe']) {
    assert.throws(() => validateFigure(figure, Buffer.from(validSvg.replace('説明図', `説明${control}図`))),
      /static SVG/, 'invalid XML characters must reject');
    assert.throws(() => validateFigure(figure, Buffer.from(`<?xml version="1.0"?>${control}${validSvg}`)),
      /static SVG/, 'invalid XML characters must reject');
    assert.throws(() => validateFigure(figure, Buffer.from(validSvg.replace('fill="#fff"', `fill="#fff${control}"`))),
      /static SVG/, 'invalid XML characters must reject');
  }
  assert.throws(() => validateFigure('knowledge/grouping/examples/unknown.svg', Buffer.from(validSvg)), /static SVG/);
  assert.throws(() => validateFigure(figure, Buffer.from([255])), /UTF-8/i);
});

test('only reviewed inline image destinations render with escaped alt text and output-relative sources', async () => {
  const html = renderImage('alignment.svg', sourceFile, 'preview/example.html', '![左右の比較](alignment.svg)', '左右の比較', '原寸 "図"');
  assert.equal(html, '<img src="../knowledge/alignment-and-grids/examples/alignment.svg" alt="左右の比較" title="原寸 &quot;図&quot;">',
    'image src must preserve the reviewed source from the output location');
  const document = Buffer.from('# 図の説明\n\n## 比較\n\n![左右の比較](alignment.svg)\n\n[原寸の図](alignment.svg)\n');
  const rendered = (await renderDocument(document, Buffer.from('article img { max-width:100%; height:auto; }'), {
    sourceFile, outFile: sourceFile.replace('.md', '.html'), views: {},
  })).toString('utf8');
  assert.ok(rendered.includes('<img src="alignment.svg" alt="左右の比較">'), 'example reader must embed the reviewed SVG');
  assert.ok(rendered.includes('href="alignment.svg"'), 'example reader must retain the full-size link');
  const knowledge = (await renderKnowledge(Buffer.from(canonical), 'knowledge/alignment-and-grids/KNOWLEDGE.md', Buffer.alloc(0), {
    'knowledge/alignment-and-grids/KNOWLEDGE.md': 'knowledge/alignment-and-grids/index.html',
  })).toString('utf8');
  assert.ok(knowledge.includes('src="examples/alignment.svg"'), 'knowledge reader must resolve the same approved figure');
  for (const href of ['https://example.test/alignment.svg', '//example.test/alignment.svg', '/alignment.svg',
    'data:image/svg+xml,example', '../examples/alignment.svg', 'alignment.svg#fragment', 'alignment.png', 'unknown.svg']) {
    assert.throws(() => approvedImage(href, sourceFile, `![図](${href})`, '図'), /image/, 'unreviewed image destinations must reject');
  }
  assert.throws(() => approvedImage('alignment.svg', 'tests/fixtures/arbitrary.md', '![図](alignment.svg)', '図'), /image/);
  assert.throws(() => approvedImage('alignment.svg', sourceFile, '![図][figure]', '図'), /image/);
  assert.throws(() => approvedImage('alignment.svg', sourceFile, '![](alignment.svg)', ''), /image/);
  await assert.rejects(renderDocument(Buffer.from('# 図\n\n<svg></svg>\n'), Buffer.alloc(0), {
    sourceFile, outFile: 'preview/example.html', views: {},
  }), /unsupported html/);
});

test('AI Markdown preserves approved inline image source and all other bytes at both output locations', () => {
  for (const [outDir, expected] of [
    [path.join(root, 'output/figure-preview'), '../../knowledge/alignment-and-grids/examples/alignment.svg'],
    [path.join(root, 'output/deep/figure-preview'), '../../../knowledge/alignment-and-grids/examples/alignment.svg'],
  ]) {
    const actual = makeAiMarkdown(Buffer.from(canonical), marked, sourcePath, outDir!).toString('utf8');
    assert.equal(actual, canonical.replaceAll('examples/alignment.svg', expected!), 'AI image must preserve source bytes except the destination');
  }
  const reference = canonical.replace('![基準線が別々の配置と共通の列に整列した配置](examples/alignment.svg)', '![図][figure]')
    + '\n[figure]: examples/alignment.svg\n';
  assert.throws(() => makeAiMarkdown(Buffer.from(reference), marked, sourcePath, path.join(root, 'output/preview')), /unsupported/);
});

test('image CSP permits same-origin figures in Pages and local previews without external images', () => {
  for (const pages of [false, true]) {
    const head = pageFontHead('knowledge/alignment-and-grids/index.html', pages);
    assert.ok(head.includes("img-src 'self';"), 'image CSP must permit the same-origin reviewed figures');
    assert.ok(head.includes("default-src 'none';"));
    assert.ok(!head.includes('img-src *') && !head.includes('img-src https:'));
  }
});
