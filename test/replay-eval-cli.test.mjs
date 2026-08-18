import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { compareReplayEvaluations } from '../src/replay-eval.mjs';

const execFileAsync = promisify(execFile);

test('replay comparison rejects a different case identity even when aggregate counts match', () => {
  const baseline = [{ id: 'old-error-1', success: true, latencyMs: 10, modelCalls: 1 }];
  const candidate = [{ id: 'unrelated-case', success: true, latencyMs: 10, modelCalls: 1 }];
  assert.deepEqual(compareReplayEvaluations(baseline, candidate).reasons, ['case_set_mismatch']);
});

test('default replay command records missing evidence as not verified', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-replay-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scriptPath = new URL('../scripts/evaluate-replay.mjs', import.meta.url);
  let failure;
  try {
    await execFileAsync(process.execPath, [scriptPath.pathname.slice(1)], {
      env: { ...process.env, AI_WORKSTATION_EVALUATIONS: directory },
      windowsHide: true,
      timeout: 30_000
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const result = JSON.parse(failure.stderr);
  assert.equal(result.status, 'not_verified');
  assert.equal(result.evidenceType, 'replay');
  assert.equal(result.liveVerified, false);
  const saved = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.equal(saved.status, 'not_verified');
});
