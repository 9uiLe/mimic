import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readerHref } from '../scripts/pages-catalog.ts';

test('reader navigation maps a canonical concept to its HTML view and preserves the section fragment', () => {
  const actual = readerHref('../grouping/KNOWLEDGE.md#概念', 'knowledge/visual-hierarchy/KNOWLEDGE.md',
    'knowledge/visual-hierarchy/index.html', { 'knowledge/grouping/KNOWLEDGE.md': 'knowledge/grouping/index.html' });
  assert.equal(actual, '../grouping/index.html#概念', 'reader link must reach the reviewed HTML concept and original section');
});
