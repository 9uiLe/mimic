import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGuideline } from './build-guideline.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const copiedFiles = Object.freeze([
  'guideline/README.md',
  'guideline/ai.md',
  'prototypes/decision-material-selection/index.html',
  'prototypes/decision-material-selection/ai.md',
  'prototypes/decision-material-selection/draft.md',
  'prototypes/decision-material-selection/research/index.html',
  'prototypes/decision-material-selection/research/ai.md',
  'topics/decision-material-selection.md',
  'knowledge/ecological-interface-design/KNOWLEDGE.md',
  'knowledge/ecological-interface-design/references/sources.md',
  'knowledge/external-representations/KNOWLEDGE.md',
  'knowledge/external-representations/references/sources.md',
  'knowledge/external-representations/examples/temperature.md',
  'knowledge/conceptual-models/KNOWLEDGE.md',
  'knowledge/conceptual-models/references/sources.md',
  'knowledge/grouping/KNOWLEDGE.md',
  'knowledge/grouping/references/sources.md',
  'knowledge/grouping/examples/schedule.md',
  'knowledge/visual-hierarchy/KNOWLEDGE.md',
  'knowledge/visual-hierarchy/references/sources.md',
  'knowledge/visual-hierarchy/examples/schedule.md',
]);
const movedKnowledge = Object.freeze({
  'knowledge/decision-material-selection.md': { title: '判断材料の選定', target: '../topics/decision-material-selection.md' },
  'knowledge/grouping.md': { title: 'グルーピング', target: 'grouping/KNOWLEDGE.md' },
  'knowledge/visual-hierarchy.md': { title: '視覚的な優先順位', target: 'visual-hierarchy/KNOWLEDGE.md' },
});
export const publishedFiles = Object.freeze(['index.html', '.nojekyll', 'guideline/index.html', 'guideline/ai.html', ...copiedFiles, ...Object.keys(movedKnowledge)].sort());
const allowedFiles = new Set(publishedFiles);
const allowedDirectories = new Set(copiedFiles.flatMap(file => {
  const segments = file.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}));
const entryHtml = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta http-equiv="refresh" content="0; url=prototypes/decision-material-selection/">
<title>Mimic — デザインの知識</title></head><body>
<p><a href="prototypes/decision-material-selection/">判断材料の選定を読む（採用状態は本文を確認）</a></p>
</body></html>
`;

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
  const outputs = new Map<string, Buffer>([['index.html', Buffer.from(entryHtml)], ['.nojekyll', Buffer.alloc(0)]]);
  for (const file of copiedFiles) outputs.set(file, await readSource(file));
  for (const [file, { title, target }] of Object.entries(movedKnowledge)) {
    outputs.set(file, Buffer.from(`# ${title}の参照先\n\nこのURLは移動案内です。知識本文の正本ではありません。\n\n[${title}を読む](${target})。\n`));
  }
  const stylesheet = await readSource('scripts/knowledge-view.css');
  outputs.set('guideline/index.html', await renderGuideline(outputs.get('guideline/README.md')!, 'guideline/README.md', stylesheet));
  outputs.set('guideline/ai.html', await renderGuideline(outputs.get('guideline/ai.md')!, 'guideline/ai.md', stylesheet));
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
