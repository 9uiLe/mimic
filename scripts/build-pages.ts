import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDocument } from './build-guideline.ts';
import { renderKnowledge } from './build-knowledge.ts';
import { additionalSources, conceptFiles, conceptIds, exampleFiles, readerViews, renderCatalog } from './pages-catalog.ts';
import { figureFiles, validateFigure } from './knowledge-images.ts';
import { pagesFontFiles, readPagesFontAssets } from './pages-fonts.ts';
import { loadRelationBundle } from './relations.ts';
import { renderRelationGraph } from './build-relation-graph.ts';
import { createHash } from 'node:crypto';
import { compileDesignTokens } from './design-tokens.ts';
import { renderDesignSpecimens } from './design-specimens.ts';
import { renderGraphPage, renderHome, renderReader, validateReadingPaths } from './pages-design.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const copiedFiles = Object.freeze([
  'guideline/README.md',
  'guideline/ai.md',
  'guideline/design-system.md', 'design/tokens.json', 'web/reading.js', 'web/reading.css',
  'topics/decision-material-selection.md',
  'relations/README.md', 'relations/graph.json', 'relations/vocabulary.json',
  'web/graph.js', 'web/graph.css',
  ...conceptFiles, ...exampleFiles, ...additionalSources, ...figureFiles,
]);
const movedKnowledge = Object.freeze({
  'knowledge/decision-material-selection.md': { title: '判断材料の選定', target: '../topics/decision-material-selection.md' },
  'knowledge/grouping.md': { title: 'グルーピング', target: 'grouping/KNOWLEDGE.md' },
  'knowledge/visual-hierarchy.md': { title: '視覚的な優先順位', target: 'visual-hierarchy/KNOWLEDGE.md' },
});
export const publishedFiles = Object.freeze([...new Set([
  'index.html', '.nojekyll', 'guideline/index.html', 'guideline/ai.html',
  'graph/index.html', 'web/tokens.css',
  'prototypes/decision-material-selection/index.html',
  ...copiedFiles, ...Object.values(readerViews), ...Object.keys(movedKnowledge), ...pagesFontFiles,
])].sort());
const allowedFiles = new Set(publishedFiles);
const allowedDirectories = new Set(publishedFiles.flatMap(file => {
  const segments = file.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}));

