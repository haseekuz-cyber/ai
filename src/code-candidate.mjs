import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { applyPreparedTeacherEdits, prepareTeacherEdits } from './teacher-chat.mjs';
import { compareCandidateRuns, restoreTeacherBackup } from './self-improvement.mjs';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value ?? '').digest('hex');
}

function safeProposalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new TypeError('proposalId must contain only letters, digits, underscore or hyphen.');
  }
  return value;
}

function copyFilter(projectRoot, source) {
  const relative = path.relative(projectRoot, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  return !parts.some((part) => ['.git', 'runtime', 'node_modules', 'artifacts', '__pycache__'].includes(part)) &&
    !/\.(?:exe|dll|pyc|gguf|safetensors|onnx)$/i.test(source);
}

function resolveProjectTarget(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new TypeError('Candidate edit path is outside project root.');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  const target = path.resolve(projectRoot, ...normalized.split('/'));
  const check = path.relative(projectRoot, target);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new TypeError(`Candidate edit path is outside project root: ${relativePath}`);
  }
  return { target, relativePath: normalized };
}

export async function createCodeCandidate({ projectRoot, candidateRoot, proposalId } = {}) {
  const root = path.resolve(projectRoot || '');
  const candidates = path.resolve(candidateRoot || '');
  const id = safeProposalId(proposalId);
  const candidatePath = path.join(candidates, id);
  await fs.mkdir(candidates, { recursive: true });
  try {
    await fs.access(candidatePath);
    throw new Error(`Code candidate ${id} already exists.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.cp(root, candidatePath, { recursive: true, filter: (source) => copyFilter(root, source) });
  return { proposalId: id, projectRoot: root, candidatePath, createdAt: new Date().toISOString() };
}

export async function applyExactCandidateEdits({ candidatePath, edits } = {}) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 20) {
    throw new TypeError('One to 20 exact candidate edits are required.');
  }
  const root = path.resolve(candidatePath || '');
  const prepared = await prepareTeacherEdits(root, edits);
  await applyPreparedTeacherEdits(prepared, root);
  return {
    candidatePath: root,
    edits: prepared.map((edit) => ({
      path: edit.relativePath,
      operation: edit.operation,
      reason: edit.reason || '',
      original: edit.original,
      content: edit.content,
      originalSha256: edit.original == null ? null : sha256(edit.original),
      candidateSha256: sha256(edit.content)
    }))
  };
}

export async function runCandidateTests(candidateRoot, {
  nodeExecutable = process.execPath,
  timeoutMs = 120_000,
  maxOutputBytes = 2 * 1024 * 1024
} = {}) {
  const cwd = path.resolve(candidateRoot || '');
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  try {
    const result = await execFileAsync(nodeExecutable, ['--test'], {
      cwd,
      env: childEnvironment,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true
    });
    return { passed: true, command: 'node --test', output: `${result.stdout || ''}${result.stderr || ''}`.slice(-maxOutputBytes) };
  } catch (error) {
    return {
      passed: false,
      command: 'node --test',
      output: `${error.stdout || ''}${error.stderr || ''}${error.message || ''}`.slice(-maxOutputBytes),
      code: error.code ?? null
    };
  }
}

async function assertNoBaseDrift(projectRoot, edits) {
  const drifted = [];
  for (const edit of edits) {
    const { target } = resolveProjectTarget(projectRoot, edit.path);
    let current = null;
    try { current = await fs.readFile(target, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== edit.original) drifted.push(edit.path);
  }
  if (drifted.length) {
    const error = new Error(`Code candidate base drift detected: ${drifted.join(', ')}`);
    error.code = 'candidate_base_drift';
    error.files = drifted;
    throw error;
  }
}

export async function applyCodeCandidate({
  projectRoot,
  proposalId,
  edits,
  baselineRun,
  candidateRun,
  evaluation = compareCandidateRuns(baselineRun, candidateRun),
  backupRoot,
  confirmed = false,
  testRunner = runCandidateTests
} = {}) {
  if (confirmed !== true) throw new Error('Explicit confirmation is required to apply a code candidate.');
  if (!candidateRun?.passed || evaluation?.acceptable !== true) {
    throw new Error('Code candidate must pass tests and comparison before apply.');
  }
  const root = path.resolve(projectRoot || '');
  const id = safeProposalId(proposalId);
  if (!Array.isArray(edits) || edits.length === 0) throw new TypeError('Candidate edits are required.');
  for (const edit of edits) {
    resolveProjectTarget(root, edit.path);
    if (edit.original != null && typeof edit.original !== 'string') throw new TypeError('Candidate original content must be text or null.');
    if (typeof edit.content !== 'string') throw new TypeError('Candidate replacement content must be text.');
  }
  await assertNoBaseDrift(root, edits);

  const backupPath = path.resolve(backupRoot || '', id);
  await fs.mkdir(backupPath, { recursive: true });
  const manifestFiles = [];
  for (const edit of edits) {
    const { target, relativePath } = resolveProjectTarget(root, edit.path);
    if (edit.original != null) {
      const backupFile = path.resolve(backupPath, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(backupFile), { recursive: true });
      await fs.writeFile(backupFile, edit.original, 'utf8');
    }
    manifestFiles.push({ path: relativePath, created: edit.original == null });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, edit.content, 'utf8');
  }
  await fs.writeFile(path.join(backupPath, 'manifest.json'), `${JSON.stringify({ proposalId: id, files: manifestFiles }, null, 2)}\n`, 'utf8');

  const tests = await testRunner(root);
  if (!tests.passed) {
    await restoreTeacherBackup({ projectRoot: root, backupPath, confirmed: true });
    return { applied: false, rolledBack: true, tests, backupPath };
  }
  return { applied: true, rolledBack: false, tests, backupPath };
}

export async function rollbackCodeCandidate({ projectRoot, backupPath, confirmed = false, testRunner = runCandidateTests } = {}) {
  const restored = await restoreTeacherBackup({ projectRoot, backupPath, confirmed });
  const tests = await testRunner(projectRoot);
  return { ...restored, tests };
}

export function codeCandidateToolDefinitions({ projectRoot, candidateRoot, backupRoot } = {}) {
  const candidates = new Map();
  const requireCandidate = (proposalId) => {
    const candidate = candidates.get(proposalId);
    if (!candidate) throw new Error(`Unknown code candidate: ${proposalId}.`);
    return candidate;
  };
  const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const editSchema = objectSchema({
    path: { type: 'string' },
    operation: { type: 'string', enum: ['replace', 'create'] },
    search: { type: 'string' },
    replacement: { type: 'string' },
    reason: { type: 'string' }
  }, ['path', 'operation', 'replacement', 'reason']);
  const definitions = [
    {
      manifest: { name: 'code.createCandidate', risk: 'reversible_local', idempotency: 'adapter_required', inputSchema: objectSchema({ proposalId: { type: 'string' } }, ['proposalId']) },
      handler: async ({ proposalId }) => {
        const candidate = await createCodeCandidate({ projectRoot, candidateRoot, proposalId });
        candidates.set(proposalId, candidate);
        return candidate;
      }
    },
    {
      manifest: { name: 'code.patch', risk: 'reversible_local', idempotency: 'at_most_once', inputSchema: objectSchema({ proposalId: { type: 'string' }, edits: { type: 'array', items: editSchema } }, ['proposalId', 'edits']) },
      handler: async ({ proposalId, edits }) => {
        const candidate = requireCandidate(proposalId);
        const patched = await applyExactCandidateEdits({ candidatePath: candidate.candidatePath, edits });
        Object.assign(candidate, patched);
        return { proposalId, edits: patched.edits.map(({ path, operation, reason, originalSha256, candidateSha256 }) => ({ path, operation, reason, originalSha256, candidateSha256 })) };
      }
    },
    {
      manifest: { name: 'code.test', risk: 'reversible_local', idempotency: 'retryable', inputSchema: objectSchema({ proposalId: { type: 'string' } }, ['proposalId']) },
      handler: async ({ proposalId }) => {
        const candidate = requireCandidate(proposalId);
        candidate.baselineRun = await runCandidateTests(projectRoot);
        candidate.candidateRun = await runCandidateTests(candidate.candidatePath);
        candidate.evaluation = compareCandidateRuns(candidate.baselineRun, candidate.candidateRun);
        return { proposalId, baselineRun: candidate.baselineRun, candidateRun: candidate.candidateRun, evaluation: candidate.evaluation };
      }
    },
    {
      manifest: { name: 'code.compare', risk: 'read_only', readOnly: true, idempotency: 'retryable', inputSchema: objectSchema({ proposalId: { type: 'string' } }, ['proposalId']) },
      handler: async ({ proposalId }) => {
        const candidate = requireCandidate(proposalId);
        if (!candidate.evaluation) throw new Error('Candidate must be tested before comparison.');
        return { proposalId, evaluation: candidate.evaluation };
      }
    },
    {
      manifest: { name: 'code.apply', risk: 'persistent_local', idempotency: 'at_most_once', inputSchema: objectSchema({ proposalId: { type: 'string' }, confirmed: { type: 'boolean' } }, ['proposalId', 'confirmed']) },
      handler: async ({ proposalId, confirmed }) => {
        const candidate = requireCandidate(proposalId);
        const result = await applyCodeCandidate({ ...candidate, projectRoot, backupRoot, confirmed });
        candidate.applyResult = result;
        return { proposalId, ...result };
      }
    },
    {
      manifest: { name: 'code.rollback', risk: 'persistent_local', idempotency: 'at_most_once', inputSchema: objectSchema({ proposalId: { type: 'string' }, confirmed: { type: 'boolean' } }, ['proposalId', 'confirmed']) },
      handler: async ({ proposalId, confirmed }) => {
        const candidate = requireCandidate(proposalId);
        if (!candidate.applyResult?.backupPath) throw new Error('Candidate has no applied backup.');
        return rollbackCodeCandidate({ projectRoot, backupPath: candidate.applyResult.backupPath, confirmed });
      }
    }
  ];
  return definitions;
}

export function registerCodeCandidateTools(registry, options = {}) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('ToolRegistry is required.');
  for (const definition of codeCandidateToolDefinitions(options)) {
    registry.register(definition.manifest, definition.handler);
  }
  return registry;
}
