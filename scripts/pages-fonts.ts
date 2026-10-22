import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const fontDirectory = 'assets/fonts/gen-interface-jp/0.8.0';
const weights = ['400', '600'] as const;
const slices = Array.from({ length: 128 }, (_, index) => String(index).padStart(3, '0'));
const relativeFiles = [
  '400.css', '600.css', 'OFL.txt',
  ...weights.flatMap(weight => slices.map(slice => `w/normal/${weight}/${slice}.woff2`)),
];
export const pagesFontFiles = Object.freeze(relativeFiles.map(file => `${fontDirectory}/${file}`));
const standalonePolicy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const pagesPolicy = "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'";

export function pageFontHead(outFile: string, pagesAssets = false) {
  const policy = pagesAssets ? pagesPolicy : standalonePolicy;
  const csp = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (!pagesAssets) return csp;
  const links = weights.map(weight => {
    const asset = `${fontDirectory}/${weight}.css`;
    const href = path.posix.relative(path.posix.dirname(outFile), asset);
    return `<link rel="stylesheet" href="${href}">`;
  }).join('\n');
  return `${csp}\n${links}`;
}

export async function readPagesFontAssets(root: string, readSource: (file: string) => Promise<Buffer>) {
  const manifest: unknown = JSON.parse((await readSource(`${fontDirectory}/integrity.json`)).toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Font integrity manifest is invalid');
  const entries = manifest as Record<string, unknown>;
  if (Object.keys(entries).sort().join('\n') !== [...relativeFiles].sort().join('\n')) {
    throw new Error('Font integrity manifest must list exactly the published assets');
  }
  const modulesDirectory = path.join(root, 'node_modules');
  const modulesInfo = await lstat(modulesDirectory);
  if (!modulesInfo.isDirectory() || modulesInfo.isSymbolicLink()) throw new Error('Font dependency needs a real node_modules directory');
  const realModulesDirectory = await realpath(modulesDirectory);
  const packageDirectory = await realpath(path.join(modulesDirectory, 'gen-interface-jp'));
  if (!packageDirectory.startsWith(`${realModulesDirectory}${path.sep}`)) {
    throw new Error('Font dependency resolves outside node_modules');
  }
  const readPackageFile = async (relative: string) => {
    const segments = relative.split('/');
    let file = packageDirectory;
    for (const [index, segment] of segments.entries()) {
      file = path.join(file, segment);
      const info = await lstat(file);
      if (info.isSymbolicLink() || !(index === segments.length - 1 ? info.isFile() : info.isDirectory())) {
        throw new Error(`Font dependency contains an unexpected path: ${relative}`);
      }
    }
    return readFile(file);
  };
  const packageInfo: unknown = JSON.parse((await readPackageFile('package.json')).toString('utf8'));
  if (!packageInfo || typeof packageInfo !== 'object' || !('name' in packageInfo) || !('version' in packageInfo)
    || packageInfo.name !== 'gen-interface-jp' || packageInfo.version !== '0.8.0') {
    throw new Error('Font dependency must be gen-interface-jp@0.8.0');
  }
  const assets = new Map<string, Buffer>();
  for (const relative of relativeFiles) {
    const expected = entries[relative];
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error(`Font integrity entry is invalid: ${relative}`);
    const { size, sha256 } = expected as { size?: unknown; sha256?: unknown };
    if (typeof size !== 'number' || !Number.isSafeInteger(size)
      || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Font integrity entry is invalid: ${relative}`);
    }
    const asset = `${fontDirectory}/${relative}`;
    const bytes = await readPackageFile(relative);
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error(`Font asset differs from pinned v0.8.0: ${relative}`);
    }
    if (relative.endsWith('.woff2') && bytes.toString('ascii', 0, 4) !== 'wOF2') {
      throw new Error(`Font asset is not WOFF2: ${relative}`);
    }
    assets.set(asset, bytes);
  }
  for (const weight of weights) {
    const css = assets.get(`${fontDirectory}/${weight}.css`)!.toString('utf8');
    const references = [...css.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]);
    const expected = slices.map(slice => `./w/normal/${weight}/${slice}.woff2`);
    if (references.join('\n') !== expected.join('\n') || (css.match(/@font-face/g) || []).length !== 128
      || /@import|https?:|font-family:(?!"Gen Interface JP")/i.test(css)
      || [...css.matchAll(/font-weight:([^;]+);/g)].some(match => match[1] !== weight)) {
      throw new Error(`Font CSS references unexpected assets: ${weight}.css`);
    }
  }
  return assets;
}
