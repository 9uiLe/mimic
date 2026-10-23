import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'bun:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = await readFile(path.join(root, 'topics/decision-material-selection.md'));
const original = await readFile(path.join(root, 'tests/fixtures/knowledge-display.md'), 'utf8');
const markedModule = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
const { marked } = await import(markedModule) as typeof import('marked');
const run = (args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts/build-knowledge.ts'), ...args], { encoding: 'utf8' });
const textContent = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => {
    const entity = ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" } as Record<string, string>)[name];
    assert.ok(entity !== undefined, `Unknown HTML entity: ${name}`);
    return entity;
  })
  .replace(/\s+/g, ' ').trim();
const meta = (html: string, name: string) => {
  const match = html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`));
  assert.ok(match && match[1] !== undefined, `Missing metadata: ${name}`);
  return match[1];
};
const sectionIds = (html: string) => [...html.matchAll(/<section id="([^"]+)"/g)].map(match => {
  assert.ok(match[1] !== undefined);
  return match[1];
});
type Markdown = string | Buffer;
const frontmatter = (text: Markdown) => {
  const match = text.toString().match(/^---\n[\s\S]*?\n---\n/);
  assert.ok(match, 'Markdown must include frontmatter');
  return match[0];
};

function assertAiContent(ai: Markdown, source: Markdown, aiPath: string, sourcePath: string) {
  assert.equal(frontmatter(ai), frontmatter(source), 'AI metadata must be preserved exactly');
  const semanticHtml = (text: Markdown, file: string) => {
    const renderer = new marked.Renderer();
    renderer.link = function (token) {
      let href = token.href;
      if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#')) {
        const match = href.match(/^([^?#]*)(.*)$/s);
        assert.ok(match && match[1] !== undefined && match[2] !== undefined);
        const pathname = match[1];
        const suffix = match[2];
        href = path.resolve(path.dirname(file), decodeURI(pathname)) + suffix;
      }
      return marked.Renderer.prototype.link.call(this, { ...token, href });
    };
    return marked.parse(text.toString().slice(frontmatter(text).length), { renderer });
  };
  assert.equal(semanticHtml(ai, aiPath), semanticHtml(source, sourcePath), 'AI must preserve every block and the resolved destinations of links');
}

async function assertRelatedFiles(ai: Markdown, aiPath: string) {
  const links: string[] = [];
  marked.walkTokens(marked.lexer(ai.toString().slice(frontmatter(ai).length)), token => {
    if (token.type === 'link' && !/^[a-z][a-z\d+.-]*:/i.test(token.href) && !token.href.startsWith('#')) links.push(token.href);
  });
  assert.ok(links.length >= 2);
  for (const href of links) assert.ok((await stat(path.resolve(path.dirname(aiPath), decodeURI(href.split(/[?#]/)[0]!)))).isFile());
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(input: Markdown = original, relativeSource = 'topics/decision-material-selection.md') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimic-knowledge-'));
  temporaryDirectories.push(directory);
  const source = path.join(directory, relativeSource);
  const out = path.join(directory, 'prototypes/decision-material-selection');
  await cp(path.join(root, 'knowledge'), path.join(directory, 'knowledge'), { recursive: true });
  await cp(path.join(root, 'topics'), path.join(directory, 'topics'), { recursive: true });
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, input);
  const args = ['--source', source, '--out-dir', out];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  return { directory, source, out, args };
}

function assertAllContent(html: string, source: Markdown) {
  const visible = textContent(html);
  const markdown = source.toString().replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space' || token.type === 'html') continue;
    const expected = textContent(marked.Parser.parse([token]));
    assert.ok(visible.includes(expected), `Missing source content: ${expected.slice(0, 120)}`);
  }
}

test('AI preserves all metadata and knowledge with working related links in both output locations; the offline human view retains every block and role', async () => {
  const { source, out, args } = await fixture();
  const aiPath = path.join(out, 'ai.md');
  const ai = await readFile(aiPath);
  assertAiContent(ai, original, aiPath, source);
  assert.match(ai.toString(), /\[グルーピング\]\(\.\.\/\.\.\/knowledge\/grouping\/KNOWLEDGE\.md\)/);
  await assertRelatedFiles(ai, aiPath);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assertAllContent(html, original);
  assert.deepEqual(sectionIds(html), ['purpose', 'inputs', 'procedure', 'outputs', 'related', 'example', 'sources', 'unverified']);
  for (const note of ['proposal', 'assumption', 'limitation', 'evidence-scope']) assert.ok(html.includes(`class="note note-${note}"`));
  assert.equal(html.split('この文書は生成器の表示とリンクを検査するためだけの架空資料です。').length - 1, 1);
  assert.match(html, /href="#outputs">判断案と選定理由へ/);
  assert.match(html, /href="#unverified">未検証事項を確認する/);
  assert.match(html, /href="\.\.\/\.\.\/knowledge\/grouping\/KNOWLEDGE\.md"/);
  assert.match(html, /href="\.\.\/\.\.\/knowledge\/visual-hierarchy\/KNOWLEDGE\.md"/);
  assert.match(html, /href="\.\.\/\.\.\/topics\/decision-material-selection\.md"/);
  assert.match(html, /href="ai\.md"/);
  assert.match(html, /<p class="meta">v0\.1\.0<\/p>/);
  assert.match(html, /<dt>version<\/dt><dd>0\.1\.0<\/dd>/);
  assert.doesNotMatch(html, /<dt>status<\/dt>|<span class="badge">/);
  assert.match(html, /source SHA-256/);
  assert.match(html, /stylesheet SHA-256/);
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<link[^>]+href=|@import|url\(|<!-- mimic:|example-phase/i);
  assert.equal(run([...args, '--check']).status, 0);
  assert.equal(run(args).status, 0);
  assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), html, 'Generation must be deterministic');
  const nestedSource = path.join(out, 'nested.md');
  const nested = original.toString().replaceAll('](../knowledge/', '](../../knowledge/').replace('](decision-material-selection.md)', '](../../topics/decision-material-selection.md)');
  const nestedOut = path.join(out, 'nested');
  await writeFile(nestedSource, nested);
  const result = run(['--source', nestedSource, '--out-dir', nestedOut]);
  assert.equal(result.status, 0, result.stderr);
  const nestedAiPath = path.join(nestedOut, 'ai.md');
  const nestedAi = await readFile(nestedAiPath);
  assertAiContent(nestedAi, nested, nestedAiPath, nestedSource);
  assert.match(nestedAi.toString(), /\[グルーピング\]\(\.\.\/\.\.\/\.\.\/knowledge\/grouping\/KNOWLEDGE\.md\)/);
  await assertRelatedFiles(nestedAi, nestedAiPath);
});

test('conceptual knowledge keeps its original chapters and all source content without adding procedure roles', async () => {
  const { source, out, args } = await fixture(canonical);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const aiPath = path.join(out, 'ai.md');
  assertAllContent(html, canonical);
  assertAiContent(await readFile(aiPath), canonical, aiPath, source);
  await assertRelatedFiles(await readFile(aiPath), aiPath);
  const headings = marked.lexer(canonical.toString().slice(frontmatter(canonical).length))
    .filter((token): token is import('marked').Tokens.Heading => token.type === 'heading' && token.depth === 2);
  assert.equal(sectionIds(html).length, headings.length);
  const navigation = html.match(/<nav aria-label="目次">([\s\S]*?)<\/nav>/)![1]!;
  for (const heading of headings) assert.ok(textContent(navigation).includes(heading.text));
  assert.doesNotMatch(html, /data-section-role=|class="steps"|id="view-actions"|判断の進め方へ|未検証事項を確認する/);
  assert.match(html, /href="ai\.md">案内のMarkdown/);
  assert.match(html, /リンク先の概念・出典・例は取り込まない/);
  assert.doesNotMatch(html, /AI 向け全文/);
  for (const id of sectionIds(html)) assert.ok(html.includes(`href="#${id}"`));
  assert.equal(run([...args, '--check']).status, 0);
  assert.equal(run(args).status, 0);
  assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), html);
  const extended = `${canonical}\n## 補足\n\n### 同じ見出し\n\n1. 一つ目の説明。\n\n### 同じ見出し\n\n| 観点 | 説明 |\n| --- | --- |\n| 範囲 | 概念を補足する |\n`;
  await writeFile(source, extended);
  assert.equal(run(args).status, 0);
  const extendedHtml = await readFile(path.join(out, 'index.html'), 'utf8');
  assertAllContent(extendedHtml, extended);
  assert.match(extendedHtml, /<h3 id="同じ見出し">/);
  assert.match(extendedHtml, /<h3 id="同じ見出し-2">/);
  assert.doesNotMatch(extendedHtml, /class="steps"/);
  assertAiContent(await readFile(aiPath), extended, aiPath, source);
  for (const extra of ['<script>unsafe()</script>', '![external](https://example.test/image.png)', '[unsafe](javascript:alert)']) {
    await writeFile(source, `${canonical}\n${extra}\n`);
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported/);
  }
});

