import test from 'node:test';
import assert from 'node:assert/strict';
import { addMissionGuidance } from '../src/mission-guidance.mjs';

test('identical correction for the same failed step is stored only once', () => {
  const mission = { stepCount: 2, guidance: [] };
  const first = addMissionGuidance(mission, 'Try another visible method.', '2026-01-01T00:00:00.000Z');
  const second = addMissionGuidance(mission, 'Try another visible method.', '2026-01-01T00:00:01.000Z');
  assert.equal(first.saved, true);
  assert.equal(second.saved, false);
  assert.equal(second.duplicate, true);
  assert.equal(mission.guidance.length, 1);
});

test('a changed correction or a later step is retained', () => {
  const mission = { stepCount: 1, guidance: [] };
  addMissionGuidance(mission, 'First correction.');
  addMissionGuidance(mission, 'Second correction.');
  mission.stepCount = 2;
  addMissionGuidance(mission, 'Second correction.');
  assert.equal(mission.guidance.length, 3);
});
