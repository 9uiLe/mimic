import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const copiedFiles = Object.freeze([
  'prototypes/decision-material-selection/index.html',
  'prototypes/decision-material-selection/ai.md',
  'prototypes/decision-material-selection/draft.md',
  'prototypes/decision-material-selection/research/index.html',
  'prototypes/decision-material-selection/research/ai.md',
  'knowledge/decision-material-selection.md',
  'knowledge/grouping.md',
  'knowledge/visual-hierarchy.md',
]);
export const publishedFiles = Object.freeze(['index.html', '.nojekyll', ...copiedFiles].sort());
const allowedFiles = new Set(publishedFiles);
const allowedDirectories = new Set(copiedFiles.flatMap(file => {
  const segments = file.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}));
const entryHtml = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta http-equiv="refresh" content="0; url=prototypes/decision-material-selection/research/">
<title>Mimic — 更新案（未採用）</title></head><body>
<p><a href="prototypes/decision-material-selection/research/">判断材料の選定 — 更新案（未採用）を読む</a></p>
</body></html>
`;

async function inspectOutput(directory, relative = '') {
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
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

async function readSource(file) {
  let current = root;
  const segments = file.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    const expectedType = index === segments.length - 1 ? info.isFile() : info.isDirectory();
    if (info.isSymbolicLink() || !expectedType) throw new Error(`Pages source must be a regular file in real directories: ${file}`);
  }
  return readFile(current);
}

export async function buildPages(outDir = path.join(root, '_site')) {
  outDir = path.resolve(outDir);
  await inspectOutput(outDir);
  const outputs = new Map([['index.html', Buffer.from(entryHtml)], ['.nojekyll', Buffer.alloc(0)]]);
  for (const file of copiedFiles) outputs.set(file, await readSource(file));
  // Preflight all inputs and existing output before updating any artifact file.
  for (const [file, bytes] of outputs) {
    const destination = path.join(outDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return [...outputs.keys()].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPages().then(files => console.log(`Assembled ${files.length} allowlisted Pages files in _site/.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
