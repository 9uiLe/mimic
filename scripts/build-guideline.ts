import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Token, Tokens } from 'marked';
import { renderImage } from './knowledge-images.ts';
import { readerHref } from './pages-catalog.ts';
import { pageFontHead } from './pages-fonts.ts';

export interface DocumentView { sourceFile: string; outFile: string; views: Readonly<Record<string, string>>; context?: { title: string; href: string }; pagesAssets?: boolean }
type GuidelineSource = 'guideline/README.md' | 'guideline/ai.md';
const isHeading = (token: Token): token is Tokens.Heading => token.type === 'heading';
const htmlFiles = { 'guideline/README.md': 'guideline/index.html', 'guideline/ai.md': 'guideline/ai.html' };
const projectPrefix = new URL('https://mimic.invalid/mimic/');
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Guideline source: ${message}`); }

function htmlHref(href: string, sourceFile: string, outFile: string, views: Readonly<Record<string, string>>) {
  assert(!/[\u0000-\u0020\u007f\\]/.test(href), `unsupported link characters: ${href}`);
  if (/^https?:\/\//i.test(href)) {
    const external = new URL(href);
    assert(external.protocol === 'https:' || external.protocol === 'http:', `unsupported link protocol: ${href}`);
    return external.href;
  }
  assert(!href.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(href), `unsupported link: ${href}`);
  if (href.startsWith('#')) return href;
  const target = new URL(href, new URL(sourceFile, projectPrefix));
  assert(target.origin === projectPrefix.origin && target.pathname.startsWith(projectPrefix.pathname), `link escapes the project: ${href}`);
  return readerHref(href, sourceFile, outFile, views);
}

async function loadMarked() {
  const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
  const dependency: unknown = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(markedUrl)), '../package.json'), 'utf8'));
  assert(typeof dependency === 'object' && dependency !== null && 'name' in dependency && dependency.name === 'marked' && 'version' in dependency && dependency.version === '17.0.5', 'expected marked 17.0.5');
  const { marked }: typeof import('marked') = await import(markedUrl);
  return marked;
}

export async function renderGuideline(source: Buffer, sourceFile: GuidelineSource, stylesheet: Buffer): Promise<Buffer> {
  return renderDocument(source, stylesheet, { sourceFile, outFile: htmlFiles[sourceFile], views: htmlFiles });
}

export async function renderDocument(source: Buffer, stylesheet: Buffer, options: DocumentView): Promise<Buffer> {
  const { sourceFile, outFile, views, context, pagesAssets = false } = options;
  const marked = await loadMarked();
  const css = stylesheet.toString('utf8');
  assert(!/@import|url\(|<\/?style\b/i.test(css), 'stylesheet must be self-contained CSS');
  const tokens = marked.lexer(source.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, ''));
  const content = tokens.filter(token => token.type !== 'space');
  const title = content[0];
  assert(title && isHeading(title) && title.depth === 1, 'expected an H1 title at the start');
  const headings = new Map<Token, string>();
  const ids = new Set(['top', 'title', 'content', 'source-provenance']);
  let h1Count = 0;
  marked.walkTokens(tokens, token => {
    assert(token.type !== 'html', `unsupported ${token.type}; no embedded HTML`);
    if (token.type === 'image') {
      try { renderImage(token.href, sourceFile, outFile, token.raw, token.text, token.title); }
      catch (error) { throw new Error(`Guideline source: ${error instanceof Error ? error.message : error}`); }
    }
    if (token.type === 'link') htmlHref(token.href, sourceFile, outFile, views);
    if (!isHeading(token)) return;
    if (token.depth === 1) { h1Count += 1; return; }
    const base = token.text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let id = base;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
    ids.add(id);
    headings.set(token, id);
  });
  assert(h1Count === 1, 'expected exactly one H1 title');
  const sections = content.filter((token): token is Tokens.Heading => isHeading(token) && token.depth === 2);
  const renderer = new marked.Renderer();
  const inline = (tokens: Token[]) => marked.Parser.parseInline(tokens, { renderer });
  renderer.link = ({ href, title, tokens }) => `<a href="${escape(htmlHref(href, sourceFile, outFile, views))}"${title ? ` title="${escape(title)}"` : ''}>${inline(tokens)}</a>`;
  renderer.image = token => renderImage(token.href, sourceFile, outFile, token.raw, token.text, token.title);
  renderer.heading = token => `<h${token.depth} id="${escape(headings.get(token)!)}">${inline(token.tokens)}</h${token.depth}>\n`;
  renderer.table = token => `<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(title.text)}の表">${marked.Renderer.prototype.table.call(renderer, token)}</div>`;
  const bodyTokens = content.slice(1);
  const introduction: Token[] = [];
  const groups: { heading: Tokens.Heading; tokens: Token[] }[] = [];
  for (const token of bodyTokens) {
    if (isHeading(token) && token.depth === 2) groups.push({ heading: token, tokens: [] });
    else if (groups.length) groups[groups.length - 1]!.tokens.push(token);
    else introduction.push(token);
  }
  const render = (tokens: Token[]) => marked.Parser.parse(tokens, { renderer });
  const body = render(introduction) + groups.map(group => `<section class="knowledge-section" aria-labelledby="${escape(headings.get(group.heading)!)}">${render([group.heading, ...group.tokens])}</section>`).join('\n');
  const navigation = sections.map(heading => `<li><a href="#${escape(headings.get(heading)!)}">${escape(heading.text)}</a></li>`).join('');
  const sourceLink = path.posix.relative(path.posix.dirname(outFile), sourceFile);
  const home = path.posix.relative(path.posix.dirname(outFile), 'index.html') || './';
  const other = sourceFile === 'guideline/README.md' ? '<a href="ai.html">AI向けガイド</a>'
    : sourceFile === 'guideline/ai.md' ? '<a href="index.html">人向けガイド</a>' : '';
  const contextLink = context ? `<p class="context">本文: <a href="${escape(context.href)}">${escape(context.title)}</a></p>` : '';
  const links = `${other}<a href="${escape(sourceLink)}">Markdown原文</a>`;
  const toc = sections.length ? `<nav aria-label="目次"><details><summary>目次</summary><ol>${navigation}</ol></details></nav>` : '';
  return Buffer.from(`<!doctype html>
<html lang="ja" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${pageFontHead(outFile, pagesAssets)}
<meta name="source-sha256" content="${hash(source)}"><meta name="stylesheet-sha256" content="${hash(stylesheet)}">
<title>${escape(title.text)} — Mimic</title><style>
${css}

</style></head><body class="guideline">
<a class="skip" href="#content">本文へ</a>
<header><div class="topline"><a class="brand" href="${home}">Mimic</a><div class="toplinks">${links}</div></div>
<div class="hero">${contextLink}<h1 id="title">${inline(title.tokens)}</h1></div></header>
<main class="layout">${toc}<article id="content" tabindex="-1">${body}</article></main>
<footer><div><p class="reading-links">${links}<a href="#top">ページ上部へ</a></p>
<details id="source-provenance"><summary>生成情報・原文との対応</summary><p>このページはMarkdown原文から生成しています。内容の変更は原文に反映してください。</p><dl class="metadata"><dt>source</dt><dd>${sourceFile}</dd><dt>source SHA-256</dt><dd>${hash(source)}</dd></dl></details></div></footer>
</body></html>
`);
}
