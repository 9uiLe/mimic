import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

interface BehaviorCase {
  id: string;
  requirement: string;
  oracle: { status: string; source: string; section: string; quotation: string };
  input: Record<string, unknown>;
  expected: unknown;
  assumptions: string[];
  implementation: string;
  test: string;
  supportingFiles: string[];
  testName: string;
  mutation: { description: string; find: string; replace: string; assertionMessage: string };
}

interface TestRun {
  phase: string;
  exitCode: number;
  testSha256: string;
  transcript: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value, `${label} must not be empty`);
}

function confinedPath(directory: string, relativePath: string): string {
  requiredText(relativePath, 'registered path');
  const absolutePath = path.resolve(directory, relativePath);
  assert.ok(
    !path.isAbsolute(relativePath) && absolutePath.startsWith(`${directory}${path.sep}`),
    `registered path escapes the isolated copy: ${relativePath}`,
  );
  return absolutePath;
}

function parseCases(registryValue: unknown): BehaviorCase[] {
  assert.ok(recordValue(registryValue) && registryValue.schemaVersion === 1, 'unsupported behavior-case schema');
  assert.ok(Array.isArray(registryValue.cases) && registryValue.cases.length, 'behavior cases must not be empty');
  const registeredIds = new Set<string>();
  for (const candidateCase of registryValue.cases) {
    assert.ok(recordValue(candidateCase), 'each behavior case must be an object');
    for (const field of ['id', 'requirement', 'implementation', 'test', 'testName']) {
      requiredText(candidateCase[field], `behavior case ${field}`);
    }
    assert.ok(recordValue(candidateCase.oracle), 'behavior case requires its independent oracle');
    for (const field of ['status', 'source', 'section', 'quotation']) requiredText(candidateCase.oracle[field], `oracle ${field}`);
    assert.ok(['confirmed', 'assumption', 'current-record'].includes(String(candidateCase.oracle.status)), 'unknown oracle status');
    assert.ok(recordValue(candidateCase.input) && 'expected' in candidateCase, 'behavior case requires input and expected result');
    assert.ok(Array.isArray(candidateCase.assumptions), 'behavior case requires explicit assumptions');
    assert.ok(candidateCase.assumptions.every((assumption: unknown) => typeof assumption === 'string'), 'invalid assumption');
    assert.ok(Array.isArray(candidateCase.supportingFiles), 'behavior case requires supportingFiles');
    for (const supportPath of candidateCase.supportingFiles) requiredText(supportPath, 'supporting file');
    assert.ok(recordValue(candidateCase.mutation), 'behavior case requires a mutation');
    for (const field of ['description', 'find', 'replace', 'assertionMessage']) {
      requiredText(candidateCase.mutation[field], `mutation ${field}`);
    }
    assert.notEqual(candidateCase.mutation.find, candidateCase.mutation.replace, 'mutation must alter the implementation');
    const caseId = String(candidateCase.id);
    assert.ok(!registeredIds.has(caseId), `duplicate behavior case ${caseId}`);
    registeredIds.add(caseId);
  }
  return registryValue.cases as unknown as BehaviorCase[];
}

