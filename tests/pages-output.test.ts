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
const fontRoot = 'assets/fonts/gen-interface-jp/0.8.0';
const expectedFontFiles = ['400.css', '600.css', 'OFL.txt',
  ...['400', '600'].flatMap(weight => Array.from({ length: 128 }, (_, index) =>
    `w/normal/${weight}/${String(index).padStart(3, '0')}.woff2`)),
].map(file => `${fontRoot}/${file}`);
const expectedFiles = [
  '.nojekyll',
  ...expectedFontFiles,
  'guideline/README.md',
  'guideline/ai.html',
  'guideline/ai.md',
  'guideline/index.html',
  'index.html',
  'graph/index.html', 'relations/index.html', 'relations/README.md', 'relations/graph.json', 'relations/vocabulary.json',
  'web/graph.js', 'web/graph.css',
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
  'prototypes/decision-material-selection/index.html',
  'topics/decision-material-selection.md',
  'topics/decision-material-selection.html',
  'knowledge/README.md',
  'knowledge/ai-slop/KNOWLEDGE.md', 'knowledge/ai-slop/index.html',
  'knowledge/ai-slop/references/sources.md', 'knowledge/ai-slop/references/sources.html',
  'knowledge/ai-slop/examples/ui-decisions.md', 'knowledge/ai-slop/examples/ui-decisions.html',
  'knowledge/aesthetic-and-minimalist-design/KNOWLEDGE.md', 'knowledge/aesthetic-and-minimalist-design/index.html',
  'knowledge/aesthetic-and-minimalist-design/references/sources.md', 'knowledge/aesthetic-and-minimalist-design/references/sources.html',
  'knowledge/color-contrast/KNOWLEDGE.md', 'knowledge/color-contrast/index.html',
  'knowledge/color-contrast/references/sources.md', 'knowledge/color-contrast/references/sources.html',
  'knowledge/lightness-and-luminance/KNOWLEDGE.md', 'knowledge/lightness-and-luminance/index.html',
  'knowledge/lightness-and-luminance/references/sources.md', 'knowledge/lightness-and-luminance/references/sources.html',
  'knowledge/design-tokens/KNOWLEDGE.md', 'knowledge/design-tokens/index.html',
  'knowledge/design-tokens/references/sources.md', 'knowledge/design-tokens/references/sources.html',
  'knowledge/design-tokens/examples/color-presentation.md', 'knowledge/design-tokens/examples/color-presentation.html',
  'knowledge/conceptual-models/index.html', 'knowledge/conceptual-models/references/sources.html',
  'knowledge/ecological-interface-design/index.html', 'knowledge/ecological-interface-design/references/sources.html',
  'knowledge/external-representations/index.html', 'knowledge/external-representations/references/sources.html',
  'knowledge/external-representations/examples/temperature.html',
  'knowledge/grouping/index.html', 'knowledge/grouping/references/sources.html', 'knowledge/grouping/examples/schedule.html',
  'knowledge/visual-hierarchy/index.html', 'knowledge/visual-hierarchy/references/sources.html', 'knowledge/visual-hierarchy/examples/schedule.html',
  'topics/color.md', 'topics/color.html', 'topics/ai-slop.md', 'topics/ai-slop.html',
  'knowledge/typography/KNOWLEDGE.md', 'knowledge/typography/index.html',
  'knowledge/typography/references/sources.md', 'knowledge/typography/references/sources.html',
  'knowledge/typography/examples/mixed-ui-copy.md', 'knowledge/typography/examples/mixed-ui-copy.html',
  'knowledge/layout-spacing/KNOWLEDGE.md', 'knowledge/layout-spacing/index.html',
  'knowledge/layout-spacing/references/sources.md', 'knowledge/layout-spacing/references/sources.html',
  'knowledge/layout-spacing/examples/component-spacing.md', 'knowledge/layout-spacing/examples/component-spacing.html',
  'knowledge/alignment-and-grids/KNOWLEDGE.md', 'knowledge/alignment-and-grids/index.html',
  'knowledge/alignment-and-grids/references/sources.md', 'knowledge/alignment-and-grids/references/sources.html',
  'knowledge/alignment-and-grids/examples/alignment.md', 'knowledge/alignment-and-grids/examples/alignment.html',
  'knowledge/alignment-and-grids/examples/alignment.svg',
  'knowledge/color-context/KNOWLEDGE.md', 'knowledge/color-context/index.html',
  'knowledge/color-context/references/sources.md', 'knowledge/color-context/references/sources.html',
  'knowledge/color-context/examples/surrounding-colors.md', 'knowledge/color-context/examples/surrounding-colors.html',
  'knowledge/color-context/examples/surrounding-colors.svg',
].sort();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const movedPages = ['knowledge/decision-material-selection.md', 'knowledge/grouping.md', 'knowledge/visual-hierarchy.md'];
const generatedPages = ['index.html', '.nojekyll', ...movedPages,
  ...expectedFiles.filter(file => file.endsWith('.html'))];

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
  const inputs = ['scripts/build-pages.ts', 'scripts/build-guideline.ts', 'scripts/build-knowledge.ts', 'scripts/pages-catalog.ts',
    'scripts/relations.ts', 'scripts/build-relation-graph.ts',
    'scripts/pages-fonts.ts', 'scripts/knowledge-images.ts', 'scripts/knowledge-paths.ts', 'scripts/knowledge-view.css',
    `${fontRoot}/integrity.json`, ...expectedFiles.filter(file => !generatedPages.includes(file) && !expectedFontFiles.includes(file))];
  for (const file of inputs) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  const packageDirectory = path.join(directory, 'node_modules/gen-interface-jp');
  await mkdir(packageDirectory, { recursive: true });
  for (const relative of ['package.json', ...expectedFontFiles.map(file => file.slice(fontRoot.length + 1))]) {
    const destination = path.join(packageDirectory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, 'node_modules/gen-interface-jp', relative)));
  }
  const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
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
  assert.equal(expectedFiles.length, 359);
  assert.deepEqual(await buildPages(out), expectedFiles);
  assert.deepEqual(await filesIn(out), expectedFiles);
  const before = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  await buildPages(out);
  const after = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  assert.deepEqual(after, before);
  assert.equal((await readFile(path.join(out, '.nojekyll'))).length, 0);
  const entry = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(entry, /http-equiv="refresh"/);
  assert.match(entry, /<h1>デザインの知識<\/h1>/);
  assert.equal([...entry.matchAll(/<h3><a href="knowledge\//g)].length, 14, 'catalog must expose all fourteen reviewed concepts');
  assert.match(entry, /AI Slop/);
  assert.ok(entry.includes('href="topics/decision-material-selection.html"'), 'catalog must open the topic reader');
  assert.doesNotMatch(entry, /正式採用|採用済み|掲載済み/, 'catalog must not show adoption labels');
  const catalogVersions = Object.fromEntries([...entry.matchAll(
    /<li><h3><a href="knowledge\/([^/]+)\/">[^<]+<\/a><\/h3>[\s\S]*?<p class="meta">v([^<]+)<\/p><\/li>/g,
  )].map(([, id, version]) => [id, version]));
  assert.deepEqual(catalogVersions, {
    'ecological-interface-design': '1.0.1', 'external-representations': '1.0.1',
    'conceptual-models': '1.0.1', grouping: '1.0.1', 'visual-hierarchy': '1.0.1',
    'lightness-and-luminance': '1.0.1', 'color-contrast': '1.0.1',
    'design-tokens': '1.1.1', 'ai-slop': '1.0.1',
    'aesthetic-and-minimalist-design': '1.0.1', typography: '1.0.1', 'layout-spacing': '1.0.1',
    'alignment-and-grids': '1.0.1', 'color-context': '1.0.1',
  }, 'catalog must map each concept to its source version');
  assert.equal([...entry.matchAll(/<p class="meta">v1\.0\.1<\/p>/g)].length, 13,
    'catalog must show thirteen v1.0.1 source concept versions');
  assert.equal([...entry.matchAll(/<p class="meta">v1\.1\.1<\/p>/g)].length, 1,
    'catalog must show the Design Token v1.1.1 source version');
  for (const file of ['knowledge/README.md', 'topics/color.html', 'topics/ai-slop.html',
    'topics/color.md', 'topics/ai-slop.md']) {
    const content = await readFile(path.join(out, file), 'utf8');
    assert.doesNotMatch(content, /正式採用|採用済み|掲載済み/, `${file}: reader must not show adoption labels`);
  }
  assert.doesNotMatch(entry, /research\//);
  assert.ok(expectedFiles.every(file => !/\.pdf$|^output\/|^\.agents\/|^\.git\/|^README\.md$|(?:^|\/)logs?(?:\/|$)|\.log$/i.test(file)));
});

test('Pages uses only pinned same-origin font subsets and keeps their license', async () => {
  const { out } = await fixture();
  await buildPages(out);
  const manifest: Record<string, { size: number; sha256: string }> = JSON.parse(
    await readFile(path.join(root, fontRoot, 'integrity.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), expectedFontFiles.map(file => file.slice(fontRoot.length + 1)).sort(),
    'every published font asset must be pinned');
  for (const file of expectedFontFiles) {
    const relative = file.slice(fontRoot.length + 1);
    const bytes = await readFile(path.join(out, file));
    assert.deepEqual(bytes, await readFile(path.join(root, 'node_modules/gen-interface-jp', relative)),
      `${file}: copied from the pinned npm dependency`);
    assert.equal(bytes.length, manifest[relative]?.size, `${file}: pinned byte length`);
    assert.equal(hash(bytes), manifest[relative]?.sha256, `${file}: pinned SHA-256`);
    if (file.endsWith('.woff2')) assert.equal(bytes.toString('ascii', 0, 4), 'wOF2', `${file}: WOFF2 signature`);
  }
  const ofl = await readFile(path.join(out, fontRoot, 'OFL.txt'), 'utf8');
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  for (const weight of ['400', '600']) {
    const css = await readFile(path.join(out, fontRoot, `${weight}.css`), 'utf8');
    const references = [...css.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]);
    assert.deepEqual(references, Array.from({ length: 128 }, (_, index) =>
      `./w/normal/${weight}/${String(index).padStart(3, '0')}.woff2`));
    assert.doesNotMatch(css, /@import|https?:/i);
  }
  for (const file of expectedFiles.filter(file => file.endsWith('.html') && !file.startsWith('prototypes/'))) {
    const html = await readFile(path.join(out, file), 'utf8');
    const prefix = path.posix.relative(path.posix.dirname(file), fontRoot);
    assert.ok(html.includes(`href="${prefix}/400.css"`), `${file}: body font CSS`);
    assert.ok(html.includes(`href="${prefix}/600.css"`), `${file}: heading font CSS`);
    assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; '
      + 'style-src \'self\' \'unsafe-inline\'; font-src \'self\'; base-uri \'none\'; form-action \'none\''
      + (file === 'graph/index.html' ? "; script-src 'self'" : '') + '">'),
    `${file}: only the graph may execute same-origin scripts`);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net|@import/);
  }
  assert.ok(!expectedFiles.some(file => file.startsWith(fontRoot)
    && /integrity\.json|\/README\.md$/.test(file)));
});

