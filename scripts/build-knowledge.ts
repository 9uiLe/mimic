import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Token, Tokens } from 'marked';
import { approvedImage, renderImage } from './knowledge-images.ts';
import { relativeLink } from './knowledge-paths.ts';
import { readerHref } from './pages-catalog.ts';
import { pageFontHead } from './pages-fonts.ts';

const generatorPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(generatorPath), '..');
const markedVersion = '17.0.5';
const stylesheetPath = path.join(path.dirname(generatorPath), 'knowledge-view.css');
const design = { id: 'mimic-knowledge-view', version: '3.4.0' };
const sectionLabels = {
  purpose: '目的と使う場面',
  inputs: '使う前に確かめること',
  procedure: '判断の進め方',
  outputs: '判断案と選定理由',
  related: '他の知識との関係',
  example: '例で確かめる',
  sources: '根拠といえる範囲',
  unverified: 'まだ確かめていないこと',
};
type SectionRole = keyof typeof sectionLabels;
const sectionRoles = Object.keys(sectionLabels) as SectionRole[];
const noteLabels = { proposal: '提案', assumption: '仮定', limitation: '限界・未確認', 'evidence-scope': '根拠の範囲' };
type NoteType = keyof typeof noteLabels;
type Marked = typeof import('marked')['marked'];
type MimicToken = Token & { mimicId?: string; mimicNote?: NoteType; mimicSteps?: boolean };
type MimicHeading = Tokens.Heading & { mimicId?: string };
type MimicParagraph = Tokens.Paragraph & { mimicNote?: NoteType };
type MimicList = Tokens.List & { mimicSteps?: boolean };
type Directive = { kind: 'section'; value: SectionRole } | { kind: 'heading'; value: string } | { kind: 'note'; value: NoteType };
interface Metadata { id: string; title: string; version: string; scope: string; related: string[] }
interface Group { heading: MimicHeading; tokens: MimicToken[] }
interface Section extends Group { id: string; role?: SectionRole }
interface Provenance { source: string; stylesheet: string; generator: string; renderer: string }
const isHeading = (token: Token): token is MimicHeading => token.type === 'heading';
const isLinkOrImage = (token: Token): token is Tokens.Link | Tokens.Image => token.type === 'link' || token.type === 'image';
const isList = (token: Token): token is MimicList => token.type === 'list';
const hasOwn = <T extends object>(object: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(object, key);
const inlineTokens = (token: Token): Token[] | undefined => (token as { tokens?: Token[] }).tokens;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Source schema: ${message}`); }
const isRelativeHref = (href: string) => !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#');

function resolveLink(href: string, sourcePath: string, outDir: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    assert(/^https?:/i.test(href), `unsupported link protocol ${href}`);
    return href;
  }
  if (href.startsWith('#')) return href;
  assert(!href.startsWith('//') && !path.isAbsolute(href), `unsupported absolute link ${href}`);
  const [, pathname = '', suffix = ''] = href.match(/^([^?#]*)(.*)$/s)!;
  return relativeLink(outDir, path.resolve(path.dirname(sourcePath), decodeURI(pathname))) + suffix;
}

export function makeAiMarkdown(source: Buffer, marked: Marked, sourcePath: string, outDir: string) {
  const failUnless = (condition: unknown, message: string) => { if (!condition) throw new Error(`AI Markdown links: ${message}`); };
  const text = source.toString('utf8');
  const frontmatter = text.match(/^---\n[\s\S]*?\n---\n/)![0];
  const body = text.slice(frontmatter.length);
  const blocks = marked.lexer(body);
  marked.walkTokens(blocks, token => {
    if (token.type === 'image') approvedImage(token.href, relativeLink(root, sourcePath), token.raw, token.text);
  });
  failUnless(!Object.keys(blocks.links || {}).length, 'reference-style link definitions are unsupported');
  failUnless(blocks.map(token => token.raw).join('') === body, 'source cannot be preserved exactly; reference definitions and normalized block syntax are unsupported');
  const localLinks = (tokens: Token[]) => {
    const links: (Tokens.Link | Tokens.Image)[] = [];
    marked.walkTokens(tokens, token => { if (isLinkOrImage(token) && isRelativeHref(token.href)) links.push(token); });
    return links;
  };
  const result = blocks.map(block => {
    const links = localLinks([block]);
    if (!links.length) return block.raw;
    failUnless(['paragraph', 'heading', 'table'].includes(block.type), `relative links inside ${block.type} are unsupported; use a paragraph, heading, or table`);
    const inline = marked.Lexer.lexInline(block.raw);
    failUnless(inline.map(token => token.raw).join('') === block.raw, 'inline syntax cannot be preserved exactly');
    const edits: { start: number; end: number; href: string }[] = [];
    const found: (Tokens.Link | Tokens.Image)[] = [];
    const visit = (tokens: Token[], offset: number): void => {
      let cursor = offset;
      for (const token of tokens) {
        if (isLinkOrImage(token) && isRelativeHref(token.href)) {
          if (token.type === 'image') approvedImage(token.href, relativeLink(root, sourcePath), token.raw, token.text);
          const prefix = `${token.type === 'image' ? '!' : ''}[${token.text}](`;
          failUnless(token.raw.startsWith(prefix), 'only inline [label](path) relative links are supported');
          const destinationOffset = prefix.length + token.raw.slice(prefix.length).match(/^\s*/)![0].length;
          const destinationEnd = destinationOffset + token.href.length;
          failUnless(token.raw.slice(destinationOffset, destinationEnd) === token.href && /[\s)]/.test(token.raw[destinationEnd] || ''), `escaped or angle-bracket destination is unsupported: ${token.raw}`);
          failUnless(/^[\p{L}\p{N}._~/-]+(?:[?#][^\s<>"'()\\]*)?$/u.test(token.href), `unsupported relative destination: ${token.href}`);
          const suffix = token.href.match(/^([^?#]*)(.*)$/s)![2]!;
          const target = resolveLink(token.href, sourcePath, outDir);
          const targetPath = suffix ? target.slice(0, -suffix.length) : target;
          const href = targetPath.split('/').map(segment => encodeURIComponent(segment)).join('/') + suffix;
          edits.push({ start: cursor + destinationOffset, end: cursor + destinationEnd, href });
          found.push(token);
        } else if (!isLinkOrImage(token)) {
          const children = inlineTokens(token);
          if (children && localLinks(children).length) {
            const inner = children.map(child => child.raw).join('');
            const start = token.raw.indexOf(inner);
            failUnless(start >= 0 && start === token.raw.lastIndexOf(inner), `unsupported nested inline syntax: ${token.type}`);
            visit(children, cursor + start);
          }
        }
        cursor += token.raw.length;
      }
    };
    visit(inline, 0);
    const signature = (tokens: (Tokens.Link | Tokens.Image)[]) => JSON.stringify(tokens.map(token => [token.raw, token.href]));
    failUnless(signature(found) === signature(links), 'block and inline link positions disagree; this syntax is unsupported');
    let raw = block.raw;
    for (const edit of edits.sort((a, b) => b.start - a.start)) raw = raw.slice(0, edit.start) + edit.href + raw.slice(edit.end);
    return raw;
  }).join('');
  return Buffer.from(frontmatter + result);
}

function parseConceptSections(content: MimicToken[]): Section[] {
  const sections: Section[] = [];
  const usedIds = new Set(['top', 'title', 'source-provenance']);
  for (const token of content) {
    if (isHeading(token)) {
      const base = token.text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
      let id = base;
      for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
      usedIds.add(id);
      token.mimicId = id;
      if (token.depth === 2) {
        sections.push({ id, heading: token, tokens: [] });
        continue;
      }
    }
    const section = sections[sections.length - 1];
    assert(section, 'content must begin with an H2 section');
    section.tokens.push(token);
  }
  assert(sections.length, 'expected an H2 section');
  for (const section of sections) assert(section.tokens.some(token => !isHeading(token)), `empty section ${section.id}`);
  return sections;
}

function parseSource(text: string, marked: Marked, sourcePath: string) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, 'expected LF frontmatter at the start');
  const fields: Record<string, string | string[] | undefined> = {};
  for (const line of frontmatter[1]!.split('\n')) {
    if (/^  - /.test(line)) {
      assert(Array.isArray(fields.related), 'unexpected frontmatter list');
      fields.related.push(line.slice(4));
      continue;
    }
    const field = line.match(/^(id|title|version|scope|related):(?: (.*))?$/);
    assert(field && !Object.hasOwn(fields, field[1]!), `unsupported or duplicate frontmatter: ${line}`);
    fields[field[1]!] = field[1] === 'related' ? [] : (field[2] || '').replace(/^"(.*)"$/, '$1');
  }
  const requiredField = (key: string): string => {
    const value = fields[key];
    assert(typeof value === 'string' && value, `missing ${key}`);
    return value;
  };
  const metadata: Metadata = { id: requiredField('id'), title: requiredField('title'), version: requiredField('version'), scope: requiredField('scope'), related: [] };
  assert(fields.related === undefined || Array.isArray(fields.related), 'invalid related');
  metadata.related = fields.related ?? [];
  const validId = (id: string) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
  assert(validId(metadata.id), 'invalid knowledge id');
  assert(metadata.related.every(validId), 'invalid related id');
  assert(new Set(metadata.related).size === metadata.related.length && !metadata.related.includes(metadata.id), 'related ids must be unique and exclude this knowledge');
  if (path.basename(sourcePath) === 'KNOWLEDGE.md') {
    assert(path.basename(path.dirname(sourcePath)) === metadata.id, 'knowledge directory and id must match');
  }
  const tokens: MimicToken[] = marked.lexer(text.slice(frontmatter[0].length));
  const content = tokens.filter(token => token.type !== 'space');
  assert(content[0] && isHeading(content[0]) && content[0].depth === 1 && content[0].text === metadata.title, 'title and H1 must match');
  assert(content.filter(token => isHeading(token) && token.depth === 1).length === 1, 'expected one H1');
  const structured = content.some(token => token.type === 'html' && /^<!-- mimic:section /.test(token.raw.trim()));
  if (!structured) {
    marked.walkTokens(content, token => {
      assert(token.type !== 'html', `unsupported ${token.type}; no embedded HTML`);
      if (token.type === 'image') approvedImage(token.href, relativeLink(root, sourcePath), token.raw, token.text);
    });
    return { metadata, sections: parseConceptSections(content.slice(1)) };
  }
  const groups = new Map<SectionRole, Group>();
  const usedIds = new Set([...sectionRoles, 'top', 'title', 'view-actions', 'source-provenance']);
  let current: SectionRole | undefined;
  let pending: Directive | undefined;
  for (const token of content.slice(1)) {
    if (token.type === 'html') {
      const directive = token.raw.trim().match(/^<!-- mimic:(section|heading|note) ([a-z][a-z0-9-]*) -->$/);
      assert(directive, 'unsupported HTML or directive; only mimic:section, mimic:heading, and mimic:note comments are allowed');
      assert(!pending, 'a directive must be followed by its content');
      const [, kind, value] = directive;
      assert(value, 'directive must have a value');
      if (kind === 'section') {
        assert(hasOwn(sectionLabels, value), `unknown section role ${value}`);
        pending = { kind, value };
      } else if (kind === 'note') {
        assert(hasOwn(noteLabels, value), `unknown note type ${value}`);
        pending = { kind, value };
      } else {
        assert(kind === 'heading', `unsupported directive ${kind}`);
        pending = { kind, value };
      }
      continue;
    }
    if (isHeading(token) && token.depth === 2) {
      assert(pending?.kind === 'section', `H2 needs a mimic:section directive: ${token.text}`);
      current = pending.value;
      assert(!groups.has(current), `duplicate section role ${current}`);
      groups.set(current, { heading: token, tokens: [] });
    } else {
      assert(current, 'content outside a section');
      if (isHeading(token)) {
        assert(token.depth >= 3 && pending?.kind === 'heading', `subheading needs a mimic:heading directive: ${token.text}`);
        assert(!usedIds.has(pending.value), `duplicate or reserved heading ID ${pending.value}`);
        token.mimicId = pending.value;
        usedIds.add(pending.value);
      } else if (pending) {
        assert(pending.kind === 'note' && token.type === 'paragraph', 'mimic:note must immediately precede one paragraph');
        token.mimicNote = pending.value;
      }
      if (current === 'procedure' && isList(token) && token.ordered) token.mimicSteps = true;
      groups.get(current)!.tokens.push(token);
    }
    pending = undefined;
  }
  assert(!pending, 'directive at the end has no content');
  for (const role of sectionRoles) {
    assert(groups.has(role), `missing section role ${role}`);
    assert(groups.get(role)!.tokens.some(token => token.type !== 'heading'), `empty section ${role}`);
  }
  assert(groups.get('procedure')!.tokens.some(token => token.mimicSteps), 'procedure needs an ordered list');
  marked.walkTokens([content[0], ...[...groups.values()].flatMap(group => [group.heading, ...group.tokens])], token => {
    assert(token.type !== 'html', `unsupported ${token.type}; no embedded HTML`);
    if (token.type === 'image') approvedImage(token.href, relativeLink(root, sourcePath), token.raw, token.text);
  });
  return { metadata, sections: sectionRoles.map(role => ({ ...groups.get(role)!, id: role, role })) };
}

function makeHtml(
  source: Buffer, marked: Marked, provenance: Provenance, sourcePath: string, outDir: string, stylesheet: string,
  views?: Readonly<Record<string, string>>, pagesAssets = false,
) {
  const { metadata, sections } = parseSource(source.toString('utf8'), marked, sourcePath);
  const renderer = new marked.Renderer();
  let tableLabel: string | undefined;
  renderer.link = ({ href, title, tokens }) => {
    const canonicalTarget = resolveLink(href, sourcePath, outDir);
    const target = views ? readerHref(href, relativeLink(root, sourcePath), relativeLink(root, path.join(outDir, 'index.html')), views)
      : canonicalTarget;
    return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ''}>${marked.Parser.parseInline(tokens, { renderer })}</a>`;
  };
  renderer.image = token => renderImage(token.href, relativeLink(root, sourcePath),
    relativeLink(root, path.join(outDir, 'index.html')), token.raw, token.text, token.title);
  renderer.table = token => `<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(tableLabel)}の表">${marked.Renderer.prototype.table.call(renderer, token)}</div>`;
  renderer.heading = (token: MimicHeading) => {
    assert(token.mimicId, `subheading needs a mimic:heading directive: ${token.text}`);
    tableLabel = token.text;
    return `<h${token.depth} id="${token.mimicId}">${marked.Parser.parseInline(token.tokens, { renderer })}</h${token.depth}>`;
  };
  renderer.paragraph = (token: MimicParagraph) => {
    const paragraph = marked.Renderer.prototype.paragraph.call(renderer, token);
    if (!token.mimicNote) return paragraph;
    const label = noteLabels[token.mimicNote];
    return `<aside class="note note-${token.mimicNote}" aria-label="${escape(label)}"><p class="note-label">${escape(label)}</p>${paragraph}</aside>`;
  };
  renderer.list = (token: MimicList) => {
    const list = marked.Renderer.prototype.list.call(renderer, token);
    return token.mimicSteps ? list.replace('<ol', `<ol class="steps" style="counter-reset:step ${Number(token.start) - 1}"`) : list;
  };
  const render = (tokens: Token[]) => marked.Parser.parse(tokens, { renderer });
  const section = ({ id, role, heading, tokens }: Section) => {
    const title = heading.text;
    tableLabel = title;
    const subheadings = tokens.filter(isHeading);
    const links = subheadings.length ? `<ul class="section-links">${subheadings.map(token => `<li><a href="#${token.mimicId}">${marked.Parser.parseInline(token.tokens, { renderer })}</a></li>`).join('')}</ul>` : '';
    const body = render(tokens);
    const headingHtml = marked.Parser.parseInline(heading.tokens, { renderer });
    const actions = role === 'purpose' ? '<div id="view-actions" class="reading-links"><a href="#procedure">判断の進め方へ</a><a href="#outputs">判断案と選定理由へ</a><a href="#unverified">未検証事項を確認する</a></div>' : '';
    return `<section id="${escape(id)}" class="knowledge-section"${role ? ` data-section-role="${role}"` : ''}><div class="section-heading"><h2>${headingHtml}</h2><a class="permalink" href="#${escape(id)}" aria-label="${escape(title)}のリンク">#</a></div>${links}${body}${actions}</section>`;
  };
  const navigation = sections.map(({ id, role, heading }) => `<li><a href="#${escape(id)}">${escape(role ? sectionLabels[role] : heading.text)}</a></li>`).join('');
  const topic = path.basename(path.dirname(sourcePath)) === 'topics';
  const sourceLabel = topic ? '案内の原文を読む' : '知識本文を読む';
  const markdownLabel = topic ? '案内のMarkdown' : '本文のMarkdown';
  const home = views ? relativeLink(outDir, path.join(root, 'index.html')) : 'https://9uile.github.io/mimic/';
  const guidelineHref = views ? relativeLink(outDir, path.join(root, 'guideline/index.html')) : 'https://9uile.github.io/mimic/guideline/';
  const graphBase = views ? relativeLink(outDir, path.join(root, 'graph/index.html')) : 'https://9uile.github.io/mimic/graph/';
  const graphHref = graphBase + (path.basename(sourcePath) === 'KNOWLEDGE.md' ? `?concept=${encodeURIComponent(metadata.id)}` : '');
  const sourceLinks = views ? `<a href="${escape(path.basename(sourcePath))}">Markdown原文</a>`
    : `<a href="${escape(relativeLink(outDir, sourcePath))}">${sourceLabel}</a> · <a href="ai.md">${markdownLabel}</a>`;
  const provenanceEntries = {
    id: metadata.id, version: metadata.version, scope: metadata.scope,
    ...(metadata.related.length ? { related: metadata.related.join(', ') } : {}), source: relativeLink(root, sourcePath),
    'source SHA-256': provenance.source, 'design ID': design.id,
    'design version': design.version, 'stylesheet SHA-256': provenance.stylesheet,
    'generator + template SHA-256': provenance.generator, renderer: `marked ${markedVersion}`,
    'renderer SHA-256': provenance.renderer,
  };
  return `<!doctype html>
<html lang="ja" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${pageFontHead(views?.[relativeLink(root, sourcePath)] || 'index.html', pagesAssets)}
<meta name="knowledge-id" content="${escape(metadata.id)}"><meta name="knowledge-version" content="${escape(metadata.version)}"><meta name="source-sha256" content="${provenance.source}">
<meta name="design-id" content="${design.id}"><meta name="design-version" content="${design.version}"><meta name="stylesheet-sha256" content="${provenance.stylesheet}">
<title>${escape(metadata.title)} — Mimic</title>
<style>
${stylesheet}
</style></head><body>
<a class="skip" href="#${escape(sections[0]!.id)}">本文へ</a>
<header><div class="topline"><a class="brand" href="${escape(home)}">Mimic</a><div class="toplinks">
<a href="${escape(graphHref)}">関係グラフ</a><a href="${escape(guidelineHref)}">利用ガイド</a></div></div>
<div class="hero"><h1 id="title">${escape(metadata.title)}</h1><p class="meta">v${escape(metadata.version)}</p></div></header>
<main class="layout"><nav aria-label="目次"><details><summary>目次</summary><ol>${navigation}</ol></details></nav><article>
${sections.map(section).join('\n')}
</article></main>
<footer><div><p>${sourceLinks} · <a href="#top">ページ上部へ</a></p>
<details id="source-provenance"><summary>生成情報・編集元との対応</summary><p>このページとMarkdownは、表示している編集元の内容だけから生成しています。リンク先の概念・出典・例は取り込まないため、必要な参照先も読んでください。生成物を直接編集せず、編集元または表示方法を更新して再生成してください。</p><dl class="metadata">
${Object.entries(provenanceEntries).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}
</dl></details></div></footer></body></html>\n`;
}

