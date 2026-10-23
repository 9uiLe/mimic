import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'bun:test';
import { compileDesignTokens } from '../scripts/design-tokens.ts';
import { renderDesignSpecimens } from '../scripts/design-specimens.ts';
import { renderReader } from '../scripts/pages-design.ts';

const tokenSource = JSON.parse(await readFile(new URL('../design/tokens.json', import.meta.url), 'utf8'));

test('design specimens display changed token values and all eight live typography roles', () => {
  const changed = structuredClone(tokenSource);
  changed.base.color.ink.value = '#121212';
  changed.base.size.body.value = '1.125rem';
  changed.base.family.reading.value = ['Changed Font', 'sans-serif'];
  const html = renderDesignSpecimens(compileDesignTokens(changed).resolved);
  assert.ok(html.includes('role.color.text · #121212'), 'color specimen values must follow the current token source');
  assert.ok(html.includes('role.color.link · #121212'), 'color specimens must resolve chained aliases');
  assert.ok(html.includes('style="--specimen-color:var(--role-color-text)"'), 'color swatches must use the generated role variable');
  assert.ok(html.includes('<dt>文字サイズ</dt><dd>1.125rem</dd>'), 'type specimen metadata must follow the current token source');
  assert.ok(html.includes('<dt>書体・代替書体</dt><dd>Changed Font, sans-serif</dd>'));
  for (const role of ['body', 'display', 'title', 'section', 'subheading', 'label', 'supporting', 'code']) {
    assert.ok(html.includes(`<p class="type-${role} specimen-text">知識を読み、違いを確かめる。Design for UI 0123456789</p>`),
      `type specimen must render the same mixed-language sentence using the live ${role} class`);
  }
  assert.equal([...html.matchAll(/class="type-specimen"/g)].length, 8);
  for (const field of ['書体・代替書体', '文字サイズ', '太さ', '字間', '行高']) {
    assert.equal([...html.matchAll(new RegExp(`<dt>${field}</dt>`, 'g'))].length, 8, `all eight roles must disclose ${field}`);
  }
  assert.ok(html.includes('const knowledgeCount = 20;'), 'the code role must include actual code text');
  assert.ok(html.includes('background:var(--role-color-canvas)') && html.includes('background:var(--role-color-subtle)'));
  assert.ok(html.includes('specimen-chip specimen-chip-focus'), 'focus must use the outline specimen');
  assert.ok(!html.includes('background:var(--role-color-focus)'), 'focus must not become a filled background specimen');
});

test('generated specimens remain siblings of the complete canonical article and provenance', () => {
  const article = '<section><h2 id="色の役割と組合せ">色の役割と組合せ</h2><p>正本の本文。</p></section>';
  const provenance = '<details id="source-provenance"><summary>生成情報</summary><p>source SHA-256: abc</p></details>';
  const original = `<html><head><title>ガイド</title></head><body><h1 id="title">ガイド</h1>`
    + `<article>${article}</article><footer><div>${provenance}</div></footer></body></html>`;
  const specimens = renderDesignSpecimens(compileDesignTokens(tokenSource).resolved);
  const html = renderReader(original, 'guideline/design-system.html', 'guideline/design-system.md', specimens);
  assert.ok(html.includes(`<article class="prose">${article}</article>${specimens}`), 'specimens must follow the complete canonical article');
  assert.ok(html.includes(provenance), 'generated specimens must retain the canonical source provenance');
  assert.ok(!renderReader(original, 'guideline/ai.html', 'guideline/ai.md').includes('id="design-color-specimens"'));
});
