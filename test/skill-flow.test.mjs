import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSavedSkillStepRequest, prepareSavedSkillRequest } from '../public/skill-flow.js';

test('saved demonstration is prepared through the skill executor, not a mission plan', () => {
  const request = prepareSavedSkillRequest({ skillId: 'skill-1', windowHandle: 42 });
  assert.equal(request.path, '/api/skills/prepare');
  assert.deepEqual(JSON.parse(request.options.body), { windowHandle: 42, skillId: 'skill-1' });
  assert.equal(request.path.includes('missions'), false);
});

test('confirmed learned step uses the dedicated skill execution route', () => {
  const request = executeSavedSkillStepRequest({ runId: 'run-1' });
  assert.equal(request.path, '/api/skills/execute-step');
  assert.deepEqual(JSON.parse(request.options.body), { runId: 'run-1', confirmed: true });
});
