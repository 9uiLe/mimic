import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { renderRelationGraph } from '../scripts/build-relation-graph.ts';
import type { RelationBundle } from '../scripts/relations.ts';

function fixture(): RelationBundle {
  return {
    graph: {
      schema_version: 1, coverage: { policy: 'explicit-only' },
      nodes: [
        { id: 'alpha', title: '概念A', path: 'knowledge/alpha/KNOWLEDGE.md', version: '1.2.3', sha256: 'a'.repeat(64) },
        { id: 'beta', title: '概念B', path: 'knowledge/beta/KNOWLEDGE.md', version: '2.0.0', sha256: 'b'.repeat(64) },
        { id: 'isolated', title: '独立した概念', path: 'knowledge/isolated/KNOWLEDGE.md', version: '1.0.0', sha256: 'c'.repeat(64) },
      ],
      edges: [
        { id: 'alpha-needs-beta', from: 'alpha', to: 'beta', type: 'depends-on', statement: 'Aの説明ではBを前提にする。',
          scope: '計算を説明する場面に限る。', evidence: [{ concept: 'beta', heading: '定義と Background', quotation: '計算にはBを使う。' }] },
        { id: 'alpha-differs-beta', from: 'alpha', to: 'beta', type: 'differs-from', statement: 'AとBは対象が異なる。',
          evidence: [{ concept: 'alpha', heading: '概念', quotation: 'AとBを区別する。' }] },
      ],
    },
    vocabulary: {
      schema_version: 1, interpretation: { policy: 'no-inference' },
      types: [
        { id: 'depends-on', label: '依存', description: '説明の前提になる。', directed: true, transitive: false,
          inverse_description: '説明の前提として使われる。', cycle_policy: 'explicit' },
        { id: 'differs-from', label: '相違', description: '異なる点を説明する。', directed: false, transitive: false,
          inverse_description: '異なる点を説明する。', cycle_policy: 'allowed' },
      ],
    },
  };
}

test('graph reader preserves relation direction, meaning, scope, and evidence destinations without JavaScript', () => {
  const html = renderRelationGraph(fixture(), 'body{}');
  const directed = html.match(/<article id="relation-alpha-needs-beta"[\s\S]*?<\/article>/)?.[0];
  assert.ok(directed);
  assert.ok(directed.includes('href="../knowledge/alpha/index.html">概念A</a> <span aria-label="左の概念から右の概念への関係">→</span>'),
    'directed relation must start at alpha and point toward beta');
  assert.ok(directed.includes('→</span> <a href="../knowledge/beta/index.html">概念B</a>'),
    'directed relation must end at beta');
  assert.ok(directed.includes('Aの説明ではBを前提にする。'), 'relation statement must remain readable without JavaScript');
  assert.ok(directed.includes('計算を説明する場面に限る。'), 'relation scope must remain readable without JavaScript');
  assert.ok(decodeURI(directed).includes('href="../knowledge/beta/index.html#定義と-background"'), 'evidence must reach the cited concept heading');
  assert.ok(directed.includes('計算にはBを使う。'), 'evidence quotation must remain readable');
  const symmetric = html.match(/<article id="relation-alpha-differs-beta"[\s\S]*?<\/article>/)?.[0];
  assert.ok(symmetric?.includes('対称の関係・読む向きによる意味の違いなし">↔</span>'),
    'symmetric relation must not imply a one-way dependency');
  assert.ok(html.includes('<details id="graph-fallback" open>'), 'full relation list must be open before JavaScript runs');
  assert.ok(html.includes('href="../knowledge/isolated/index.html">独立した概念</a> <span class="meta">v1.0.0 · 関係 0件'),
    'isolated concepts must remain available');
  assert.ok(html.includes('3概念 · 2関係'), 'multiple relations between the same concepts must not collapse');
  assert.ok(html.includes('配置の上下や距離は、階層や関係の強さを表しません。'), 'graph layout must not imply a semantic hierarchy or strength');
  assert.ok(html.includes('href="../relations/index.html">関係データの読み方</a>'), 'readers must reach the relation interpretation guide');
});

test('graph data and visible text escape script terminators and markup independently', () => {
  const bundle = fixture();
  bundle.graph.nodes[0]!.title = '</script><img src=x onerror=alert(1)> & "A"';
  bundle.graph.edges[0]!.statement = '<script>alert("meaning")</script>';
  bundle.graph.edges[0]!.evidence[0]!.quotation = '<svg onload=alert(1)>';
  const html = renderRelationGraph(bundle, 'body{}');
  const embedded = html.match(/<script id="relation-bundle" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(embedded);
  assert.ok(!embedded.includes('<'), 'embedded JSON must not contain an HTML script terminator');
  assert.deepEqual(JSON.parse(embedded), bundle, 'escaped JSON must preserve the exact graph values');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;meaning&quot;)&lt;/script&gt;'), 'meaning must be escaped as visible text');
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'), 'quotation must be escaped as visible text');
  assert.doesNotMatch(html, /<img src=x|<svg onload=/, 'untrusted text must not create executable HTML');
});

test('Pages graph loads only same-origin script and styles and stays within a project prefix', () => {
  const html = renderRelationGraph(fixture(), 'body{}');
  assert.ok(html.includes("script-src 'self'"), 'graph CSP must permit the same-origin enhancement');
  assert.ok(html.includes('<script src="../web/graph.js" defer></script>'), 'executable JavaScript must be an external same-origin asset');
  assert.doesNotMatch(html, /script-src[^";]*unsafe-inline|\son(?:click|load|error)=|(?:href|src)="https?:\/\//);
  assert.ok(html.includes('href="../web/graph.css"'));
  assert.ok(html.includes('href="../assets/fonts/gen-interface-jp/0.8.0/400.css"'));
  assert.ok(html.includes('href="../assets/fonts/gen-interface-jp/0.8.0/600.css"'));
  assert.ok(html.includes('href="../relations/graph.json"'));
  assert.ok(html.includes('href="../relations/vocabulary.json"'));
  const prefix = new URL('https://example.test/mimic/');
  for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    assert.ok(new URL(match[1]!, new URL('graph/index.html', prefix)).href.startsWith(prefix.href),
      `graph destination must remain within /mimic/: ${match[1]}`);
  }
  const standalone = renderRelationGraph(fixture(), 'body{}', false);
  assert.doesNotMatch(standalone, /src="\.\.\/web\/graph.js"|href="\.\.\/web\/graph.css"|assets\/fonts/);
  assert.ok(standalone.includes('Aの説明ではBを前提にする。'), 'standalone rendering must retain the relation text');
});

test('a graph without edges retains its concept list and explains the empty relation list', () => {
  const bundle = fixture();
  bundle.graph.edges = [];
  const html = renderRelationGraph(bundle, 'body{}');
  assert.ok(html.includes('登録された関係はありません。'));
  assert.ok(html.includes('3概念 · 0関係'));
  assert.ok(html.includes('href="../knowledge/alpha/index.html"'));
});
