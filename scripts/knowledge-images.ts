import path from 'node:path';

export const figureFiles = Object.freeze([
  'knowledge/alignment-and-grids/examples/alignment.svg',
  'knowledge/color-context/examples/surrounding-colors.svg',
]);
const imageFiles = new Set(figureFiles);
const escape = (value: string) => value.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function approvedImage(href: string, sourceFile: string, raw: string, alt: string) {
  const prefix = `![${alt}](`;
  const local = href.replace(/^\.\//, '');
  if (!raw.startsWith(prefix) || !alt.trim() || !/^[a-z0-9][a-z0-9./-]*\.svg$/.test(local)
    || local.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error(`unsupported image syntax or source: ${href}`);
  }
  const target = path.posix.join(path.posix.dirname(sourceFile), local);
  if (!imageFiles.has(target)) throw new Error(`unsupported image is not reviewed for publication: ${target}`);
  return target;
}

export function renderImage(href: string, sourceFile: string, outFile: string, raw: string, alt: string, title?: string | null) {
  const target = approvedImage(href, sourceFile, raw, alt);
  const relative = path.posix.relative(path.posix.dirname(outFile), target);
  return `<img src="${escape(relative)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ''}>`;
}

const elementNames = new Set(['svg', 'g', 'title', 'desc', 'rect', 'line', 'path', 'circle', 'ellipse',
  'polyline', 'polygon', 'text', 'tspan']);
const attributeNames = new Set(['xmlns', 'width', 'height', 'viewBox', 'role', 'aria-labelledby', 'id',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'd', 'fill', 'stroke',
  'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size',
  'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity']);

export function validateFigure(file: string, bytes: Buffer) {
  const fail = () => { throw new Error(`Unsupported or malformed static SVG: ${file}`); };
  if (!imageFiles.has(file)) fail();
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(decoded)) fail();
  const text = decoded.replace(/^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>\s*/, '');
  const stack: string[] = [];
  let cursor = 0;
  let rootCount = 0;
  for (const match of text.matchAll(/<([^<>]*)>/g)) {
    const between = text.slice(cursor, match.index);
    if (between.includes('<') || between.includes('>')
      || (between.trim() && !['title', 'desc', 'text', 'tspan'].includes(stack.at(-1) || ''))
      || /&(?!(?:amp|lt|gt|quot|apos);)/.test(between)) fail();
    const tag = match[1]!;
    const closing = tag.match(/^\/([a-z]+)\s*$/);
    if (closing) {
      if (stack.pop() !== closing[1]) fail();
    } else {
      const opening = tag.match(/^([a-z]+)([\s\S]*?)(\/?)$/);
      if (!opening || !elementNames.has(opening[1]!)) fail();
      const name = opening![1]!;
      const attributes = new Map<string, string>();
      let remainder = opening![2]!;
      while (remainder.trim()) {
        const attribute = remainder.match(/^\s+([a-zA-Z][a-zA-Z-]*)=(?:"([^"<>]*)"|'([^'<>]*)')/);
        if (!attribute || !attributeNames.has(attribute[1]!) || attributes.has(attribute[1]!)) fail();
        const value = attribute![2] ?? attribute![3]!;
        if (/[&\\\u0000-\u001f]/.test(value) || /url\s*\(|https?:|javascript:|data:/i.test(value)
          && !(attribute![1] === 'xmlns' && value === 'http://www.w3.org/2000/svg')) fail();
        attributes.set(attribute![1]!, value);
        remainder = remainder.slice(attribute![0].length);
      }
      if (!stack.length) {
        rootCount += 1;
        if (name !== 'svg' || rootCount !== 1 || attributes.get('xmlns') !== 'http://www.w3.org/2000/svg') fail();
        const positive = (value: string | undefined) => !!value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) && parseFloat(value) > 0;
        const viewBox = attributes.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
        const dimensions = positive(attributes.get('width')) && positive(attributes.get('height'));
        if (!dimensions && !(viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0)) fail();
      } else if (name === 'svg') fail();
      if (!opening![3]) stack.push(name);
    }
    cursor = match.index! + match[0].length;
  }
  if (rootCount !== 1 || stack.length || text.slice(cursor).trim()) fail();
}
