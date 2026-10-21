import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const generatorPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(generatorPath), '..');
const markedVersion = '17.0.5';
const stylesheetPath = path.join(path.dirname(generatorPath), 'knowledge-view.css');
const design = { id: 'mimic-knowledge-view', version: '1.0.0' };
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
const sectionRoles = Object.keys(sectionLabels);
const noteLabels = { proposal: '提案', assumption: '仮定', limitation: '限界・未確認', 'evidence-scope': '根拠の範囲' };
const statusLabels = { proposed: '仮案', draft: '更新案（未採用）' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const assert = (condition, message) => { if (!condition) throw new Error(`Source schema: ${message}`); };
const relativeLink = (from, to) => path.relative(from, to).split(path.sep).join('/');
const isRelativeHref = href => !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#');

function resolveLink(href, sourcePath, outDir) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    assert(/^https?:/i.test(href), `unsupported link protocol ${href}`);
    return href;
  }
  if (href.startsWith('#')) return href;
  assert(!href.startsWith('//') && !path.isAbsolute(href), `unsupported absolute link ${href}`);
  const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/s);
  return relativeLink(outDir, path.resolve(path.dirname(sourcePath), decodeURI(pathname))) + suffix;
}

function makeAiMarkdown(source, marked, sourcePath, outDir) {
  const failUnless = (condition, message) => { if (!condition) throw new Error(`AI Markdown links: ${message}`); };
  const text = source.toString('utf8');
  const frontmatter = text.match(/^---\n[\s\S]*?\n---\n/)[0];
  const body = text.slice(frontmatter.length);
  const blocks = marked.lexer(body);
  failUnless(!Object.keys(blocks.links || {}).length, 'reference-style link definitions are unsupported');
  failUnless(blocks.map(token => token.raw).join('') === body, 'source cannot be preserved exactly; reference definitions and normalized block syntax are unsupported');
  const localLinks = tokens => {
    const links = [];
    marked.walkTokens(tokens, token => { if (token.type === 'link' && isRelativeHref(token.href)) links.push(token); });
    return links;
  };
  const result = blocks.map(block => {
    const links = localLinks([block]);
    if (!links.length) return block.raw;
    failUnless(['paragraph', 'heading', 'table'].includes(block.type), `relative links inside ${block.type} are unsupported; use a paragraph, heading, or table`);
    const inline = marked.Lexer.lexInline(block.raw);
    failUnless(inline.map(token => token.raw).join('') === block.raw, 'inline syntax cannot be preserved exactly');
    const edits = [];
    const found = [];
    const visit = (tokens, offset) => {
      let cursor = offset;
      for (const token of tokens) {
        if (token.type === 'link' && isRelativeHref(token.href)) {
          const prefix = `[${token.text}](`;
          failUnless(token.raw.startsWith(prefix), 'only inline [label](path) relative links are supported');
          const destinationOffset = prefix.length + token.raw.slice(prefix.length).match(/^\s*/)[0].length;
          const destinationEnd = destinationOffset + token.href.length;
          failUnless(token.raw.slice(destinationOffset, destinationEnd) === token.href && /[\s)]/.test(token.raw[destinationEnd] || ''), `escaped or angle-bracket destination is unsupported: ${token.raw}`);
          failUnless(/^[\p{L}\p{N}._~/-]+(?:[?#][^\s<>"'()\\]*)?$/u.test(token.href), `unsupported relative destination: ${token.href}`);
          const suffix = token.href.match(/^([^?#]*)(.*)$/s)[2];
          const target = resolveLink(token.href, sourcePath, outDir);
          const targetPath = suffix ? target.slice(0, -suffix.length) : target;
          const href = targetPath.split('/').map(segment => encodeURIComponent(segment)).join('/') + suffix;
          edits.push({ start: cursor + destinationOffset, end: cursor + destinationEnd, href });
          found.push(token);
        } else if (token.type !== 'link' && token.tokens && localLinks(token.tokens).length) {
          const inner = token.tokens.map(child => child.raw).join('');
          const start = token.raw.indexOf(inner);
          failUnless(start >= 0 && start === token.raw.lastIndexOf(inner), `unsupported nested inline syntax: ${token.type}`);
          visit(token.tokens, cursor + start);
        }
        cursor += token.raw.length;
      }
    };
    visit(inline, 0);
    const signature = tokens => JSON.stringify(tokens.map(token => [token.raw, token.href]));
    failUnless(signature(found) === signature(links), 'block and inline link positions disagree; this syntax is unsupported');
    let raw = block.raw;
    for (const edit of edits.sort((a, b) => b.start - a.start)) raw = raw.slice(0, edit.start) + edit.href + raw.slice(edit.end);
    return raw;
  }).join('');
  return Buffer.from(frontmatter + result);
}

function parseSource(text, marked) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, 'expected LF frontmatter at the start');
  const metadata = {};
  for (const line of frontmatter[1].split('\n')) {
    if (/^  - /.test(line)) {
      assert(Array.isArray(metadata.related), 'unexpected frontmatter list');
      metadata.related.push(line.slice(4));
      continue;
    }
    const field = line.match(/^(id|title|status|version|scope|related):(?: (.*))?$/);
    assert(field && !Object.hasOwn(metadata, field[1]), `unsupported or duplicate frontmatter: ${line}`);
    metadata[field[1]] = field[1] === 'related' ? [] : (field[2] || '').replace(/^"(.*)"$/, '$1');
  }
  for (const key of ['id', 'title', 'status', 'version', 'scope']) assert(typeof metadata[key] === 'string' && metadata[key], `missing ${key}`);
  assert(Array.isArray(metadata.related) && metadata.related.length, 'missing related');
  assert(metadata.id === 'decision-material-selection', 'unsupported knowledge id');
  const tokens = marked.lexer(text.slice(frontmatter[0].length));
  const content = tokens.filter(token => token.type !== 'space');
  assert(content[0]?.type === 'heading' && content[0].depth === 1 && content[0].text === metadata.title, 'title and H1 must match');
  assert(content.filter(token => token.type === 'heading' && token.depth === 1).length === 1, 'expected one H1');
  const groups = new Map();
  const usedIds = new Set([...sectionRoles, 'top', 'title', 'view-actions', 'source-provenance']);
  let current;
  let pending;
  for (const token of content.slice(1)) {
    if (token.type === 'html') {
      const directive = token.raw.trim().match(/^<!-- mimic:(section|heading|note) ([a-z][a-z0-9-]*) -->$/);
      assert(directive, 'unsupported HTML or directive; only mimic:section, mimic:heading, and mimic:note comments are allowed');
      assert(!pending, 'a directive must be followed by its content');
      const [, kind, value] = directive;
      if (kind === 'section') assert(Object.hasOwn(sectionLabels, value), `unknown section role ${value}`);
      if (kind === 'note') assert(Object.hasOwn(noteLabels, value), `unknown note type ${value}`);
      pending = { kind, value };
      continue;
    }
    if (token.type === 'heading' && token.depth === 2) {
      assert(pending?.kind === 'section', `H2 needs a mimic:section directive: ${token.text}`);
      current = pending.value;
      assert(!groups.has(current), `duplicate section role ${current}`);
      groups.set(current, { heading: token, tokens: [] });
    } else {
      assert(current, 'content outside a section');
      if (token.type === 'heading') {
        assert(token.depth >= 3 && pending?.kind === 'heading', `subheading needs a mimic:heading directive: ${token.text}`);
        assert(!usedIds.has(pending.value), `duplicate or reserved heading ID ${pending.value}`);
        token.mimicId = pending.value;
        usedIds.add(pending.value);
      } else if (pending) {
        assert(pending.kind === 'note' && token.type === 'paragraph', 'mimic:note must immediately precede one paragraph');
        token.mimicNote = pending.value;
      }
      if (current === 'procedure' && token.type === 'list' && token.ordered) token.mimicSteps = true;
      groups.get(current).tokens.push(token);
    }
    pending = null;
  }
  assert(!pending, 'directive at the end has no content');
  for (const role of sectionRoles) {
    assert(groups.has(role), `missing section role ${role}`);
    assert(groups.get(role).tokens.some(token => token.type !== 'heading'), `empty section ${role}`);
  }
  assert(groups.get('procedure').tokens.some(token => token.mimicSteps), 'procedure needs an ordered list');
  marked.walkTokens([content[0], ...[...groups.values()].flatMap(group => [group.heading, ...group.tokens])], token => {
    assert(token.type !== 'html' && token.type !== 'image', `unsupported ${token.type}; no embedded HTML or remote assets`);
  });
  return { metadata, groups };
}

function makeHtml(source, marked, provenance, sourcePath, outDir, stylesheet) {
  const { metadata, groups } = parseSource(source.toString('utf8'), marked);
  const renderer = new marked.Renderer();
  let tableLabel;
  renderer.link = ({ href, title, tokens }) => {
    const target = resolveLink(href, sourcePath, outDir);
    return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ''}>${marked.Parser.parseInline(tokens, { renderer })}</a>`;
  };
  renderer.table = token => `<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(tableLabel)}の表">${marked.Renderer.prototype.table.call(renderer, token)}</div>`;
  renderer.heading = token => {
    assert(token.mimicId, `subheading needs a mimic:heading directive: ${token.text}`);
    tableLabel = token.text;
    return `<h${token.depth} id="${token.mimicId}">${marked.Parser.parseInline(token.tokens, { renderer })}</h${token.depth}>`;
  };
  renderer.paragraph = token => {
    const paragraph = marked.Renderer.prototype.paragraph.call(renderer, token);
    if (!token.mimicNote) return paragraph;
    const label = noteLabels[token.mimicNote];
    return `<aside class="note note-${token.mimicNote}" aria-label="${escape(label)}"><p class="note-label">${escape(label)}</p>${paragraph}</aside>`;
  };
  renderer.list = token => {
    const list = marked.Renderer.prototype.list.call(renderer, token);
    return token.mimicSteps ? list.replace('<ol', `<ol class="steps" style="counter-reset:step ${Number(token.start) - 1}"`) : list;
  };
  const render = tokens => marked.Parser.parse(tokens, { renderer });
  const section = id => {
    const { heading, tokens } = groups.get(id);
    const title = heading.text;
    tableLabel = title;
    const subheadings = tokens.filter(token => token.type === 'heading');
    const links = subheadings.length ? `<ul class="section-links">${subheadings.map(token => `<li><a href="#${token.mimicId}">${marked.Parser.parseInline(token.tokens, { renderer })}</a></li>`).join('')}</ul>` : '';
    const body = render(tokens);
    const headingHtml = marked.Parser.parseInline(heading.tokens, { renderer });
    const actions = id === 'purpose' ? '<div id="view-actions" class="reading-links"><a href="#procedure">判断の進め方へ</a><a href="#outputs">判断案と選定理由へ</a><a href="#unverified">未検証事項を確認する</a></div>' : '';
    return `<section id="${id}" class="knowledge-section" data-section-role="${id}"><div class="section-heading"><h2>${headingHtml}</h2><a class="permalink" href="#${id}" aria-label="${escape(title)}のリンク">#</a></div>${links}${body}${actions}</section>`;
  };
  const navigation = sectionRoles.map(id => `<li><a href="#${id}">${escape(sectionLabels[id])}</a></li>`).join('');
  const statusLabel = Object.hasOwn(statusLabels, metadata.status) ? statusLabels[metadata.status] : `状態の意味は未確認（原値: ${metadata.status}）`;
  const sourceLabel = metadata.status === 'proposed' ? '正本を読む' : metadata.status === 'draft' ? '更新案の原文を読む' : '編集元を読む';
  return `<!doctype html>
<html lang="ja" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="knowledge-id" content="${escape(metadata.id)}"><meta name="knowledge-version" content="${escape(metadata.version)}"><meta name="source-sha256" content="${provenance.source}">
<meta name="design-id" content="${design.id}"><meta name="design-version" content="${design.version}"><meta name="stylesheet-sha256" content="${provenance.stylesheet}">
<title>${escape(metadata.title)} — Mimic</title>
<style>
${stylesheet}
</style></head><body>
<a class="skip" href="#purpose">本文へ</a>
<header><div class="topline"><div class="brand">Mimic</div><div class="toplinks"><a href="${escape(relativeLink(outDir, sourcePath))}">${sourceLabel}</a><a href="ai.md">AI 向け全文</a></div></div>
<div class="hero"><div class="eyebrow"><span class="badge">${escape(statusLabel)}</span>KNOWLEDGE</div><h1 id="title">${escape(metadata.title)}</h1><div class="meta">${escape(metadata.id)} · v${escape(metadata.version)}</div></div></header>
<main class="layout"><nav aria-label="目次"><p>この知識の全体像</p><ol>${navigation}</ol></nav><article>
${sectionRoles.map(id => section(id)).join('\n')}
</article></main>
<footer><div><p><a href="${escape(relativeLink(outDir, sourcePath))}">${sourceLabel}</a> · <a href="ai.md">AI 向け全文</a> · <a href="#top">ページ上部へ</a></p>
<details id="source-provenance"><summary>生成情報・正本との対応</summary><p>このページと AI 向け全文は編集元の Markdown から生成しています。生成物を直接編集せず、編集元または表示方法を更新して再生成してください。</p><dl class="metadata">
${Object.entries({ id: metadata.id, version: metadata.version, status: metadata.status, scope: metadata.scope, related: metadata.related.join(', '), source: relativeLink(root, sourcePath), 'source SHA-256': provenance.source, 'design ID': design.id, 'design version': design.version, 'stylesheet SHA-256': provenance.stylesheet, 'generator + template SHA-256': provenance.generator, renderer: `marked ${markedVersion}`, 'renderer SHA-256': provenance.renderer }).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}
</dl></details></div></footer></body></html>\n`;
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, source: { type: 'string' }, 'out-dir': { type: 'string' }, 'marked-module': { type: 'string' } } });
  const sourcePath = path.resolve(values.source || path.join(root, 'knowledge/decision-material-selection.md'));
  const outDir = path.resolve(values['out-dir'] || path.join(root, 'prototypes/decision-material-selection'));
  const modulePath = values['marked-module'] || process.env.MARKED_MODULE;
  const markedUrl = modulePath ? pathToFileURL(path.resolve(modulePath)).href : import.meta.resolve('marked');
  const packagePath = path.resolve(path.dirname(fileURLToPath(markedUrl)), '../package.json');
  const dependency = JSON.parse(await readFile(packagePath, 'utf8'));
  if (dependency.name !== 'marked' || dependency.version !== markedVersion) throw new Error(`Expected marked ${markedVersion}; got ${dependency.name} ${dependency.version}`);
  const { marked } = await import(markedUrl);
  const source = await readFile(sourcePath);
  const stylesheet = await readFile(stylesheetPath);
  assert(!/@import|url\(|<\/?style\b/i.test(stylesheet.toString('utf8')), 'stylesheet must be self-contained CSS');
  const provenance = { source: hash(source), stylesheet: hash(stylesheet), generator: hash(await readFile(generatorPath)), renderer: hash(await readFile(fileURLToPath(markedUrl))) };
  const html = Buffer.from(makeHtml(source, marked, provenance, sourcePath, outDir, stylesheet.toString('utf8')));
  const outputs = new Map([['ai.md', makeAiMarkdown(source, marked, sourcePath, outDir)], ['index.html', html]]);
  if (values.check) {
    const stale = [];
    for (const [name, expected] of outputs) {
      const actual = await readFile(path.join(outDir, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
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

main().catch(error => { console.error(error.message); process.exitCode = 1; });