test('knowledge reader preserves version and provenance while AI output preserves canonical metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimic-knowledge-metadata-'));
  temporaryDirectories.push(directory);
  const source = path.join(directory, 'knowledge/metadata-fixture/KNOWLEDGE.md');
  const out = path.join(directory, 'preview');
  const canonicalSource = `---
id: metadata-fixture
title: 版と出典の表示例
version: "1.0.0"
scope: metadata-display
related:
---

# 版と出典の表示例

## 説明

版と編集元の対応を確認するための架空の文書です。
`;
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, canonicalSource);
  const result = run(['--source', source, '--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<p class="meta">v1\.0\.0<\/p>/, 'reader must show the source version');
  assert.match(html, /<dt>version<\/dt><dd>1\.0\.0<\/dd>/, 'human output must preserve source version');
  assert.match(html, /<dt>scope<\/dt><dd>metadata-display<\/dd>/, 'human output must preserve source scope');
  assert.match(html, /<dt>source<\/dt><dd>/, 'human output must identify the source');
  assert.doesNotMatch(html, /<dt>status<\/dt>|<span class="badge">/);
  assert.equal(await readFile(path.join(out, 'ai.md'), 'utf8'), canonicalSource, 'AI output must preserve the canonical source exactly');
  await writeFile(source, canonicalSource.replace('version: "1.0.0"', 'status: accepted\nversion: "1.0.0"'));
  const unsupported = run(['--source', source, '--out-dir', out]);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported or duplicate frontmatter: status: accepted/, 'the removed field must be rejected');
});

