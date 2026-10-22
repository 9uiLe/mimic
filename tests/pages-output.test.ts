import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'bun:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPages } from '../scripts/build-pages.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : 'marked') as typeof import('marked');
const expectedFiles = [
  '.nojekyll',
  'guideline/README.md',
  'guideline/ai.html',
  'guideline/ai.md',
  'guideline/index.html',
  'index.html',
  'knowledge/conceptual-models/KNOWLEDGE.md',
  'knowledge/conceptual-models/references/sources.md',
  'knowledge/decision-material-selection.md',
  'knowledge/ecological-interface-design/KNOWLEDGE.md',
  'knowledge/ecological-interface-design/references/sources.md',
  'knowledge/external-representations/KNOWLEDGE.md',
  'knowledge/external-representations/examples/temperature.md',
  'knowledge/external-representations/references/sources.md',
  'knowledge/grouping.md',
  'knowledge/grouping/KNOWLEDGE.md',
  'knowledge/grouping/examples/schedule.md',
  'knowledge/grouping/references/sources.md',
  'knowledge/visual-hierarchy.md',
  'knowledge/visual-hierarchy/KNOWLEDGE.md',
  'knowledge/visual-hierarchy/examples/schedule.md',
  'knowledge/visual-hierarchy/references/sources.md',
  'prototypes/decision-material-selection/ai.md',
  'prototypes/decision-material-selection/draft.md',
  'prototypes/decision-material-selection/index.html',
  'prototypes/decision-material-selection/research/ai.md',
  'prototypes/decision-material-selection/research/index.html',
  'topics/decision-material-selection.md',
];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const movedPages = ['knowledge/decision-material-selection.md', 'knowledge/grouping.md', 'knowledge/visual-hierarchy.md'];
const generatedPages = ['index.html', '.nojekyll', 'guideline/index.html', 'guideline/ai.html', ...movedPages];

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimic-pages-'));
  temporaryDirectories.push(directory);
  return { directory, out: path.join(directory, '_site') };
}

async function isolatedBuilder(directory: string) {
  const inputs = ['scripts/build-pages.ts', 'scripts/build-guideline.ts', 'scripts/knowledge-view.css', ...expectedFiles.filter(file => !generatedPages.includes(file))];
  for (const file of inputs) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
  await mkdir(path.join(directory, 'node_modules'));
  await symlink(path.resolve(path.dirname(fileURLToPath(markedUrl)), '..'), path.join(directory, 'node_modules/marked'));
  return import(pathToFileURL(path.join(directory, 'scripts/build-pages.ts')).href) as Promise<typeof import('../scripts/build-pages.ts')>;
}

async function filesIn(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const file = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(path.join(directory, name));
    assert.ok(!info.isSymbolicLink());
    if (info.isDirectory()) files.push(...await filesIn(path.join(directory, name), file));
    else files.push(file);
  }
  return files.sort();
}

test('Pages contains exactly the reviewed files and repeated builds preserve their bytes', async () => {
  const { out } = await fixture();
  assert.deepEqual(await buildPages(out), expectedFiles);
  assert.deepEqual(await filesIn(out), expectedFiles);
  const before = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  await buildPages(out);
  const after = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  assert.deepEqual(after, before);
  assert.equal((await readFile(path.join(out, '.nojekyll'))).length, 0);
  const entry = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(entry, /content="0; url=prototypes\/decision-material-selection\/"/);
  assert.match(entry, /採用状態は本文を確認/);
  assert.doesNotMatch(entry, /research\//);
  assert.ok(expectedFiles.every(file => !/\.pdf$|^output\/|^\.agents\/|^\.git\/|^README\.md$|(?:^|\/)logs?(?:\/|$)|\.log$/i.test(file)));
});

test('every local HTML and Markdown link resolves inside the artifact at the GitHub project prefix', async () => {
  const { out } = await fixture();
  await buildPages(out);
  const prefix = 'https://example.test/mimic/';
  for (const file of expectedFiles.filter(file => /\.(html|md)$/.test(file))) {
    const text = await readFile(path.join(out, file), 'utf8');
    const links: string[] = [];
    if (file.endsWith('.html')) {
      links.push(...[...text.matchAll(/href="([^"]*)"/g)].map(match => {
        assert.ok(match[1] !== undefined);
        return match[1];
      }));
    } else {
      marked.walkTokens(marked.lexer(text.replace(/^---\n[\s\S]*?\n---\n/, '')), token => {
        if (token.type === 'link') links.push(token.href);
      });
    }
    for (const href of links) {
      if (/^https?:\/\//i.test(href)) continue;
      assert.ok(!href.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(href), `${file}: unsupported local link ${href}`);
      const resolved = new URL(href.replaceAll('&amp;', '&'), new URL(file, prefix));
      assert.ok(resolved.href.startsWith(prefix), `${file}: link escapes /mimic/: ${href}`);
      let target = decodeURIComponent(resolved.pathname.slice('/mimic/'.length));
      if (target.endsWith('/')) target += 'index.html';
      assert.ok(expectedFiles.includes(target), `${file}: unpublished target ${href}`);
      assert.ok((await lstat(path.join(out, target))).isFile());
      if (resolved.hash && target.endsWith('.html')) {
        const html = await readFile(path.join(out, target), 'utf8');
        assert.ok(html.includes(`id="${decodeURIComponent(resolved.hash.slice(1))}"`), `${file}: missing anchor ${href}`);
      }
    }
  }
});

