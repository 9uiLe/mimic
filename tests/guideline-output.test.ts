import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'bun:test';
import { renderGuideline } from '../scripts/build-guideline.ts';

const stylesheet = await readFile(new URL('../scripts/knowledge-view.css', import.meta.url));
const source = `# ガイドの例

導入の説明。

## 判断の前に

[AI向け](ai.md)と[人向け](README.md)を使います。

[研究案](../prototypes/decision-material-selection/research/)と[正本](../knowledge/grouping.md)も参照します。

### 条件を確かめる

1. 目的を読む。
2. 条件を読む。

| 条件 | 扱い |
| --- | --- |
| 未確認 | 保留 |

\`<script>文字として読む</script>\`

## 判断の前に

同じ見出しも区別します。
`;

test('guideline HTML keeps the document content, gives sections distinct anchors, and maps document links to their HTML views', async () => {
  const html = (await renderGuideline(Buffer.from(source), 'guideline/README.md', stylesheet)).toString('utf8');
  assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1);
  assert.match(html, /<h1 id="title">ガイドの例<\/h1>/);
  for (const id of ['判断の前に', '判断の前に-2', '条件を確かめる']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /href="#判断の前に-2"/);
  assert.match(html, /href="ai.html">AI向け/);
  assert.match(html, /href="index.html">人向け/);
  assert.match(html, /href="\.\.\/prototypes\/decision-material-selection\/research\/">研究案/);
  assert.match(html, /href="\.\.\/knowledge\/grouping.md">正本/);
  assert.match(html, /<ol>\s*<li>目的を読む。<\/li>\s*<li>条件を読む。<\/li>\s*<\/ol>/);
  assert.match(html, /class="table-scroll" tabindex="0" role="region"/);
  assert.match(html, /<td>保留<\/td>/);
  assert.match(html, /<code>&lt;script&gt;文字として読む&lt;\/script&gt;<\/code>/);
  assert.ok(html.includes(stylesheet.toString('utf8')));
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script|<img|<link\b/i);
});

test('guideline rendering rejects embedded content, unsafe links, and ambiguous document titles', async () => {
  const badBodies = [
    '<script>alert(1)</script>',
    '<span>埋め込みHTML</span>',
    '![外部画像](https://example.test/image.png)',
    '[危険](javascript:alert(1))',
    '[危険](data:text/html,example)',
    '[外部のような相対参照](//example.test/)',
    '[絶対パス](/guideline/)',
    '[範囲外](../../private.md)',
    '# 追加の題名',
  ];
  for (const body of badBodies) {
    await assert.rejects(renderGuideline(Buffer.from(`# 題名\n\n## 本文\n\n${body}\n`), 'guideline/ai.md', stylesheet), /Guideline source:/, body);
  }
  await assert.rejects(renderGuideline(Buffer.from('## 題名なし\n\n本文\n'), 'guideline/ai.md', stylesheet), /H1 title/);
});