test('altered font bytes fail before Pages output is updated', async () => {
  const { directory, out } = await fixture();
  const isolated = await isolatedBuilder(directory);
  await isolated.buildPages(out);
  const entry = path.join(out, 'index.html');
  await writeFile(entry, 'keep the previous output');
  const subset = path.join(directory, 'node_modules/gen-interface-jp/w/normal/400/127.woff2');
  const bytes = await readFile(subset);
  bytes[8] = bytes[8]! ^ 1;
  await writeFile(subset, bytes);
  await assert.rejects(isolated.buildPages(out), /Font asset differs from pinned v0\.8\.0/);
  assert.equal(await readFile(entry, 'utf8'), 'keep the previous output');
});

test('every local HTML and Markdown link resolves inside the artifact at the GitHub project prefix', async () => {
  const { out } = await fixture();
  await buildPages(out);
  const prefix = 'https://example.test/mimic/';
  for (const file of expectedFiles.filter(file => /\.(html|md)$/.test(file))) {
    const text = await readFile(path.join(out, file), 'utf8');
    const links: string[] = [];
    if (file.endsWith('.html')) {
      links.push(...[...text.matchAll(/(?:href|src)="([^"]*)"/g)].map(match => {
        assert.ok(match[1] !== undefined);
        return match[1];
      }));
    } else {
      marked.walkTokens(marked.lexer(text.replace(/^---\n[\s\S]*?\n---\n/, '')), token => {
        if (token.type === 'link' || token.type === 'image') links.push(token.href);
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

test('canonical Markdown copies and generated readers retain source metadata and provenance', async () => {
  const { out } = await fixture();
  await buildPages(out);
  for (const file of expectedFiles.filter(file => !generatedPages.includes(file) && !expectedFontFiles.includes(file))) {
    assert.deepEqual(await readFile(path.join(out, file)), await readFile(path.join(root, file)), file);
  }
  const topicMarkdown = await readFile(path.join(out, 'topics/decision-material-selection.md'), 'utf8');
  assert.match(topicMarkdown, /^version: "1\.0\.0"$/m, 'canonical topic version must remain intact');
  assert.doesNotMatch(topicMarkdown, /^status:/m);
  const provenanceCases: [string, string][] = [
    ['topics/decision-material-selection.html', 'topics/decision-material-selection.md'],
  ];
  for (const [htmlFile, sourceFile] of provenanceCases) {
    const html = await readFile(path.join(out, htmlFile), 'utf8');
    const source = await readFile(path.join(root, sourceFile));
    assert.ok(html.includes('<dt>version</dt><dd>1.0.0</dd>'), 'canonical topic reader must show source version');
    assert.ok(html.includes('<dt>scope</dt><dd>'), 'canonical topic reader must show source scope');
    assert.doesNotMatch(html, /<dt>status<\/dt>|<span class="badge">/);
    assert.ok(html.includes(`<dt>source</dt><dd>${sourceFile}</dd>`));
    assert.ok(html.includes(`<meta name="source-sha256" content="${hash(source)}">`), 'canonical topic reader must match source SHA-256');
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
  const topic = await readFile(path.join(out, 'topics/decision-material-selection.html'), 'utf8');
  assert.ok(topic.includes('href="../guideline/index.html"'), 'topic reader must open the guideline');
  const formerEntry = await readFile(path.join(out, 'prototypes/decision-material-selection/index.html'), 'utf8');
  assert.ok(formerEntry.includes('url=../../topics/decision-material-selection.html'));
  assert.doesNotMatch(formerEntry, /<dt>status<\/dt>|<article>/);
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
    assert.match(html, /class="brand" href="\.\.\/index.html"/);
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

const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!)
  .replace(/\s+/g, ' ').trim();

test('HTML readers retain every source block, concept version, and paths to related knowledge and supplements', async () => {
  const { out } = await fixture();
  await buildPages(out);
  const readers = expectedFiles.filter(file => file.startsWith('knowledge/') && file.endsWith('.html'));
  assert.equal(readers.length, 37);
  for (const htmlFile of readers) {
    const sourceFile = htmlFile.endsWith('/index.html') ? htmlFile.replace(/index\.html$/, 'KNOWLEDGE.md') : htmlFile.replace(/\.html$/, '.md');
    const source = await readFile(path.join(root, sourceFile), 'utf8');
    const html = await readFile(path.join(out, htmlFile), 'utf8');
    const visible = plainText(html.slice(html.indexOf('</style>')));
    for (const token of marked.lexer(source.replace(/^---\n[\s\S]*?\n---\n/, ''))) {
      if (token.type === 'space') continue;
      assert.ok(visible.includes(plainText(marked.Parser.parse([token]))), `${htmlFile}: source block must remain readable`);
    }
    assert.ok(html.includes(`<meta name="source-sha256" content="${hash(Buffer.from(source))}">`), htmlFile);
    assert.ok(html.includes('<a class="brand" href="'), htmlFile);
    if (sourceFile.endsWith('/KNOWLEDGE.md')) {
      const version = source.match(/^version: "?([^"\n]+)"?$/m)![1]!;
      assert.ok(html.includes(`<dt>version</dt><dd>${version}</dd>`), htmlFile);
      assert.ok(html.includes(`<p class="meta">v${version}</p>`), htmlFile);
      assert.doesNotMatch(html, /<dt>status<\/dt>|<span class="badge">/, `${htmlFile}: removed metadata must not appear`);
      assert.ok(html.includes('href="references/sources.html"'), `${htmlFile}: sources must open in the reader`);
    } else {
      assert.ok(html.includes('href="../index.html"'), `${htmlFile}: supplement must return to its concept`);
      assert.doesNotMatch(html, /<span class="badge">/, `${htmlFile}: supplement must not show a state badge`);
    }
  }
  const grouping = await readFile(path.join(out, 'knowledge/grouping/index.html'), 'utf8');
  assert.ok(grouping.includes('href="../visual-hierarchy/index.html"'), 'related concepts must open in the reader');
  assert.ok(grouping.includes('href="examples/schedule.html"'), 'examples must open in the reader');
  assert.ok(grouping.includes('href="KNOWLEDGE.md"'), 'canonical Markdown must remain available');
  assert.ok(grouping.includes('href="../../topics/decision-material-selection.html"'),
    'related topic must open in the reader');
});

test('the decision topic retains its text and opens all five related concept readers', async () => {
  const { out } = await fixture();
  await buildPages(out);
  const source = await readFile(path.join(root, 'topics/decision-material-selection.md'), 'utf8');
  const html = await readFile(path.join(out, 'topics/decision-material-selection.html'), 'utf8');
  const visible = plainText(html.slice(html.indexOf('</style>')));
  for (const token of marked.lexer(source.replace(/^---\n[\s\S]*?\n---\n/, ''))) {
    if (token.type === 'space') continue;
    assert.ok(visible.includes(plainText(marked.Parser.parse([token]))), 'topic source block must remain readable');
  }
  assert.ok(html.includes(`<meta name="source-sha256" content="${hash(Buffer.from(source))}">`));
  assert.ok(html.includes('<dt>version</dt><dd>1.0.0</dd>'));
  assert.ok(html.includes('href="decision-material-selection.md"'), 'canonical topic Markdown must remain available');
  for (const id of ['ecological-interface-design', 'external-representations', 'conceptual-models',
    'grouping', 'visual-hierarchy']) {
    assert.ok(html.includes(`href="../knowledge/${id}/index.html"`), `${id}: topic must open the concept reader`);
  }
});

test('unsafe concept links fail before existing Pages output is changed', async () => {
  const { directory, out } = await fixture();
  const isolated = await isolatedBuilder(directory);
  await isolated.buildPages(out);
  const before = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  const sourceFile = path.join(directory, 'knowledge/grouping/KNOWLEDGE.md');
  const source = await readFile(sourceFile, 'utf8');
  const changed = source.replace('## 概念', '## 概念\n\n[外部コード](javascript:alert(1))');
  await writeFile(sourceFile, changed);
  const graphPath = path.join(directory, 'relations/graph.json');
  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as { nodes: Array<{ id: string; sha256: string }> };
  graph.nodes.find(node => node.id === 'grouping')!.sha256 = hash(Buffer.from(changed));
  await writeFile(graphPath, JSON.stringify(graph));
  await assert.rejects(isolated.buildPages(out), /Source schema: unsupported link protocol/,
    'unsafe concept links must reject before Pages output changes');
  assert.deepEqual(await Promise.all(expectedFiles.map(file => readFile(path.join(out, file)))), before);
});

test('reviewed figure bytes and responsive reader images publish together and bad figure inputs preserve existing output', async () => {
  const { directory, out } = await fixture();
  const isolated = await isolatedBuilder(directory);
  await isolated.buildPages(out);
  for (const [id, name] of [['alignment-and-grids', 'alignment'], ['color-context', 'surrounding-colors']]) {
    const file = `knowledge/${id}/examples/${name}.svg`;
    assert.deepEqual(await readFile(path.join(out, file)), await readFile(path.join(root, file)), 'published figure must retain reviewed bytes');
    const html = await readFile(path.join(out, `knowledge/${id}/examples/${name}.html`), 'utf8');
    assert.ok(html.includes(`<img src="${name}.svg" alt="`), 'reader image must refer to the published figure');
    assert.ok(html.includes(`href="${name}.svg"`), 'reader must retain a full-size figure link');
    assert.ok(html.includes('article img { max-width: 100%; height: auto; }'), 'reader figures must fit a narrow viewport');
  }
  const file = path.join(directory, 'knowledge/alignment-and-grids/examples/alignment.svg');
  const before = await Promise.all(expectedFiles.map(name => readFile(path.join(out, name))));
  await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="450"><script>alert(1)</script></svg>');
  await assert.rejects(isolated.buildPages(out), /static SVG/, 'bad figure inputs must reject before any output mutation');
  assert.deepEqual(await Promise.all(expectedFiles.map(name => readFile(path.join(out, name)))), before);
  await rm(file);
  await assert.rejects(isolated.buildPages(out), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(expectedFiles.map(name => readFile(path.join(out, name)))), before);
  await symlink(path.join(root, 'knowledge/alignment-and-grids/examples/alignment.svg'), file);
  await assert.rejects(isolated.buildPages(out), /regular file/);
  assert.deepEqual(await Promise.all(expectedFiles.map(name => readFile(path.join(out, name)))), before);
});
