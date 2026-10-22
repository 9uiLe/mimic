import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { relativeLink } from '../scripts/knowledge-paths.ts';

test('output-relative knowledge link preserves the documented concept destination', () => {
  assert.equal(
    relativeLink('/repo/prototypes/decision-material-selection', '/repo/knowledge/grouping/KNOWLEDGE.md'),
    '../../knowledge/grouping/KNOWLEDGE.md',
    'generated knowledge link must preserve the documented concept destination',
  );
});