test('artifact copies match their generated or canonical sources and retain repository-relative provenance', async () => {
  const { out } = await fixture();
  await buildPages(out);
  for (const file of expectedFiles.filter(file => !generatedPages.includes(file))) {
    assert.deepEqual(await readFile(path.join(out, file)), await readFile(path.join(root, file)), file);
  }
  const provenanceCases: [string, string, string][] = [
    ['prototypes/decision-material-selection/index.html', 'topics/decision-material-selection.md', 'accepted'],
    ['prototypes/decision-material-selection/research/index.html', 'prototypes/decision-material-selection/draft.md', 'draft'],
  ];
  for (const [htmlFile, sourceFile, status] of provenanceCases) {
    const html = await readFile(path.join(out, htmlFile), 'utf8');
    const source = await readFile(path.join(root, sourceFile));
    assert.ok(html.includes(`<dt>source</dt><dd>${sourceFile}</dd>`));
    assert.ok(html.includes(`<meta name="source-sha256" content="${hash(source)}">`));
    assert.ok(html.includes(`<dt>status</dt><dd>${status}</dd>`));
    assert.doesNotMatch(html, /\/Users\/|\/home\/runner\/|KNOWLEDGE \/ LOCAL VIEW/);
  }
});

test('invalid guideline input leaves all existing Pages output untouched', async () => {
  const { directory, out } = await fixture();
  const isolated = await isolatedBuilder(directory);
  await isolated.buildPages(out);
  const before = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  await writeFile(path.join(directory, 'guideline/ai.md'), '# AI向けガイド\n\n## 本文\n\n<script>外部コード</script>\n');
  await assert.rejects(isolated.buildPages(out), /Guideline source: unsupported html/);
  assert.deepEqual(await Promise.all(expectedFiles.map(file => readFile(path.join(out, file)))), before);
});

test('old Markdown URLs become generated navigation while concept scripts remain unexecuted and unpublished', async () => {
  const { directory, out } = await fixture();
  const isolated = await isolatedBuilder(directory);
  const marker = path.join(directory, 'script-was-run.txt');
  const script = path.join(directory, 'knowledge/grouping/scripts/example.ts');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  await mkdir(path.join(out, 'knowledge'), { recursive: true });
  for (const file of movedPages) await writeFile(path.join(out, file), 'old source content');
  await isolated.buildPages(out);
  for (const [file, target] of [
    ['knowledge/decision-material-selection.md', '../topics/decision-material-selection.md'],
    ['knowledge/grouping.md', 'grouping/KNOWLEDGE.md'],
    ['knowledge/visual-hierarchy.md', 'visual-hierarchy/KNOWLEDGE.md'],
  ]) {
    assert.ok(file && target);
    const alias = await readFile(path.join(out, file), 'utf8');
    assert.match(alias, /移動案内.*正本ではありません/);
    assert.ok(alias.includes(`](${target})`));
    assert.doesNotMatch(alias, /old source content|^---/);
  }
  assert.deepEqual(await filesIn(out), expectedFiles);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await assert.rejects(access(path.join(out, 'knowledge/grouping/scripts/example.ts')), { code: 'ENOENT' });
});

test('readers can reach both guideline pages, their original Markdown, and the current knowledge page', async () => {
  const { out } = await fixture();
  await buildPages(out);
  for (const file of ['prototypes/decision-material-selection/index.html', 'prototypes/decision-material-selection/research/index.html']) {
    const html = await readFile(path.join(out, file), 'utf8');
    assert.ok(html.includes('href="https://9uile.github.io/mimic/guideline/"'), `${file}: missing guideline link`);
  }
  for (const [htmlFile, sourceFile, otherFile] of [
    ['guideline/index.html', 'guideline/README.md', 'ai.html'],
    ['guideline/ai.html', 'guideline/ai.md', 'index.html'],
  ]) {
    assert.ok(htmlFile && sourceFile && otherFile);
    const html = await readFile(path.join(out, htmlFile), 'utf8');
    const source = await readFile(path.join(root, sourceFile));
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, htmlFile);
    assert.ok(html.includes(`<dt>source</dt><dd>${sourceFile}</dd>`));
    assert.ok(html.includes(`<meta name="source-sha256" content="${hash(source)}">`));
    assert.ok(html.includes(`href="${otherFile}"`));
    const originalLinks = [...html.matchAll(/href="([^"]*)"/g)].filter(match => match[1] === path.basename(sourceFile));
    assert.equal(originalLinks.length, 2);
    assert.match(html, /href="\.\.\/prototypes\/decision-material-selection\/"/);
    assert.match(html, /href="#content"/);
    assert.match(html, /<nav aria-label="目次">/);
    assert.doesNotMatch(html, /\/Users\/|\/home\/runner\//);
  }
});

test('unknown files, unknown directories, and symlinks fail before any existing output is overwritten', async () => {
  for (const kind of ['file', 'directory', 'symlink', 'root-symlink']) {
    const { directory, out } = await fixture();
    const untouched = path.join(directory, 'untouched.txt');
    await writeFile(untouched, 'outside content');
    if (kind === 'root-symlink') {
      await symlink(directory, out);
    } else {
      await buildPages(out);
      await writeFile(path.join(out, 'index.html'), 'leave existing output untouched');
      if (kind === 'file') await writeFile(path.join(out, 'private-log.txt'), 'private content');
      if (kind === 'directory') await mkdir(path.join(out, 'output'));
      if (kind === 'symlink') await symlink(untouched, path.join(out, 'knowledge/grouping.md.link'));
    }
    await assert.rejects(buildPages(out), /Pages output/);
    if (kind !== 'root-symlink') assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), 'leave existing output untouched');
    if (kind === 'file') assert.equal(await readFile(path.join(out, 'private-log.txt'), 'utf8'), 'private content');
    assert.equal(await readFile(untouched, 'utf8'), 'outside content');
  }
});
