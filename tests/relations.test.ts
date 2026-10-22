import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'bun:test';
import { loadRelationBundle } from '../scripts/relations.ts';
import type { RelationBundle, RelationGraph, RelationVocabulary } from '../scripts/relations.ts';

const calculationScope = 'WCAG比の計算が、sRGBの相対輝度を入力に使う範囲。';
const transitivityMeaning = 'falseは推移規則なし。A→Cの不存在や偽を意味しない。';
const absenceMeaning = '未記載は無関係や不存在を意味しない。';
const readingMeaning = '辺は読む義務を定めない。';

function conceptBody(id: string): string {
  return `---\nid: ${id}\ntitle: ${id}\nversion: "1.0.1"\nscope: example\n---\n\n# ${id}\n\n## 根拠\n\n相対輝度を計算に使う。\n\n## 別の節\n\nここだけの記述。\n`;
}

function fixtureBundle(): RelationBundle {
  const nodes = ['contrast', 'luminance', 'context'].map((id) => ({
    id, title: id, path: `knowledge/${id}/KNOWLEDGE.md`, version: '1.0.1',
    sha256: createHash('sha256').update(conceptBody(id)).digest('hex'),
  }));
  const graph: RelationGraph = {
    schema_version: 1,
    coverage: { nodes: '全fixture概念', absence: absenceMeaning, reading: readingMeaning },
    nodes,
    edges: [
      {
        id: 'ratio-input', from: 'contrast', to: 'luminance', type: 'depends_on_computation',
        statement: '比の計算が相対輝度を使う。', scope: calculationScope,
        evidence: [{ concept: 'contrast', heading: '根拠', quotation: '相対輝度を計算に使う。' }],
      },
      {
        id: 'contrast-context', from: 'contrast', to: 'context', type: 'complemented_by', statement: '説明を補う。',
        evidence: [{ concept: 'contrast', heading: '根拠', quotation: '相対輝度を計算に使う。' }],
      },
      {
        id: 'context-contrast', from: 'context', to: 'contrast', type: 'complemented_by', statement: '説明を補う。',
        evidence: [{ concept: 'context', heading: '根拠', quotation: '相対輝度を計算に使う。' }],
      },
    ],
  };
  const vocabulary: RelationVocabulary = {
    schema_version: 1,
    interpretation: { transitive_false: transitivityMeaning, absence: absenceMeaning, reading: readingMeaning },
    types: [
      { id: 'depends_on_computation', label: '計算依存', description: 'fromの計算がtoの量を使う。', directed: true,
        transitive: false, inverse_description: '入力を使う側を逆参照できる。', cycle_policy: '根拠を点検する。' },
      { id: 'complemented_by', label: '補完', description: 'fromの説明をtoが補う。', directed: true,
        transitive: false, inverse_description: '同じ辺を逆参照する。', cycle_policy: '許容する。' },
      { id: 'distinguished_from', label: '相違', description: '階層や対立を意味しない。', directed: false,
        transitive: false, inverse_description: '対称の索引。', cycle_policy: '許容する。' },
    ],
  };
  return { graph, vocabulary };
}

async function saveBundle(root: string, bundle: RelationBundle): Promise<void> {
  await writeFile(path.join(root, 'relations/graph.json'), `${JSON.stringify(bundle.graph, null, 2)}\n`);
  await writeFile(path.join(root, 'relations/vocabulary.json'), `${JSON.stringify(bundle.vocabulary, null, 2)}\n`);
}

