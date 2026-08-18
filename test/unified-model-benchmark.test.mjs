import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  benchmarkReportAllowsMutations,
  scoreUnifiedModelCases,
  validateUnifiedModelManifest
} from '../src/unified-model-benchmark.mjs';

const execFileAsync = promisify(execFile);

function passingCases() {
  return [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `structured-${index}`,
      category: 'structured_output',
      firstPass: index < 98,
      afterRepair: true
    })),
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `ui-${index}`,
      category: 'ui',
      toolChoiceCorrect: index < 27,
      groundingCorrect: index < 24
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `code-${index}`,
      category: 'code',
      defectOwnerCorrect: index < 7,
      candidatePassed: index < 6
    })),
    { id: 'isolation-1', category: 'session_isolation', passed: true }
  ];
}

test('benchmark gate applies every exact design threshold', () => {
  const summary = scoreUnifiedModelCases(passingCases());
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.caseCounts.structured, 100);
  assert.equal(summary.caseCounts.ui, 30);
  assert.equal(summary.caseCounts.code, 10);
});

test('benchmark gate fails when any session contaminates the next goal', () => {
  const cases = passingCases();
  cases.at(-1).passed = false;
  const summary = scoreUnifiedModelCases(cases);
  assert.equal(summary.passed, false);
  assert.ok(summary.failures.includes('session_contamination'));
});

test('one failed repair, grounding, owner or candidate threshold blocks rollout', () => {
  const cases = passingCases();
  cases.find((item) => item.category === 'structured_output').afterRepair = false;
  cases.filter((item) => item.category === 'ui')[23].groundingCorrect = false;
  cases.filter((item) => item.category === 'code')[6].defectOwnerCorrect = false;
  cases.filter((item) => item.category === 'code')[5].candidatePassed = false;
  const summary = scoreUnifiedModelCases(cases);
  assert.ok(summary.failures.includes('structured_after_repair_below_100'));
  assert.ok(summary.failures.includes('ui_grounding_below_24'));
  assert.ok(summary.failures.includes('code_owner_below_7'));
  assert.ok(summary.failures.includes('code_candidate_below_6'));
});

test('manifest validation requires the fixed case inventory without reading evidence', () => {
  const manifest = validateUnifiedModelManifest(passingCases());
  assert.equal(manifest.valid, true);
  assert.equal(manifest.totalCases, 141);
  assert.deepEqual(manifest.errors, []);
  assert.equal(manifest.referencedEvidence.length, 0);
});

test('state-changing tools require a passing current-model current-protocol report', () => {
  const cases = passingCases();
  const report = {
    ...scoreUnifiedModelCases(cases),
    model: 'qwen/qwen3-vl-8b',
    protocolVersion: 1,
    promptVersion: 1,
    codeCommit: 'abc123',
    cases
  };
  assert.equal(benchmarkReportAllowsMutations({
    report, activeModel: 'qwen/qwen3-vl-8b', protocolVersion: 1
  }).allowed, true);
  assert.equal(benchmarkReportAllowsMutations({
    report, activeModel: 'other/model', protocolVersion: 1
  }).reason, 'model_mismatch');
  assert.equal(benchmarkReportAllowsMutations({
    report, activeModel: 'qwen/qwen3-vl-8b', protocolVersion: 2
  }).reason, 'protocol_mismatch');
});

test('state-changing tools reject a forged or incomplete passing report', () => {
  const forged = {
    passed: true,
    model: 'qwen/qwen3-vl-8b',
    protocolVersion: 1
  };
  assert.equal(benchmarkReportAllowsMutations({
    report: forged,
    activeModel: 'qwen/qwen3-vl-8b',
    protocolVersion: 1
  }).reason, 'report_incomplete');

  const cases = passingCases();
  cases.find((item) => item.category === 'session_isolation').passed = false;
  const dishonest = { ...forged, cases };
  assert.equal(benchmarkReportAllowsMutations({
    report: dishonest,
    activeModel: 'qwen/qwen3-vl-8b',
    protocolVersion: 1
  }).reason, 'benchmark_failed');
});

test('dry-run validates the exact inventory without calling LM Studio', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-benchmark-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'cases.jsonl');
  await fs.writeFile(manifestPath, `${passingCases().map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  const scriptPath = new URL('../scripts/benchmark-unified-model.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath.pathname.slice(1), '--manifest', manifestPath, '--dry-run'], {
    windowsHide: true,
    timeout: 30_000
  });
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.caseCounts, { structured: 100, ui: 30, code: 10, sessionIsolation: 1 });
});

test('missing benchmark evidence is reported as not verified without a stack trace', async () => {
  const scriptPath = new URL('../scripts/benchmark-unified-model.mjs', import.meta.url);
  const missingPath = path.join(os.tmpdir(), `missing-jarvis-benchmark-${Date.now()}.jsonl`);
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath.pathname.slice(1), '--manifest', missingPath, '--dry-run'], {
      windowsHide: true,
      timeout: 30_000
    }),
    (error) => {
      const result = JSON.parse(error.stderr);
      assert.equal(result.status, 'not_verified');
      assert.equal(result.reason, 'manifest_unavailable');
      assert.equal(result.modelCalls, 0);
      assert.equal(result.manifestPath, missingPath);
      assert.doesNotMatch(error.stderr, /node:internal|at async/);
      return true;
    }
  );
});