test('each concept has a matching fixed entry, resolvable support links, and metadata preserved by generation', async () => {
  const concepts = (await readdir(path.join(root, 'knowledge'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(concepts, [
    'aesthetic-and-minimalist-design', 'ai-slop', 'alignment-and-grids', 'color-context', 'color-contrast',
    'conceptual-models', 'design-systems', 'design-tokens', 'ecological-interface-design', 'external-representations',
    'goal-directed-design', 'grouping', 'human-centered-design', 'information-architecture', 'interaction-design', 'layout-spacing',
    'lightness-and-luminance', 'reflective-conversation', 'scenario-based-design', 'sketches-and-prototypes', 'typography', 'usability-testing', 'user-journeys', 'visual-hierarchy',
  ]);
  for (const id of concepts) {
    const relativeSource = `knowledge/${id}/KNOWLEDGE.md`;
    const entry = await readFile(path.join(root, relativeSource));
    assert.match(entry.toString(), new RegExp(`^id: ${id}$`, 'm'), `${id}: entry id must match concept directory`);
    assert.doesNotMatch(frontmatter(entry), /^related:/m, `${id}: concept relations belong to the graph`);
    const { source, out, args } = await fixture(entry, relativeSource);
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assertAllContent(html, entry);
    assert.match(html, /href="ai\.md">本文のMarkdown/);
    const aiPath = path.join(out, 'ai.md');
    assertAiContent(await readFile(aiPath), entry, aiPath, source);
    await assertRelatedFiles(await readFile(aiPath), aiPath);
    for (const [metadataId, message] of [['another-concept', /directory and id must match/], ['../escape', /invalid knowledge id/]] as const) {
      await writeFile(source, entry.toString().replace(`id: ${id}`, `id: ${metadataId}`));
      const result = run(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
  }
});

test('content, headings, candidate names, section order, and extra steps/examples change without changing design or section identities', async () => {
  const { source, out, args } = await fixture();
  const before = await readFile(path.join(out, 'index.html'), 'utf8');
  let changed = original.toString()
    .replace('## 表示の目的', '## 変更した目的')
    .replace('### 別の表示', '### 変更した表示')
    .replaceAll('項目 B', '項目 C')
    .replace('<!-- mimic:note limitation -->', '7. 追加の手順は太字を必須にしない。\n\n<!-- mimic:note limitation -->')
    .replace('<!-- mimic:section sources -->', `<!-- mimic:heading another-example -->

### 別の場面で使う例

${'利用条件と不確かさを残した長い説明。'.repeat(80)}

| 候補 | 採否 | 理由 |
| --- | --- | --- |
| 新しい候補 | 保留 | 条件未確認 |

\`\`\`md
[コードの参照](grouping.md)
\`\`\`

\`[コードの参照](grouping.md)\` と [実際の参照](../knowledge/grouping/KNOWLEDGE.md "補足")、
**[強調内の参照](../knowledge/grouping/KNOWLEDGE.md)**。

<!-- mimic:section sources -->`);
  const relatedMatch = changed.match(/<!-- mimic:section related -->[\s\S]*?(?=<!-- mimic:section example -->)/);
  assert.ok(relatedMatch, 'Fixture must contain the related section');
  const related = relatedMatch[0];
  changed = changed.replace(related, '').replace('<!-- mimic:section purpose -->', `${related}<!-- mimic:section purpose -->`);
  await writeFile(source, changed);
  let result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const after = await readFile(path.join(out, 'index.html'), 'utf8');
  assertAllContent(after, changed);
  assert.deepEqual(sectionIds(after), sectionIds(before));
  for (const name of ['design-id', 'design-version', 'stylesheet-sha256']) assert.equal(meta(after, name), meta(before, name));
  assert.notEqual(meta(after, 'source-sha256'), meta(before, 'source-sha256'));
  assert.match(after, /<h3 id="example-alternatives">変更した表示<\/h3>/);
  assert.match(after, /<h3 id="another-example">別の場面で使う例<\/h3>/);
  assert.match(after, /追加の手順は太字を必須にしない。/);
  assert.match(after, /案内の原文を読む/);
  const ai = await readFile(path.join(out, 'ai.md'));
  assertAiContent(ai, changed, path.join(out, 'ai.md'), source);
  assert.match(ai.toString(), /```md\n\[コードの参照\]\(grouping\.md\)\n```/);
  assert.ok(ai.toString().includes('`[コードの参照](grouping.md)`'));
  assert.match(ai.toString(), /\[実際の参照\]\(\.\.\/\.\.\/knowledge\/grouping\/KNOWLEDGE\.md "補足"\)/);
});

test('check rejects source changes with an unchanged version and edits to either output', async () => {
  const { source, out, args } = await fixture();
  await writeFile(source, original.toString().replace('架空資料です。', '架空資料です。変更検出用の文です。'));
  let result = run([...args, '--check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ai\.md, index\.html/);
  await writeFile(source, original);
  for (const name of ['ai.md', 'index.html']) {
    assert.equal(run(args).status, 0);
    const file = path.join(out, name);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\nmanual edit\n')]));
    result = run([...args, '--check']);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(name));
  }
});

test('unsupported metadata, HTML, or relative-link forms fail instead of losing source content', async () => {
  const { source, args } = await fixture();
  const unsupportedCases: [string, RegExp][] = [
    [original.toString().replace('mimic:section purpose', 'mimic:section unknown'), /unknown section role unknown/],
    [original.toString().replace('mimic:section inputs', 'mimic:section purpose'), /duplicate section role purpose/],
    [original.toString().replace(/<!-- mimic:section related -->[\s\S]*?(?=<!-- mimic:section example -->)/, ''), /missing section role related/],
    [original.toString().replace('mimic:heading example-alternatives', 'mimic:heading example-assumptions'), /duplicate or reserved heading ID/],
    [original.toString().replace('mimic:note proposal', 'mimic:note unknown'), /unknown note type unknown/],
    [`${original}\n<!-- mimic:note limitation -->\n`, /directive at the end has no content/],
    [`${original}\n<div>埋め込み内容<\/div>\n`, /unsupported HTML or directive/],
    [`${original}\n- [別資料](grouping.md)\n`, /relative links inside list are unsupported/],
    [`${original}\n[別資料][group]\n\n[group]: grouping.md\n`, /reference-style link definitions are unsupported/],
  ];
  for (const [changed, message] of unsupportedCases) {
    await writeFile(source, changed);
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test('stylesheet and renderer/rule changes make the human output stale independently of unchanged knowledge bytes', async () => {
  const { directory, source, out } = await fixture();
  const script = path.join(directory, 'scripts/build-knowledge.ts');
  const linkModulePath = path.join(directory, 'scripts/knowledge-paths.ts');
  const cssPath = path.join(directory, 'scripts/knowledge-view.css');
  await mkdir(path.dirname(script), { recursive: true });
  const generator = await readFile(path.join(root, 'scripts/build-knowledge.ts'), 'utf8');
  const linkModule = await readFile(path.join(root, 'scripts/knowledge-paths.ts'), 'utf8');
  const stylesheet = await readFile(path.join(root, 'scripts/knowledge-view.css'), 'utf8');
  await writeFile(script, generator);
  await writeFile(linkModulePath, linkModule);
  await writeFile(path.join(directory, 'scripts/pages-catalog.ts'), await readFile(path.join(root, 'scripts/pages-catalog.ts')));
  await writeFile(path.join(directory, 'scripts/pages-fonts.ts'), await readFile(path.join(root, 'scripts/pages-fonts.ts')));
  await writeFile(path.join(directory, 'scripts/knowledge-images.ts'), await readFile(path.join(root, 'scripts/knowledge-images.ts')));
  await writeFile(cssPath, stylesheet);
  const args = [script, '--source', source, '--out-dir', out, '--marked-module', fileURLToPath(markedModule)];
  const execute = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
  const generated = execute([]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(execute(['--check']).status, 0);
  const originalAi = await readFile(path.join(out, 'ai.md'));
  const changedInputs: [string, string][] = [
    [cssPath, stylesheet.replace('--palette-neutral-0:#ffffff', '--palette-neutral-0:#fefefe')],
    [script, generator.replace("outputs: '判断案と選定理由'", "outputs: '判断案と理由'")],
    [linkModulePath, linkModule.replace('path.relative(fromDirectory, targetPath)', 'path.posix.relative(fromDirectory, targetPath)')],
  ];
  for (const [file, changed] of changedInputs) {
    await writeFile(file, changed);
    const result = execute(['--check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale or missing: index\.html/);
    assert.deepEqual(await readFile(path.join(out, 'ai.md')), originalAi);
    assert.equal(execute([]).status, 0);
    assert.equal(execute(['--check']).status, 0);
  }
});
