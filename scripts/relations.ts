import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RelationNode = {
  id: string;
  title: string;
  path: string;
  version: string;
  sha256: string;
};

export type RelationEvidence = { concept: string; heading: string; quotation: string };
export type RelationEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  statement: string;
  scope?: string;
  evidence: RelationEvidence[];
};

export type RelationGraph = {
  schema_version: 1;
  coverage: Record<string, string>;
  nodes: RelationNode[];
  edges: RelationEdge[];
};

export type RelationType = {
  id: string;
  label: string;
  description: string;
  directed: boolean;
  transitive: boolean;
  inverse_description: string;
  cycle_policy: string;
};

export type RelationVocabulary = {
  schema_version: 1;
  interpretation: Record<string, string>;
  types: RelationType[];
};

export type RelationBundle = { graph: RelationGraph; vocabulary: RelationVocabulary };

function record(value: unknown, location: string, allowedKeys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location}: object required`);
  }
  const fields = value as Record<string, unknown>;
  const unknownKey = allowedKeys && Object.keys(fields).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new Error(`${location}: unknown field ${unknownKey}`);
  return fields;
}

function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${location}: nonempty string required`);
  }
  return value;
}

function entries(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location}: array required`);
  return value;
}

function flag(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${location}: boolean required`);
  return value;
}

function stringRecord(value: unknown, location: string): Record<string, string> {
  const fields = record(value, location);
  if (!Object.keys(fields).length) throw new Error(`${location}: empty object`);
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, text(field, `${location}.${key}`)]));
}

function identifier(value: unknown, location: string): string {
  const result = text(value, location);
  if (!/^[a-z][a-z0-9_-]*$/.test(result)) throw new Error(`${location}: invalid identifier`);
  return result;
}

function versionOne(value: Record<string, unknown>, location: string): void {
  if (value.schema_version !== 1) throw new Error(`${location}: unsupported schema_version`);
}

function unique<T>(items: T[], key: (item: T) => string, location: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw new Error(`${location}: duplicate ${id}`);
    result.set(id, item);
  }
  return result;
}

function parseGraph(value: unknown): RelationGraph {
  const graph = record(value, 'graph', ['schema_version', 'coverage', 'nodes', 'edges']);
  versionOne(graph, 'graph');
  const nodes = entries(graph.nodes, 'graph.nodes').map((entry) => {
    const node = record(entry, 'node', ['id', 'title', 'path', 'version', 'sha256']);
    const id = identifier(node.id, 'node.id');
    const nodePath = text(node.path, `${id}.path`);
    if (nodePath !== `knowledge/${id}/KNOWLEDGE.md`) throw new Error(`${id}: noncanonical body path`);
    const sha256 = text(node.sha256, `${id}.sha256`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${id}: invalid SHA-256`);
    return {
      id, path: nodePath, sha256,
      title: text(node.title, `${id}.title`), version: text(node.version, `${id}.version`),
    };
  });
  if (!nodes.length) throw new Error('graph.nodes: at least one concept required');
  const edges = entries(graph.edges, 'graph.edges').map((entry) => {
    const edge = record(entry, 'edge', ['id', 'from', 'to', 'type', 'statement', 'scope', 'evidence']);
    const id = identifier(edge.id, 'edge.id');
    const evidence = entries(edge.evidence, `${id}.evidence`).map((entry) => {
      const source = record(entry, `${id}.evidence`, ['concept', 'heading', 'quotation']);
      return {
        concept: identifier(source.concept, `${id}.evidence.concept`),
        heading: text(source.heading, `${id}.evidence.heading`),
        quotation: text(source.quotation, `${id}.evidence.quotation`),
      };
    });
    if (!evidence.length) throw new Error(`${id}: evidence required`);
    const scope = edge.scope === undefined ? {} : { scope: text(edge.scope, `${id}.scope`) };
    return {
      id, ...scope, evidence,
      from: identifier(edge.from, `${id}.from`), to: identifier(edge.to, `${id}.to`),
      type: identifier(edge.type, `${id}.type`), statement: text(edge.statement, `${id}.statement`),
    };
  });
  return { schema_version: 1, coverage: stringRecord(graph.coverage, 'graph.coverage'), nodes, edges };
}

function parseVocabulary(value: unknown): RelationVocabulary {
  const vocabulary = record(value, 'vocabulary', ['schema_version', 'interpretation', 'types']);
  versionOne(vocabulary, 'vocabulary');
  const types = entries(vocabulary.types, 'vocabulary.types').map((entry) => {
    const relation = record(entry, 'relation type', [
      'id', 'label', 'description', 'directed', 'transitive', 'inverse_description', 'cycle_policy',
    ]);
    const id = identifier(relation.id, 'relation type.id');
    return {
      id, label: text(relation.label, `${id}.label`), description: text(relation.description, `${id}.description`),
      directed: flag(relation.directed, `${id}.directed`), transitive: flag(relation.transitive, `${id}.transitive`),
      inverse_description: text(relation.inverse_description, `${id}.inverse_description`),
      cycle_policy: text(relation.cycle_policy, `${id}.cycle_policy`),
    };
  });
  if (!types.length) throw new Error('vocabulary.types: at least one type required');
  return { schema_version: 1, interpretation: stringRecord(vocabulary.interpretation, 'vocabulary.interpretation'), types };
}

async function regularFile(root: string, relative: string): Promise<string> {
  let current = root;
  const parts = relative.split('/');
  for (const [index, component] of parts.entries()) {
    if (!component || component === '.' || component === '..') throw new Error(`${relative}: invalid path`);
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${relative}: symbolic links are not allowed`);
    const expectedKind = index === parts.length - 1 ? info.isFile() : info.isDirectory();
    if (!expectedKind) throw new Error(`${relative}: unexpected file structure`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(current));
}

function frontmatter(markdown: string, location: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match?.[1]) throw new Error(`${location}: missing frontmatter`);
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (!field?.[1] || field[2] === undefined) throw new Error(`${location}: unsupported frontmatter line`);
    const key = field[1];
    if (key === 'related') throw new Error(`${location}: related must be defined in relations/graph.json`);
    if (Object.hasOwn(result, key)) throw new Error(`${location}: duplicate frontmatter ${key}`);
    const raw = field[2];
    result[key] = raw.startsWith('"') ? text(JSON.parse(raw), `${location}.${key}`) : text(raw, `${location}.${key}`);
  }
  return result;
}