export async function renderKnowledge(
  source: Buffer, sourceFile: string, stylesheet: Buffer, views: Readonly<Record<string, string>>,
  pagesAssets = false,
): Promise<Buffer> {
  const markedUrl = process.env.MARKED_MODULE ? pathToFileURL(path.resolve(process.env.MARKED_MODULE)).href : import.meta.resolve('marked');
  const { marked }: typeof import('marked') = await import(markedUrl);
  const sourcePath = path.join(root, sourceFile);
  const outDir = path.dirname(path.join(root, views[sourceFile]!));
  const provenance = {
    source: hash(source), stylesheet: hash(stylesheet),
    generator: hash(Buffer.concat([await readFile(generatorPath), await readFile(path.join(root, 'scripts/knowledge-paths.ts')),
      await readFile(path.join(root, 'scripts/pages-catalog.ts')), await readFile(path.join(root, 'scripts/pages-fonts.ts')),
      await readFile(path.join(root, 'scripts/knowledge-images.ts'))])),
    renderer: hash(await readFile(fileURLToPath(markedUrl))),
  };
  return Buffer.from(makeHtml(source, marked, provenance, sourcePath, outDir, stylesheet.toString('utf8'), views, pagesAssets));
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, source: { type: 'string' }, 'out-dir': { type: 'string' }, 'marked-module': { type: 'string' } } });
  const sourcePath = path.resolve(values.source || path.join(root, 'topics/decision-material-selection.md'));
  const outDir = path.resolve(values['out-dir'] || path.join(root, 'output/knowledge-preview'));
  const modulePath = values['marked-module'] || process.env.MARKED_MODULE;
  const markedUrl = modulePath ? pathToFileURL(path.resolve(modulePath)).href : import.meta.resolve('marked');
  const packagePath = path.resolve(path.dirname(fileURLToPath(markedUrl)), '../package.json');
  const dependency: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  if (typeof dependency !== 'object' || dependency === null || !('name' in dependency) || !('version' in dependency)) throw new Error(`Expected marked ${markedVersion}; got invalid package metadata`);
  if (dependency.name !== 'marked' || dependency.version !== markedVersion) throw new Error(`Expected marked ${markedVersion}; got ${dependency.name} ${dependency.version}`);
  const { marked }: typeof import('marked') = await import(markedUrl);
  const source = await readFile(sourcePath);
  const stylesheet = await readFile(stylesheetPath);
  assert(!/@import|url\(|<\/?style\b/i.test(stylesheet.toString('utf8')), 'stylesheet must be self-contained CSS');
  const generatorSources = Buffer.concat([
    await readFile(generatorPath),
    await readFile(path.join(path.dirname(generatorPath), 'knowledge-paths.ts')),
    await readFile(path.join(path.dirname(generatorPath), 'pages-catalog.ts')),
    await readFile(path.join(path.dirname(generatorPath), 'pages-fonts.ts')),
    await readFile(path.join(path.dirname(generatorPath), 'knowledge-images.ts')),
  ]);
  const provenance = {
    source: hash(source),
    stylesheet: hash(stylesheet),
    generator: hash(generatorSources),
    renderer: hash(await readFile(fileURLToPath(markedUrl))),
  };
  const html = Buffer.from(makeHtml(source, marked, provenance, sourcePath, outDir, stylesheet.toString('utf8')));
  const outputs = new Map([['ai.md', makeAiMarkdown(source, marked, sourcePath, outDir)], ['index.html', html]]);
  if (values.check) {
    const stale = [];
    for (const [name, expected] of outputs) {
      const actual = await readFile(path.join(outDir, name)).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
      if (!actual?.equals(expected)) stale.push(name);
    }
    if (stale.length) throw new Error(`Generated output is stale or missing: ${stale.join(', ')}. Run build:prototype.`);
    console.log('Knowledge outputs are current.');
  } else {
    await mkdir(outDir, { recursive: true });
    for (const [name, bytes] of outputs) await writeFile(path.join(outDir, name), bytes);
    console.log(`Generated ${[...outputs.keys()].join(', ')} from ${relativeLink(root, sourcePath)}.`);
  }
}

if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