async function withFixture(action: (root: string, bundle: RelationBundle) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimic-relations-'));
  const bundle = fixtureBundle();
  try {
    await mkdir(path.join(root, 'relations'));
    for (const node of bundle.graph.nodes) {
      await mkdir(path.dirname(path.join(root, node.path)), { recursive: true });
      await writeFile(path.join(root, node.path), conceptBody(node.id));
    }
    await saveBundle(root, bundle);
    await action(root, bundle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(root: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../scripts/relations.ts'), ...args], { cwd: root });
}

test('relations preserve scoped direction, nontransitive meaning, and reader discretion', async () => {
  await withFixture(async (root) => {
    const bundle = await loadRelationBundle(root);
    const dependency = bundle.graph.edges.find((edge) => edge.id === 'ratio-input');
    assert.equal(dependency?.from, 'contrast');
    assert.equal(dependency?.to, 'luminance');
    assert.equal(dependency?.scope, calculationScope);
    assert.equal(bundle.vocabulary.types.find((relation) => relation.id === 'depends_on_computation')?.transitive, false);
    assert.equal(bundle.vocabulary.interpretation.transitive_false, transitivityMeaning);
    assert.equal(bundle.graph.coverage.absence, absenceMeaning);
    assert.equal(bundle.graph.coverage.reading, readingMeaning);
    assert.equal(bundle.graph.edges.length, 3, 'loading must not add reversed or transitively inferred edges');
  });
});

test('relations reject an unknown endpoint before they can be published', async () => {
  await withFixture(async (root, bundle) => {
    bundle.graph.edges[0]!.to = 'missing';
    await saveBundle(root, bundle);
    await assert.rejects(loadRelationBundle(root), /unknown endpoint/, 'unknown endpoint must prevent a usable bundle');
  });
});

test('relations reject stale body bytes even when the version remains unchanged', async () => {
  await withFixture(async (root) => {
    await writeFile(path.join(root, 'knowledge/contrast/KNOWLEDGE.md'), `${conceptBody('contrast')}\n追記。\n`);
    await assert.rejects(loadRelationBundle(root), /stale body SHA-256/, 'changed body bytes must invalidate relation evidence');
  });
});

test('relations reject an outdated body version', async () => {
  await withFixture(async (root, bundle) => {
    bundle.graph.nodes[0]!.version = '0.9.0';
    await saveBundle(root, bundle);
    await assert.rejects(loadRelationBundle(root), /body version mismatch/);
  });
});

test('relations reject evidence quoted from a different section', async () => {
  await withFixture(async (root, bundle) => {
    bundle.graph.edges[0]!.evidence[0]!.quotation = 'ここだけの記述。';
    await saveBundle(root, bundle);
    await assert.rejects(loadRelationBundle(root), /evidence heading or quotation mismatch/,
      'a quotation elsewhere in the body must not validate the named evidence section');
  });
});

test('relations reject duplicate IDs, self references, types, and symmetric duplicates', async () => {
  const faults: Array<(bundle: RelationBundle) => void> = [
    (bundle) => { bundle.graph.nodes.push(bundle.graph.nodes[0]!); },
    (bundle) => { bundle.graph.edges.push(bundle.graph.edges[0]!); },
    (bundle) => { bundle.vocabulary.types.push(bundle.vocabulary.types[0]!); },
    (bundle) => { bundle.graph.edges[0]!.to = 'contrast'; },
    (bundle) => { bundle.graph.edges[0]!.type = 'unknown'; },
    (bundle) => { delete bundle.graph.edges[0]!.scope; },
    (bundle) => {
      bundle.graph.edges[1]!.type = 'distinguished_from';
      bundle.graph.edges[2]!.type = 'distinguished_from';
    },
  ];
  for (const introduceFault of faults) {
    await withFixture(async (root, bundle) => {
      introduceFault(bundle);
      await saveBundle(root, bundle);
      await assert.rejects(loadRelationBundle(root));
    });
  }
});

test('relations require every concept and reject noncanonical or symbolic body paths', async () => {
  await withFixture(async (root) => {
    await mkdir(path.join(root, 'knowledge/omitted'));
    await writeFile(path.join(root, 'knowledge/omitted/KNOWLEDGE.md'), conceptBody('omitted'));
    await assert.rejects(loadRelationBundle(root), /concept missing from graph.nodes/);
  });
  await withFixture(async (root, bundle) => {
    bundle.graph.nodes[0]!.path = '../outside.md';
    await saveBundle(root, bundle);
    await assert.rejects(loadRelationBundle(root), /noncanonical body path/);
  });
  await withFixture(async (root) => {
    const bodyPath = path.join(root, 'knowledge/contrast/KNOWLEDGE.md');
    await rm(bodyPath);
    await symlink(path.join(root, 'knowledge/context/KNOWLEDGE.md'), bodyPath);
    await assert.rejects(loadRelationBundle(root), /symbolic links are not allowed/);
  });
});

test('relations sync refreshes only metadata after validating the unchanged evidence', async () => {
  await withFixture(async (root, original) => {
    const updatedBody = conceptBody('contrast').replace('title: contrast', 'title: 新題名').replace('"1.0.1"', '"1.0.2"');
    await writeFile(path.join(root, 'knowledge/contrast/KNOWLEDGE.md'), updatedBody);
    const result = runCli(root, '--sync');
    assert.equal(result.exitCode, 0, result.stderr.toString());
    const synchronized = await loadRelationBundle(root);
    assert.deepEqual(synchronized.graph.edges, original.graph.edges, 'sync must preserve all relation assertions');
    assert.deepEqual(synchronized.graph.coverage, original.graph.coverage);
    assert.deepEqual(synchronized.vocabulary, original.vocabulary);
    assert.equal(synchronized.graph.nodes[0]!.title, '新題名');
    assert.equal(synchronized.graph.nodes[0]!.version, '1.0.2');
    assert.equal(synchronized.graph.nodes[0]!.sha256, createHash('sha256').update(updatedBody).digest('hex'));
  });
});

test('relations sync refuses invalid evidence without changing the graph file', async () => {
  await withFixture(async (root) => {
    const graphPath = path.join(root, 'relations/graph.json');
    const before = await readFile(graphPath, 'utf8');
    await writeFile(path.join(root, 'knowledge/contrast/KNOWLEDGE.md'), conceptBody('contrast').replace('相対輝度を計算に使う。', '変更。'));
    const result = runCli(root, '--sync');
    assert.notEqual(result.exitCode, 0, 'sync must refuse a body whose evidence no longer matches');
    assert.match(result.stderr.toString(), /evidence heading or quotation mismatch/);
    assert.equal(await readFile(graphPath, 'utf8'), before, 'failed sync must leave the graph file byte-for-byte unchanged');
  });
});


test('relations sync rejects unknown edge fields without losing annotations', async () => {
  await withFixture(async (root, bundle) => {
    Object.assign(bundle.graph.edges[0]!, { editorial_note: '未対応の注釈も黙って消さない。' });
    await saveBundle(root, bundle);
    const graphPath = path.join(root, 'relations/graph.json');
    const before = await readFile(graphPath, 'utf8');
    await assert.rejects(loadRelationBundle(root), /unknown field editorial_note/,
      'unknown fields must reject before annotations can be dropped');
    const result = runCli(root, '--sync');
    assert.notEqual(result.exitCode, 0, 'sync must refuse unknown fields instead of discarding annotations');
    assert.match(result.stderr.toString(), /unknown field editorial_note/);
    assert.equal(await readFile(graphPath, 'utf8'), before, 'rejected annotations must leave the graph bytes unchanged');
  });
});
