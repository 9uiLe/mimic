import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = await readFile(path.join(root, 'knowledge/decision-material-selection.md'));
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : 'marked');
const run = args => spawnSync(process.execPath, [path.join(root, 'scripts/build-knowledge.mjs'), ...args], { encoding: 'utf8' });
const textContent = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name])
  .replace(/\s+/g, ' ').trim();
const meta = (html, name) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`))[1];
const sectionIds = html => [...html.matchAll(/<section id="([^"]+)"/g)].map(match => match[1]);
const frontmatter = text => text.toString().match(/^---\n[\s\S]*?\n---\n/)[0];

function assertAiContent(ai, source, aiPath, sourcePath) {
  assert.equal(frontmatter(ai), frontmatter(source), 'AI metadata must be preserved exactly');
  const semanticHtml = (text, file) => {
    const renderer = new marked.Renderer();
    renderer.link = function (token) {
      let href = token.href;
      if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#')) {
        const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/s);
        href = path.resolve(path.dirname(file), decodeURI(pathname)) + suffix;
      }
      return marked.Renderer.prototype.link.call(this, { ...token, href });
    };
    return marked.parse(text.toString().slice(frontmatter(text).length), { renderer });
  };
  assert.equal(semanticHtml(ai, aiPath), semanticHtml(source, sourcePath), 'AI must preserve every block and the resolved destinations of links');
}

async function assertRelatedFiles(ai, aiPath) {
  const links = [];
  marked.walkTokens(marked.lexer(ai.toString().slice(frontmatter(ai).length)), token => {
    if (token.type === 'link' && !/^[a-z][a-z\d+.-]*:/i.test(token.href) && !token.href.startsWith('#')) links.push(token.href);
  });
  assert.equal(links.length, 2);
  for (const href of links) assert.ok((await stat(path.resolve(path.dirname(aiPath), decodeURI(href)))).isFile());
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimic-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'knowledge/decision-material-selection.md');
  const out = path.join(directory, 'prototypes/decision-material-selection');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, original);
  for (const name of ['grouping.md', 'visual-hierarchy.md']) await writeFile(path.join(path.dirname(source), name), await readFile(path.join(root, 'knowledge', name)));
  const args = ['--source', source, '--out-dir', out];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  return { directory, source, out, args };
}

function assertAllContent(html, source) {
  const visible = textContent(html);
  const markdown = source.toString().replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space' || token.type === 'html') continue;
    const expected = textContent(marked.Parser.parse([token]));
    assert.ok(visible.includes(expected), `Missing source content: ${expected.slice(0, 120)}`);
  }
}

test('AI preserves all metadata and knowledge with working related links in both output locations; the offline human view retains every block and role', async t => {
  const { source, out, args } = await fixture(t);
  const aiPath = path.join(out, 'ai.md');
  const ai = await readFile(aiPath);
  assertAiContent(ai, original, aiPath, source);
  assert.match(ai.toString(), /\[グルーピング\]\(\.\.\/\.\.\/knowledge\/grouping\.md\)/);
  await assertRelatedFiles(ai, aiPath);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assertAllContent(html, original);
  assert.deepEqual(sectionIds(html), ['purpose', 'inputs', 'procedure', 'outputs', 'related', 'example', 'sources', 'unverified']);
  for (const note of ['proposal', 'assumption', 'limitation', 'evidence-scope']) assert.ok(html.includes(`class="note note-${note}"`));
  assert.equal(html.split('これは件数の絞り方を示す論理例です。').length - 1, 1);
  assert.match(html, /href="#outputs">判断案と選定理由へ/);
  assert.match(html, /href="#unverified">未検証事項を確認する/);
  assert.match(html, /href="\.\.\/\.\.\/knowledge\/grouping\.md"/);
  assert.match(html, /href="\.\.\/\.\.\/knowledge\/visual-hierarchy\.md"/);
  assert.match(html, /href="\.\.\/\.\.\/knowledge\/decision-material-selection\.md"/);
  assert.match(html, /href="ai\.md"/);
  assert.match(html, /<span class="badge">仮案<\/span>/);
  assert.match(html, /<dt>status<\/dt><dd>proposed<\/dd>/);
  assert.match(html, /source SHA-256/);
  assert.match(html, /stylesheet SHA-256/);
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<link[^>]+href=|@import|url\(|<!-- mimic:|example-phase/i);
  assert.equal(run([...args, '--check']).status, 0);
  assert.equal(run(args).status, 0);
  assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), html, 'Generation must be deterministic');
  const draftSource = path.join(out, 'draft.md');
  const draft = original.toString().replace('status: proposed', 'status: draft').replace('](grouping.md)', '](../../knowledge/grouping.md)').replace('](visual-hierarchy.md)', '](../../knowledge/visual-hierarchy.md)');
  const researchOut = path.join(out, 'research');
  await writeFile(draftSource, draft);
  const result = run(['--source', draftSource, '--out-dir', researchOut]);
  assert.equal(result.status, 0, result.stderr);
  const researchAiPath = path.join(researchOut, 'ai.md');
  const researchAi = await readFile(researchAiPath);
  assertAiContent(researchAi, draft, researchAiPath, draftSource);
  assert.match(researchAi.toString(), /\[グルーピング\]\(\.\.\/\.\.\/\.\.\/knowledge\/grouping\.md\)/);
  await assertRelatedFiles(researchAi, researchAiPath);
});

test('content, headings, candidate names, section order, and extra steps/examples change without changing design or section identities', async t => {
  const { source, out, args } = await fixture(t);
  const before = await readFile(path.join(out, 'index.html'), 'utf8');
  let changed = original.toString()
    .replace('## 目的と適用条件', '## 目的に応じて情報を選ぶ')
    .replace('### 8候補から表示案を作る', '### 提示候補を比べる')
    .replaceAll('仕事名', 'タスク名')
    .replace('<!-- mimic:note limitation -->', '7. 追加の手順は太字を必須にしない。\n\n<!-- mimic:note limitation -->')
    .replace('<!-- mimic:section sources -->', `<!-- mimic:heading another-example -->\n\n### 別の場面で使う例\n\n${'利用条件と不確かさを残した長い説明。'.repeat(80)}\n\n| 候補 | 採否 | 理由 |\n| --- | --- | --- |\n| 新しい候補 | 保留 | 条件未確認 |\n\n\`\`\`md\n[コードの参照](grouping.md)\n\`\`\`\n\n\`[コードの参照](grouping.md)\` と [実際の参照](grouping.md "補足")、**[強調内の参照](grouping.md)**。\n\n<!-- mimic:section sources -->`)
    .replace('status: proposed', 'status: draft');
  const related = changed.match(/<!-- mimic:section related -->[\s\S]*?(?=<!-- mimic:section example -->)/)[0];
  changed = changed.replace(related, '').replace('<!-- mimic:section purpose -->', `${related}<!-- mimic:section purpose -->`);
  await writeFile(source, changed);
  let result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const after = await readFile(path.join(out, 'index.html'), 'utf8');
  assertAllContent(after, changed);
  assert.deepEqual(sectionIds(after), sectionIds(before));
  for (const name of ['design-id', 'design-version', 'stylesheet-sha256']) assert.equal(meta(after, name), meta(before, name));
  assert.notEqual(meta(after, 'source-sha256'), meta(before, 'source-sha256'));
  assert.match(after, /<h3 id="example-options">提示候補を比べる<\/h3>/);
  assert.match(after, /<h3 id="another-example">別の場面で使う例<\/h3>/);
  assert.match(after, /追加の手順は太字を必須にしない。/);
  assert.match(after, /更新案（未採用）/);
  assert.match(after, /更新案の原文を読む/);
  const ai = await readFile(path.join(out, 'ai.md'));
  assertAiContent(ai, changed, path.join(out, 'ai.md'), source);
  assert.match(ai.toString(), /```md\n\[コードの参照\]\(grouping\.md\)\n```/);
  assert.ok(ai.toString().includes('`[コードの参照](grouping.md)`'));
  assert.match(ai.toString(), /\[実際の参照\]\(\.\.\/\.\.\/knowledge\/grouping\.md "補足"\)/);
  await writeFile(source, changed.replace('status: draft', 'status: awaiting_research'));
  result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /状態の意味は未確認（原値: awaiting_research）/);
});