function sectionContains(markdown: string, heading: string, quotation: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let fenced = false;
  let begin = -1;
  let level = 0;
  let end = lines.length;
  let found = 0;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    if (match[2] === heading) {
      found += 1;
      if (begin === -1) { begin = index + 1; level = match[1].length; }
    } else if (begin !== -1 && end === lines.length && match[1].length <= level) {
      end = index;
    }
  }
  return found === 1 && begin !== -1 && lines.slice(begin, end).join('\n').includes(quotation);
}

async function validateBodies(root: string, nodes: RelationNode[]): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const node of nodes) {
    const markdown = await regularFile(root, node.path);
    const metadata = frontmatter(markdown, node.path);
    for (const key of ['id', 'title', 'version'] as const) {
      if (metadata[key] !== node[key]) throw new Error(`${node.id}: body ${key} mismatch`);
    }
    if (createHash('sha256').update(markdown).digest('hex') !== node.sha256) {
      throw new Error(`${node.id}: stale body SHA-256`);
    }
    bodies.set(node.id, markdown);
  }
  const directories = await readdir(path.join(root, 'knowledge'), { withFileTypes: true });
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const bodyPath = path.join(root, 'knowledge', entry.name, 'KNOWLEDGE.md');
    const body = await lstat(bodyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (body && !bodies.has(entry.name)) throw new Error(`${entry.name}: concept missing from graph.nodes`);
  }
  return bodies;
}

function validateStructure(graph: RelationGraph, vocabulary: RelationVocabulary): void {
  const nodes = unique(graph.nodes, (node) => node.id, 'graph.nodes');
  unique(graph.edges, (edge) => edge.id, 'graph.edges');
  const types = unique(vocabulary.types, (relation) => relation.id, 'vocabulary.types');
  const relationships = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error(`${edge.id}: unknown endpoint`);
    if (edge.from === edge.to) throw new Error(`${edge.id}: self-reference is not allowed`);
    const relation = types.get(edge.type);
    if (!relation) throw new Error(`${edge.id}: unknown relation type`);
    if (edge.type === 'depends_on_computation' && !edge.scope) throw new Error(`${edge.id}: calculation scope required`);
    const endpoints = relation.directed ? [edge.from, edge.to] : [edge.from, edge.to].sort();
    const key = JSON.stringify([edge.type, endpoints]);
    if (relationships.has(key)) throw new Error(`${edge.id}: duplicate relationship`);
    relationships.add(key);
    for (const source of edge.evidence) {
      if (!nodes.has(source.concept) || ![edge.from, edge.to].includes(source.concept)) {
        throw new Error(`${edge.id}: invalid evidence concept`);
      }
    }
  }
}

async function readBundle(root: string): Promise<RelationBundle> {
  const graph = parseGraph(JSON.parse(await regularFile(root, 'relations/graph.json')));
  const vocabulary = parseVocabulary(JSON.parse(await regularFile(root, 'relations/vocabulary.json')));
  validateStructure(graph, vocabulary);
  return { graph, vocabulary };
}

async function validateEvidence(root: string, bundle: RelationBundle): Promise<void> {
  const bodies = await validateBodies(root, bundle.graph.nodes);
  for (const edge of bundle.graph.edges) {
    for (const source of edge.evidence) {
      const markdown = bodies.get(source.concept);
      if (!markdown || !sectionContains(markdown, source.heading, source.quotation)) {
        throw new Error(`${edge.id}: evidence heading or quotation mismatch`);
      }
    }
  }
}

export async function loadRelationBundle(root: string): Promise<RelationBundle> {
  const bundle = await readBundle(root);
  await validateEvidence(root, bundle);
  return bundle;
}

async function syncRelationMetadata(root: string): Promise<void> {
  const bundle = await readBundle(root);
  for (const node of bundle.graph.nodes) {
    const markdown = await regularFile(root, node.path);
    const metadata = frontmatter(markdown, node.path);
    if (metadata.id !== node.id) throw new Error(`${node.id}: body id mismatch`);
    node.title = text(metadata.title, `${node.id}.title`);
    node.version = text(metadata.version, `${node.id}.version`);
    node.sha256 = createHash('sha256').update(markdown).digest('hex');
  }
  await validateEvidence(root, bundle);
  await writeFile(path.join(root, 'relations/graph.json'), `${JSON.stringify(bundle.graph, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    const argumentsList = process.argv.slice(2);
    if (argumentsList.length === 1 && argumentsList[0] === '--sync') {
      await syncRelationMetadata(process.cwd());
      console.log('Relation metadata synchronized; evidence validated.');
    } else if (argumentsList.length === 0) {
      const bundle = await loadRelationBundle(process.cwd());
      console.log(`Relations valid: ${bundle.graph.nodes.length} concepts, ${bundle.graph.edges.length} edges.`);
    } else {
      throw new Error('Usage: bun scripts/relations.ts [--sync]');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
