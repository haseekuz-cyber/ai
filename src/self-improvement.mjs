import fs from 'node:fs/promises';
import path from 'node:path';

function count(pattern, output) {
  const match = String(output || '').match(pattern);
  return match ? Number(match[1]) : null;
}

export function parseNodeTestSummary(testRun = {}) {
  const output = String(testRun.output || '');
  return {
    passed: testRun.passed === true,
    tests: count(/(?:#|ℹ)?\s*tests\s+(\d+)/i, output),
    pass: count(/(?:#|ℹ)?\s*pass\s+(\d+)/i, output),
    fail: count(/(?:#|ℹ)?\s*fail\s+(\d+)/i, output),
    cancelled: count(/(?:#|ℹ)?\s*cancelled\s+(\d+)/i, output),
    skipped: count(/(?:#|ℹ)?\s*skipped\s+(\d+)/i, output),
    durationMs: count(/(?:#|ℹ)?\s*duration_ms\s+([\d.]+)/i, output)
  };
}

export function compareCandidateRuns(baselineRun, candidateRun) {
  const baseline = parseNodeTestSummary(baselineRun);
  const candidate = parseNodeTestSummary(candidateRun);
  const reasons = [];
  if (!candidate.passed) reasons.push('candidate_failed');
  if ((candidate.fail ?? 0) > 0) reasons.push('candidate_has_failures');
  if ((candidate.cancelled ?? 0) > 0) reasons.push('candidate_has_cancelled_tests');
  if (baseline.tests != null && candidate.tests != null && candidate.tests < baseline.tests) reasons.push('candidate_runs_fewer_tests');
  if (baseline.pass != null && candidate.pass != null && candidate.pass < baseline.pass) reasons.push('candidate_has_fewer_passing_tests');
  return {
    acceptable: reasons.length === 0,
    reasons,
    baseline,
    candidate,
    deltas: {
      tests: baseline.tests == null || candidate.tests == null ? null : candidate.tests - baseline.tests,
      pass: baseline.pass == null || candidate.pass == null ? null : candidate.pass - baseline.pass,
      fail: baseline.fail == null || candidate.fail == null ? null : candidate.fail - baseline.fail,
      durationMs: baseline.durationMs == null || candidate.durationMs == null ? null : candidate.durationMs - baseline.durationMs
    }
  };
}

export async function persistImprovementRecord(directory, record) {
  if (!record?.proposalId) throw new TypeError('proposalId is required.');
  const proposalDirectory = path.resolve(directory, record.proposalId);
  await fs.mkdir(proposalDirectory, { recursive: true });
  const outputPath = path.join(proposalDirectory, 'manifest.json');
  await fs.writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return outputPath;
}

export async function restoreTeacherBackup({ projectRoot, backupPath, confirmed = false }) {
  if (confirmed !== true) throw new Error('Explicit rollback confirmation is required.');
  const root = path.resolve(projectRoot);
  const backup = path.resolve(backupPath);
  const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  for (const file of manifest.files || []) {
    const relativePath = String(file.path || '').replace(/\\/g, '/');
    const target = path.resolve(root, ...relativePath.split('/'));
    const check = path.relative(root, target);
    if (!relativePath || check.startsWith('..') || path.isAbsolute(check)) throw new Error('Backup manifest contains an unsafe path.');
    if (file.created) {
      await fs.rm(target, { force: true });
    } else {
      const source = path.resolve(backup, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
  return { restored: true, proposalId: manifest.proposalId, files: manifest.files || [] };
}
