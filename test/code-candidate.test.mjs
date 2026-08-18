import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCodeCandidate,
  applyExactCandidateEdits,
  codeCandidateToolDefinitions,
  createCodeCandidate,
  rollbackCodeCandidate,
  runCandidateTests
} from '../src/code-candidate.mjs';
import { compareCandidateRuns } from '../src/self-improvement.mjs';

async function writeFixture(root, { value = 'false', expected = 'true' } = {}) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'value.mjs'), `export const value = () => ${value};\n`, 'utf8');
  await fs.writeFile(path.join(root, 'test', 'value.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { value } from '../src/value.mjs';",
    `test('value', () => assert.equal(value(), ${expected}));`,
    ''
  ].join('\n'), 'utf8');
}

test('exact patch fixes only the candidate and comparison recognizes the improvement', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-project-'));
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-candidates-'));
  context.after(() => Promise.all([
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(candidateRoot, { recursive: true, force: true })
  ]));
  await writeFixture(projectRoot);
  const baseline = await runCandidateTests(projectRoot);
  assert.equal(baseline.passed, false, baseline.output);
  const candidate = await createCodeCandidate({ projectRoot, candidateRoot, proposalId: 'fix-value' });
  await applyExactCandidateEdits({
    candidatePath: candidate.candidatePath,
    edits: [{ path: 'src/value.mjs', operation: 'replace', search: 'false', replacement: 'true', reason: 'Fix value' }]
  });
  const candidateRun = await runCandidateTests(candidate.candidatePath);
  assert.equal(candidateRun.passed, true);
  assert.equal(compareCandidateRuns(baseline, candidateRun).acceptable, true);
  assert.match(await fs.readFile(path.join(projectRoot, 'src', 'value.mjs'), 'utf8'), /false/);
});

test('apply requires confirmation, passing comparison and unchanged base; rollback restores exact files', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-apply-'));
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-candidates-'));
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-backups-'));
  context.after(() => Promise.all([
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(candidateRoot, { recursive: true, force: true }),
    fs.rm(backupRoot, { recursive: true, force: true })
  ]));
  await writeFixture(projectRoot, { value: '1', expected: '1' });
  const baseline = await runCandidateTests(projectRoot);
  const candidate = await createCodeCandidate({ projectRoot, candidateRoot, proposalId: 'change-value' });
  const edits = [
    { path: 'src/value.mjs', operation: 'replace', search: '1', replacement: '2', reason: 'Change value' },
    { path: 'test/value.test.mjs', operation: 'replace', search: '1));', replacement: '2));', reason: 'Update test' }
  ];
  const patched = await applyExactCandidateEdits({ candidatePath: candidate.candidatePath, edits });
  const candidateRun = await runCandidateTests(candidate.candidatePath);
  const evaluation = compareCandidateRuns(baseline, candidateRun);
  await assert.rejects(() => applyCodeCandidate({
    ...candidate, edits: patched.edits, baselineRun: baseline, candidateRun, evaluation, backupRoot
  }), /confirmation/i);
  const applied = await applyCodeCandidate({
    ...candidate, edits: patched.edits, baselineRun: baseline, candidateRun, evaluation, backupRoot, confirmed: true
  });
  assert.equal(applied.applied, true);
  assert.match(await fs.readFile(path.join(projectRoot, 'src', 'value.mjs'), 'utf8'), /2/);
  const rolledBack = await rollbackCodeCandidate({
    projectRoot, backupPath: applied.backupPath, confirmed: true
  });
  assert.equal(rolledBack.restored, true);
  assert.match(await fs.readFile(path.join(projectRoot, 'src', 'value.mjs'), 'utf8'), /1/);
});

test('base drift blocks candidate apply before any project write', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-drift-'));
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-candidates-'));
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-backups-'));
  context.after(() => Promise.all([
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(candidateRoot, { recursive: true, force: true }),
    fs.rm(backupRoot, { recursive: true, force: true })
  ]));
  await writeFixture(projectRoot, { value: '1', expected: '1' });
  const baselineRun = await runCandidateTests(projectRoot);
  const candidate = await createCodeCandidate({ projectRoot, candidateRoot, proposalId: 'drift' });
  const patched = await applyExactCandidateEdits({
    candidatePath: candidate.candidatePath,
    edits: [{ path: 'src/value.mjs', operation: 'replace', search: '1', replacement: '2', reason: 'Change' }]
  });
  await fs.writeFile(path.join(projectRoot, 'src', 'value.mjs'), 'export const value = () => 99;\n');
  await assert.rejects(() => applyCodeCandidate({
    ...candidate,
    edits: patched.edits,
    baselineRun,
    candidateRun: { passed: true, output: baselineRun.output },
    evaluation: { acceptable: true, reasons: [] },
    backupRoot,
    confirmed: true
  }), /base drift/i);
  assert.match(await fs.readFile(path.join(projectRoot, 'src', 'value.mjs'), 'utf8'), /99/);
});

test('candidate tool manifests encode deterministic risk and never publish Git', () => {
  const definitions = codeCandidateToolDefinitions({
    projectRoot: process.cwd(), candidateRoot: path.join(os.tmpdir(), 'candidates'), backupRoot: path.join(os.tmpdir(), 'backups')
  });
  const risks = Object.fromEntries(definitions.map((entry) => [entry.manifest.name, entry.manifest.risk]));
  assert.equal(risks['code.patch'], 'reversible_local');
  assert.equal(risks['code.test'], 'reversible_local');
  assert.equal(risks['code.apply'], 'persistent_local');
  assert.equal(Object.keys(risks).some((name) => /git|publish|push/i.test(name)), false);
});

test('persistent apply rejects a path outside the project before reading or writing it', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-safe-'));
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-backups-'));
  context.after(() => Promise.all([
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(backupRoot, { recursive: true, force: true })
  ]));
  await assert.rejects(() => applyCodeCandidate({
    projectRoot,
    proposalId: 'unsafe',
    edits: [{ path: '../escape.mjs', original: null, content: 'bad' }],
    candidateRun: { passed: true },
    evaluation: { acceptable: true },
    backupRoot,
    confirmed: true
  }), /outside project root/i);
});