test('check rejects source changes with an unchanged version and edits to either output', async t => {
  const { source, out, args } = await fixture(t);
  await writeFile(source, original.toString().replace('少ない項目数そのものを目標にしません。', '少ない項目数そのものを目標にしません。正本変更の検出。'));
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

test('unsupported metadata, HTML, or relative-link forms fail instead of losing source content', async t => {
  const { source, args } = await fixture(t);
  for (const [changed, message] of [
    [original.toString().replace('mimic:section purpose', 'mimic:section unknown'), /unknown section role unknown/],
    [original.toString().replace('mimic:section inputs', 'mimic:section purpose'), /duplicate section role purpose/],
    [original.toString().replace(/<!-- mimic:section related -->[\s\S]*?(?=<!-- mimic:section example -->)/, ''), /missing section role related/],
    [original.toString().replace('mimic:heading example-options', 'mimic:heading example-assumptions'), /duplicate or reserved heading ID/],
    [original.toString().replace('mimic:note proposal', 'mimic:note unknown'), /unknown note type unknown/],
    [`${original}\n<!-- mimic:note limitation -->\n`, /directive at the end has no content/],
    [`${original}\n<div>埋め込み内容<\/div>\n`, /unsupported HTML or directive/],
    [`${original}\n- [別資料](grouping.md)\n`, /relative links inside list are unsupported/],
    [`${original}\n[別資料][group]\n\n[group]: grouping.md\n`, /reference-style link definitions are unsupported/],
  ]) {
    await writeFile(source, changed);
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test('stylesheet and renderer/rule changes make the human output stale independently of unchanged knowledge bytes', async t => {
  const { directory, source, out } = await fixture(t);
  const script = path.join(directory, 'scripts/build-knowledge.mjs');
  const cssPath = path.join(directory, 'scripts/knowledge-view.css');
  await mkdir(path.dirname(script), { recursive: true });
  const generator = await readFile(path.join(root, 'scripts/build-knowledge.mjs'), 'utf8');
  const stylesheet = await readFile(path.join(root, 'scripts/knowledge-view.css'), 'utf8');
  await writeFile(script, generator);
  await writeFile(cssPath, stylesheet);
  const args = [script, '--source', source, '--out-dir', out];
  const execute = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
  assert.equal(execute([]).status, 0);
  assert.equal(execute(['--check']).status, 0);
  const originalAi = await readFile(path.join(out, 'ai.md'));
  for (const [file, changed] of [
    [cssPath, stylesheet.replace('--paper:#f6f5ef', '--paper:#ffffff')],
    [script, generator.replace("outputs: '判断案と選定理由'", "outputs: '判断案と理由'")],
  ]) {
    await writeFile(file, changed);
    const result = execute(['--check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale or missing: index\.html/);
    assert.deepEqual(await readFile(path.join(out, 'ai.md')), originalAi);
    assert.equal(execute([]).status, 0);
    assert.equal(execute(['--check']).status, 0);
  }
});
