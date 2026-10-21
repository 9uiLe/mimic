import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Token, Tokens } from 'marked';

type GuidelineSource = 'guideline/README.md' | 'guideline/ai.md';
const isHeading = (token: Token): token is Tokens.Heading => token.type === 'heading';
const htmlFiles = { 'guideline/README.md': 'guideline/index.html', 'guideline/ai.md': 'guideline/ai.html' };
const projectPrefix = new URL('https://mimic.invalid/mimic/');
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Guideline source: ${message}`); }

function htmlHref(href: string, sourceFile: GuidelineSource) {
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
  let file = target.pathname.slice(projectPrefix.pathname.length);
  if (Object.hasOwn(htmlFiles, file)) file = htmlFiles[file as GuidelineSource];
  const relative = path.posix.relative(path.posix.dirname(htmlFiles[sourceFile]), file);
  return relative + (file.endsWith('/') ? '/' : '') + target.search + target.hash;
}

async function loadMarked() {
  const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
  const dependency: unknown = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(markedUrl)), '../package.json'), 'utf8'));
  assert(typeof dependency === 'object' && dependency !== null && 'name' in dependency && dependency.name === 'marked' && 'version' in dependency && dependency.version === '17.0.5', 'expected marked 17.0.5');
  const { marked }: typeof import('marked') = await import(markedUrl);
  return marked;
}

export async function renderGuideline(source: Buffer, sourceFile: GuidelineSource, stylesheet: Buffer): Promise<Buffer> {
  const marked = await loadMarked();
  const css = stylesheet.toString('utf8');
  assert(!/@import|url\(|<\/?style\b/i.test(css), 'stylesheet must be self-contained CSS');
  const tokens = marked.lexer(source.toString('utf8'));
  const content = tokens.filter(token => token.type !== 'space');
  const title = content[0];
  assert(title && isHeading(title) && title.depth === 1, 'expected an H1 title at the start');
  const headings = new Map<Token, string>();
  const ids = new Set(['top', 'title', 'content', 'source-provenance']);
  let h1Count = 0;
  marked.walkTokens(tokens, token => {
    assert(token.type !== 'html' && token.type !== 'image', `unsupported ${token.type}; no embedded HTML or images`);
    if (token.type === 'link') htmlHref(token.href, sourceFile);
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
  assert(sections.length, 'expected an H2 section for the table of contents');
  const renderer = new marked.Renderer();
  const inline = (tokens: Token[]) => marked.Parser.parseInline(tokens, { renderer });
  renderer.link = ({ href, title, tokens }) => `<a href="${escape(htmlHref(href, sourceFile))}"${title ? ` title="${escape(title)}"` : ''}>${inline(tokens)}</a>`;
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
  const sourceLink = path.posix.basename(sourceFile);
  const other = sourceFile === 'guideline/README.md' ? '<a href="ai.html">AI向けガイド</a>' : '<a href="index.html">人向けガイド</a>';
  const links = `<a href="../prototypes/decision-material-selection/">知識を読む</a>${other}<a href="${sourceLink}">Markdown原文</a>`;
  return Buffer.from(`<!doctype html>
<html lang="ja" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="source-sha256" content="${hash(source)}"><meta name="stylesheet-sha256" content="${hash(stylesheet)}">
<title>${escape(title.text)} — Mimic</title><style>
${css}
.guideline article{overflow-wrap:anywhere}.guideline pre{overflow-x:auto;padding:18px;background:var(--wash);border:1px solid var(--line);border-radius:4px;font-size:.85rem;line-height:1.7}.guideline code{font-size:.9em}.guideline pre code{font-size:inherit}.guideline blockquote{margin:24px 0;padding-left:22px;border-left:3px solid var(--line);color:var(--muted)}
</style></head><body class="guideline">
<a class="skip" href="#content">本文へ</a>
<header><div class="topline"><div class="brand">Mimic</div><div class="toplinks">${links}</div></div>
<div class="hero"><div class="eyebrow">GUIDELINE</div><h1 id="title">${inline(title.tokens)}</h1><p class="meta">Mimicの知識を使うためのガイド</p></div></header>
<main class="layout"><nav aria-label="目次"><p>このガイドの内容</p><ol>${navigation}</ol></nav><article id="content" tabindex="-1">${body}</article></main>
<footer><div><p class="reading-links">${links}<a href="#top">ページ上部へ</a></p>
<details id="source-provenance"><summary>生成情報・原文との対応</summary><p>このページはMarkdown原文から生成しています。内容の変更は原文に反映してください。</p><dl class="metadata"><dt>source</dt><dd>${sourceFile}</dd><dt>source SHA-256</dt><dd>${hash(source)}</dd></dl></details></div></footer>
</body></html>
`);
}