async function executeTest(
  directory: string,
  behaviorCase: BehaviorCase,
  phase: string,
  fixedTest: Buffer,
): Promise<TestRun> {
  const snapshotTest = await readFile(confinedPath(directory, behaviorCase.test));
  assert.ok(snapshotTest.equals(fixedTest), `${phase}: test changed during the proof`);
  const execution = spawnSync(process.execPath, ['test', `./${behaviorCase.test}`], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (execution.error) throw execution.error;
  assert.equal(execution.signal, null, `${phase}: test was interrupted`);
  assert.notEqual(execution.status, null, `${phase}: test did not complete`);
  const transcript = `${execution.stdout}${execution.stderr}`;
  const failedMutation = phase === 'intentional-error';
  if (failedMutation) {
    assert.equal(execution.status, 1, `mutant must fail by an assertion, not tooling: ${transcript}`);
    assert.ok(transcript.includes(`(fail) ${behaviorCase.testName}`), `registered test did not fail: ${transcript}`);
    assert.ok(transcript.includes('AssertionError'), `failure was not an assertion: ${transcript}`);
    assert.ok(transcript.includes(behaviorCase.mutation.assertionMessage), `wrong assertion failed: ${transcript}`);
    assert.ok(!/SyntaxError|Cannot find module|ModuleNotFound|timed? ?out/i.test(transcript), `tooling failure: ${transcript}`);
  } else {
    assert.equal(execution.status, 0, `${phase}: normal implementation must pass: ${transcript}`);
    assert.ok(transcript.includes(`(pass) ${behaviorCase.testName}`), `registered test did not execute: ${transcript}`);
  }
  assert.ok((await readFile(confinedPath(directory, behaviorCase.test))).equals(fixedTest), 'test changed after execution');
  return { phase, exitCode: execution.status!, testSha256: sha256(fixedTest), transcript };
}

async function verifyCase(behaviorCase: BehaviorCase) {
  const oracleText = await readFile(confinedPath(repositoryRoot, behaviorCase.oracle.source), 'utf8');
  assert.ok(oracleText.includes(`## ${behaviorCase.oracle.section}`), 'registered oracle section is missing');
  assert.ok(oracleText.includes(behaviorCase.oracle.quotation), 'registered oracle statement is missing');
  const implementationPath = confinedPath(repositoryRoot, behaviorCase.implementation);
  const testPath = confinedPath(repositoryRoot, behaviorCase.test);
  const originalImplementation = await readFile(implementationPath);
  const originalTest = await readFile(testPath);
  const implementationText = originalImplementation.toString('utf8');
  assert.equal(implementationText.split(behaviorCase.mutation.find).length, 2, 'mutation must match the source exactly once');
  const mutatedImplementation = implementationText.replace(behaviorCase.mutation.find, behaviorCase.mutation.replace);
  const isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), 'mimic-behavior-proof-'));
  try {
    const snapshotPaths = new Set([behaviorCase.implementation, behaviorCase.test, ...behaviorCase.supportingFiles]);
    for (const relativePath of snapshotPaths) {
      const snapshotPath = confinedPath(isolatedDirectory, relativePath);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, await readFile(confinedPath(repositoryRoot, relativePath)));
    }
    const snapshotImplementation = confinedPath(isolatedDirectory, behaviorCase.implementation);
    const normal = await executeTest(isolatedDirectory, behaviorCase, 'normal', originalTest);
    await writeFile(snapshotImplementation, mutatedImplementation);
    const incorrect = await executeTest(isolatedDirectory, behaviorCase, 'intentional-error', originalTest);
    await writeFile(snapshotImplementation, originalImplementation);
    const restored = await executeTest(isolatedDirectory, behaviorCase, 'restored', originalTest);
    return {
      id: behaviorCase.id,
      requirement: behaviorCase.requirement,
      oracle: behaviorCase.oracle,
      input: behaviorCase.input,
      expected: behaviorCase.expected,
      assumptions: behaviorCase.assumptions,
      implementationSha256: sha256(originalImplementation),
      testSha256: sha256(originalTest),
      mutation: behaviorCase.mutation,
      detectedAssertion: behaviorCase.mutation.assertionMessage,
      stages: [normal, incorrect, restored],
    };
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
    assert.ok((await readFile(implementationPath)).equals(originalImplementation), 'repository implementation changed during proof');
    assert.ok((await readFile(testPath)).equals(originalTest), 'repository test changed during proof');
  }
}

async function main() {
  const { values } = parseArgs({ options: { case: { type: 'string' }, report: { type: 'string' } }, strict: true });
  const registryPath = path.join(repositoryRoot, '.quality/behavior-cases.json');
  const registryBytes = await readFile(registryPath);
  const allCases = parseCases(JSON.parse(registryBytes.toString('utf8')));
  const selectedCases = values.case ? allCases.filter(behaviorCase => behaviorCase.id === values.case) : allCases;
  assert.ok(selectedCases.length, `unknown or empty behavior case selection: ${values.case || 'all'}`);
  const caseResults = [];
  for (const behaviorCase of selectedCases) caseResults.push(await verifyCase(behaviorCase));
  const reportPath = path.resolve(repositoryRoot, values.report || 'output/quality/behavior-proof.json');
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    registrySha256: sha256(registryBytes),
    cases: caseResults,
  }, null, 2)}\n`);
  for (const result of caseResults) {
    console.log(`${result.id}: normal PASS -> assertion FAIL -> restored PASS; fixed test ${result.testSha256}`);
    console.log(`Detected assertion: ${result.detectedAssertion}`);
  }
  console.log(`Evidence: ${path.relative(repositoryRoot, reportPath)}`);
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
