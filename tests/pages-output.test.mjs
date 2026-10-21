import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPages } from '../scripts/build-pages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : 'marked');
const expectedFiles = [
  '.nojekyll',
  'index.html',
  'knowledge/decision-material-selection.md',
  'knowledge/grouping.md',
  'knowledge/visual-hierarchy.md',
  'prototypes/decision-material-selection/ai.md',
  'prototypes/decision-material-selection/draft.md',
  'prototypes/decision-material-selection/index.html',
  'prototypes/decision-material-selection/research/ai.md',
  'prototypes/decision-material-selection/research/index.html',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimic-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, out: path.join(directory, '_site') };
}

async function filesIn(directory, prefix = '') {
  const files = [];
  for (const name of await readdir(directory)) {
    const file = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(path.join(directory, name));
    assert.ok(!info.isSymbolicLink());
    if (info.isDirectory()) files.push(...await filesIn(path.join(directory, name), file));
    else files.push(file);
  }
  return files.sort();
}

test('Pages contains exactly the reviewed ten files and repeated builds preserve their bytes', async t => {
  const { out } = await fixture(t);
  assert.deepEqual(await buildPages(out), expectedFiles);
  assert.deepEqual(await filesIn(out), expectedFiles);
  const before = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  await buildPages(out);
  const after = await Promise.all(expectedFiles.map(file => readFile(path.join(out, file))));
  assert.deepEqual(after, before);
  assert.equal((await readFile(path.join(out, '.nojekyll'))).length, 0);
  const entry = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(entry, /content="0; url=prototypes\/decision-material-selection\/research\/"/);
  assert.match(entry, /更新案（未採用）/);
  assert.ok(expectedFiles.every(file => !/\.pdf$|^output\/|^\.agents\/|^\.git\/|README|log/i.test(file)));
});

test('every local HTML and Markdown link resolves inside the artifact at the GitHub project prefix', async t => {
  const { out } = await fixture(t);
  await buildPages(out);
  const prefix = 'https://example.test/mimic/';
  for (const file of expectedFiles.filter(file => /\.(html|md)$/.test(file))) {
    const text = await readFile(path.join(out, file), 'utf8');
    const links = [];
    if (file.endsWith('.html')) {
      links.push(...[...text.matchAll(/href="([^"]*)"/g)].map(match => match[1]));
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

test('artifact copies match their generated or canonical sources and retain repository-relative provenance', async t => {
  const { out } = await fixture(t);
  await buildPages(out);
  for (const file of expectedFiles.filter(file => file !== 'index.html' && file !== '.nojekyll')) {
    assert.deepEqual(await readFile(path.join(out, file)), await readFile(path.join(root, file)), file);
  }
  for (const [htmlFile, sourceFile, status] of [
    ['prototypes/decision-material-selection/index.html', 'knowledge/decision-material-selection.md', 'proposed'],
    ['prototypes/decision-material-selection/research/index.html', 'prototypes/decision-material-selection/draft.md', 'draft'],
  ]) {
    const html = await readFile(path.join(out, htmlFile), 'utf8');
    const source = await readFile(path.join(root, sourceFile));
    assert.ok(html.includes(`<dt>source</dt><dd>${sourceFile}</dd>`));
    assert.ok(html.includes(`<meta name="source-sha256" content="${hash(source)}">`));
    assert.ok(html.includes(`<dt>status</dt><dd>${status}</dd>`));
    assert.doesNotMatch(html, /\/Users\/|\/home\/runner\/|KNOWLEDGE \/ LOCAL VIEW/);
  }
});

test('unknown files, unknown directories, and symlinks fail before any existing output is overwritten', async t => {
  for (const kind of ['file', 'directory', 'symlink', 'root-symlink']) {
    const { directory, out } = await fixture(t);
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