async function inspectOutput(directory: string, relative = ''): Promise<void> {
  const info = await lstat(directory).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Pages output must be a real directory: ${directory}`);
  for (const name of await readdir(directory)) {
    const file = relative ? `${relative}/${name}` : name;
    const target = path.join(directory, name);
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new Error(`Pages output contains a symbolic link: ${file}`);
    if (entry.isDirectory() && allowedDirectories.has(file)) await inspectOutput(target, file);
    else if (!entry.isFile() || !allowedFiles.has(file) || entry.nlink !== 1) {
      throw new Error(`Pages output contains an unexpected entry: ${file}. Inspect it manually; nothing was removed.`);
    }
  }
}

async function readSource(file: string) {
  let current = root;
  const segments = file.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    const expectedType = index === segments.length - 1 ? info.isFile() : info.isDirectory();
    if (info.isSymbolicLink() || !expectedType) throw new Error(`Pages source must be a regular file in real directories: ${file}`);
  }
  return readFile(current);
}

export async function buildPages(outDir = path.join(root, '_site')) {
  outDir = path.resolve(outDir);
  await inspectOutput(outDir);
  const relations = await loadRelationBundle(root);
  const outputs = new Map<string, Buffer>([['.nojekyll', Buffer.alloc(0)]]);
  for (const file of copiedFiles) {
    const bytes = await readSource(file);
    if (figureFiles.includes(file)) validateFigure(file, bytes);
    outputs.set(file, bytes);
  }
  for (const [file, { title, target }] of Object.entries(movedKnowledge)) {
    outputs.set(file, Buffer.from(`# ${title}の参照先\n\nこのURLは移動案内です。知識本文の正本ではありません。\n\n[${title}を読む](${target})。\n`));
  }
  outputs.set('prototypes/decision-material-selection/index.html', Buffer.from(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=../../topics/decision-material-selection.html">
<title>判断材料の選定 — 移動案内</title></head><body>
<p>閲覧ページは<a href="../../topics/decision-material-selection.html">判断材料の選定</a>へ移動しました。</p>
</body></html>\n`));
  const tokens = compileDesignTokens(JSON.parse(outputs.get('design/tokens.json')!.toString('utf8')));
  outputs.set('web/tokens.css', Buffer.from(tokens.css));
  const stylesheet = Buffer.from(tokens.css + '\n' + outputs.get('web/reading.css')!.toString('utf8'));
  outputs.set('graph/index.html', Buffer.from(renderGraphPage(renderRelationGraph(relations, stylesheet.toString('utf8'), true), relations)));
  const entries = new Map(conceptIds.map(id => [id, outputs.get(`knowledge/${id}/KNOWLEDGE.md`)!.toString('utf8')]));
  const paths = validateReadingPaths(JSON.parse((await readSource('design/reading-paths.json')).toString('utf8')), entries);
  const catalog = renderCatalog(outputs.get('knowledge/README.md')!.toString('utf8'), entries, stylesheet.toString('utf8'), true);
  outputs.set('index.html', Buffer.from(renderHome(catalog, paths, entries)));
  for (const [sourceFile, outFile] of Object.entries(readerViews)) {
    if (sourceFile === 'knowledge/README.md') continue;
    const source = outputs.get(sourceFile)!;
    if (sourceFile.endsWith('/KNOWLEDGE.md') || sourceFile === 'topics/color.md'
      || sourceFile === 'topics/decision-material-selection.md' || sourceFile === 'topics/product-ui-design.md'
      || sourceFile === 'topics/scenario-to-screen.md') {
      const rendered = await renderKnowledge(source, sourceFile, stylesheet, readerViews, true);
      outputs.set(outFile, Buffer.from(renderReader(rendered.toString('utf8'), outFile, sourceFile)));
      continue;
    }
    const id = sourceFile.startsWith('knowledge/') ? sourceFile.split('/')[1] : undefined;
    const title = id ? entries.get(id)?.match(/^title: (.+)$/m)?.[1] : undefined;
    const context = id && title ? {
      title, href: path.posix.relative(path.posix.dirname(outFile), `knowledge/${id}/index.html`),
    } : undefined;
    const rendered = await renderDocument(source, stylesheet, { sourceFile, outFile, views: readerViews, context, pagesAssets: true });
    const specimens = sourceFile === 'guideline/design-system.md' ? renderDesignSpecimens(tokens.resolved) : '';
    outputs.set(outFile, Buffer.from(renderReader(rendered.toString('utf8'), outFile, sourceFile, specimens)));
  }
  const frameFingerprint = createHash('sha256').update(Buffer.concat([
    await readSource('scripts/pages-design.ts'), await readSource('scripts/design-tokens.ts'), await readSource('scripts/design-specimens.ts'),
  ])).digest('hex');
  for (const [file, bytes] of outputs) {
    if (!file.endsWith('.html') || file.startsWith('prototypes/')) continue;
    const metadata = '<meta name="pages-design-id" content="mimic-pages-reader">'
      + '<meta name="pages-design-version" content="1.0.0">'
      + `<meta name="pages-frame-sha256" content="${frameFingerprint}">`;
    outputs.set(file, Buffer.from(bytes.toString('utf8').replace('</head>', `${metadata}</head>`)));
  }
  for (const [file, bytes] of await readPagesFontAssets(root, readSource)) outputs.set(file, bytes);
  // Preflight all inputs and existing output before updating any artifact file.
  for (const [file, bytes] of outputs) {
    const destination = path.join(outDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return [...outputs.keys()].sort();
}

if (import.meta.main) {
  buildPages().then(files => console.log(`Assembled ${files.length} allowlisted Pages files in _site/.`))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
