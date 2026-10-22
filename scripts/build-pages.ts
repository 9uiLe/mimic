import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDocument } from './build-guideline.ts';
import { renderKnowledge } from './build-knowledge.ts';
import { additionalSources, conceptFiles, conceptIds, exampleFiles, readerViews, renderCatalog } from './pages-catalog.ts';
import { figureFiles, validateFigure } from './knowledge-images.ts';
import { pagesFontFiles, readPagesFontAssets } from './pages-fonts.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const copiedFiles = Object.freeze([
  'guideline/README.md',
  'guideline/ai.md',
  'topics/decision-material-selection.md',
  ...conceptFiles, ...exampleFiles, ...additionalSources, ...figureFiles,
]);
const movedKnowledge = Object.freeze({
  'knowledge/decision-material-selection.md': { title: '判断材料の選定', target: '../topics/decision-material-selection.md' },
  'knowledge/grouping.md': { title: 'グルーピング', target: 'grouping/KNOWLEDGE.md' },
  'knowledge/visual-hierarchy.md': { title: '視覚的な優先順位', target: 'visual-hierarchy/KNOWLEDGE.md' },
});
export const publishedFiles = Object.freeze([...new Set([
  'index.html', '.nojekyll', 'guideline/index.html', 'guideline/ai.html',
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
  const stylesheet = await readSource('scripts/knowledge-view.css');
  const entries = new Map(conceptIds.map(id => [id, outputs.get(`knowledge/${id}/KNOWLEDGE.md`)!.toString('utf8')]));
  outputs.set('index.html', Buffer.from(renderCatalog(outputs.get('knowledge/README.md')!.toString('utf8'), entries, stylesheet.toString('utf8'), true)));
  for (const [sourceFile, outFile] of Object.entries(readerViews)) {
    if (sourceFile === 'knowledge/README.md') continue;
    const source = outputs.get(sourceFile)!;
    if (sourceFile.endsWith('/KNOWLEDGE.md') || sourceFile === 'topics/color.md'
      || sourceFile === 'topics/decision-material-selection.md') {
      outputs.set(outFile, await renderKnowledge(source, sourceFile, stylesheet, readerViews, true));
      continue;
    }
    const id = sourceFile.startsWith('knowledge/') ? sourceFile.split('/')[1] : undefined;
    const title = id ? entries.get(id)?.match(/^title: (.+)$/m)?.[1] : undefined;
    const context = id && title ? {
      title, href: path.posix.relative(path.posix.dirname(outFile), `knowledge/${id}/index.html`),
    } : undefined;
    outputs.set(outFile, await renderDocument(source, stylesheet, { sourceFile, outFile, views: readerViews, context, pagesAssets: true }));
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
