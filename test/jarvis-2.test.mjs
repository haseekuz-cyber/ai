import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildErrorPacket, listErrorPackets, persistErrorPacket } from '../src/error-packet.mjs';
import { normalizeExperienceTransition, promoteExperience } from '../src/experience-schema.mjs';
import { routeIntervention } from '../src/intervention-router.mjs';
import { ModelBroker } from '../src/model-broker.mjs';
import { compareReplayEvaluations } from '../src/replay-eval.mjs';
import { compareCandidateRuns, restoreTeacherBackup } from '../src/self-improvement.mjs';

test('ErrorPacket classifies failures and redacts typed text and secrets', () => {
  const error = Object.assign(new Error('point must be an object'), { code: 'invalid_local_plan' });
  const packet = buildErrorPacket(error, {
    phase: 'planning',
    action: { type: 'typeText', text: 'private client message' },
    evidence: { authorization: 'Bearer private' }
  });
  assert.equal(packet.category, 'model_protocol');
  assert.equal(packet.action.text.redacted, true);
  assert.equal(packet.action.text.length, 22);
  assert.equal(packet.evidence.authorization, '[redacted]');
  assert.equal(packet.fingerprint.length, 24);
});

test('ErrorPacket persists as durable model-independent evidence', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-errors-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packet = buildErrorPacket(Object.assign(new Error('capture command failed'), { code: 'capture_failed' }));
  const outputPath = await persistErrorPacket(directory, packet);
  assert.equal(path.extname(outputPath), '.json');
  const stored = await listErrorPackets(directory);
  assert.equal(stored[0].errorId, packet.errorId);
});

test('intervention router separates code, RAG, preferences, skills and training', () => {
  const infrastructure = buildErrorPacket(Object.assign(new Error('PowerShell command failed'), { code: 'capture_failed' }));
  assert.equal(routeIntervention(infrastructure).intervention, 'code');
  assert.equal(routeIntervention(infrastructure, { missingProgramKnowledge: true }).intervention, 'rag_research');
  assert.equal(routeIntervention(infrastructure, { explicitPreference: true }).intervention, 'memory');
  const grounding = buildErrorPacket(Object.assign(new Error('Visual target confidence is low'), { code: 'grounding_failed' }));
  assert.equal(routeIntervention(grounding, { occurrences: 3 }).intervention, 'skill');
  assert.equal(routeIntervention(grounding, { userCorrection: true, verifiedExamples: 1 }).intervention, 'training_example');
});

test('ModelBroker serializes heavy model work and publishes role status', async () => {
  const events = [];
  const broker = new ModelBroker({ roles: { vision: 'vision-model', coder: 'coder-model' } });
  const first = broker.runModel('vision-model', async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('first:end');
  }, { role: 'vision' });
  const second = broker.runModel('coder-model', async () => events.push('second'), { role: 'coder' });
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  assert.equal(broker.status().completed, 2);
  assert.equal(broker.status().switches, 2);
  assert.equal(broker.modelForRole('coder'), 'coder-model');
});

test('candidate comparison blocks fewer tests and accepts no-regression candidates', () => {
  const baseline = { passed: true, output: '# tests 200\n# pass 200\n# fail 0\n# cancelled 0\n# duration_ms 1000' };
  const good = { passed: true, output: '# tests 202\n# pass 202\n# fail 0\n# cancelled 0\n# duration_ms 1100' };
  const weak = { passed: true, output: '# tests 190\n# pass 190\n# fail 0\n# cancelled 0\n# duration_ms 900' };
  assert.equal(compareCandidateRuns(baseline, good).acceptable, true);
  assert.deepEqual(compareCandidateRuns(baseline, weak).reasons, ['candidate_runs_fewer_tests', 'candidate_has_fewer_passing_tests']);
});

test('replay evaluation blocks more wrong actions and accepts faster equal-quality behavior', () => {
  const baseline = [
    { success: true, modelCalls: 3, latencyMs: 1_000 },
    { success: false, wrongAction: true, modelCalls: 4, latencyMs: 1_200 }
  ];
  const faster = [
    { success: true, modelCalls: 2, latencyMs: 700 },
    { success: false, wrongAction: true, modelCalls: 2, latencyMs: 800 }
  ];
  const unsafe = [
    { success: true, modelCalls: 2, latencyMs: 700 },
    { success: false, wrongAction: true, falsePositive: true, modelCalls: 2, latencyMs: 800 }
  ];
  assert.equal(compareReplayEvaluations(baseline, faster).acceptable, true);
  assert.deepEqual(compareReplayEvaluations(baseline, unsafe).reasons, ['validation_false_positives_increased']);
});

test('confirmed backup rollback restores changed files and removes created files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-root-'));
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-backup-'));
  context.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(backup, { recursive: true, force: true })]));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(backup, 'src'));
  await fs.writeFile(path.join(root, 'src', 'changed.mjs'), 'new');
  await fs.writeFile(path.join(root, 'src', 'created.mjs'), 'created');
  await fs.writeFile(path.join(backup, 'src', 'changed.mjs'), 'old');
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({
    proposalId: 'p1', files: [{ path: 'src/changed.mjs', created: false }, { path: 'src/created.mjs', created: true }]
  }));
  await assert.rejects(restoreTeacherBackup({ projectRoot: root, backupPath: backup }), /confirmation/);
  await restoreTeacherBackup({ projectRoot: root, backupPath: backup, confirmed: true });
  assert.equal(await fs.readFile(path.join(root, 'src', 'changed.mjs'), 'utf8'), 'old');
  await assert.rejects(fs.access(path.join(root, 'src', 'created.mjs')));
});

test('experience requires validation and human approval before training export', () => {
  const raw = normalizeExperienceTransition({
    episodeId: 'episode-1', goal: 'Create a shape', action: { type: 'drag' },
    modifiers: ['Control', 'Control'], trajectoryImportance: 'exact',
    trajectory: [{ x: 0.1, y: 0.2, timeMs: 0 }, { x: 0.4, y: 0.5, timeMs: 400 }]
  });
  const interpreted = promoteExperience(raw, 'interpreted', { model: 'teacher' });
  assert.throws(() => promoteExperience(interpreted, 'verified'), /validation/);
  const verified = promoteExperience(interpreted, 'verified', { validationSuccess: true });
  assert.throws(() => promoteExperience(verified, 'training_approved'), /Human approval/);
  assert.equal(promoteExperience(verified, 'training_approved', { humanApproved: true }).state, 'training_approved');
  assert.deepEqual(raw.modifiers, ['Control']);
  assert.equal(raw.trajectory.importance, 'exact');
});
