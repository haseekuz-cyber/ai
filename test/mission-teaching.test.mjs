import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeMissionsAfterTeaching, suspendMissionsForTeaching } from '../src/mission-teaching.mjs';

test('a live demonstration suspends and resumes the same active mission with skill guidance', () => {
  const mission = {
    missionId: 'm1', windowHandle: 42, status: 'active', stepCount: 3, guidance: []
  };
  const missions = new Map([[mission.missionId, mission]]);
  const suspendedMissions = suspendMissionsForTeaching(missions, 42, { now: 100, ttlMs: 1_000 });
  assert.equal(mission.status, 'teaching');
  assert.deepEqual(suspendedMissions, [{ missionId: 'm1', previousStatus: 'active' }]);

  const resumed = resumeMissionsAfterTeaching(missions, { suspendedMissions }, {
    skillId: 'skill-1', now: 200, ttlMs: 1_000
  });
  assert.deepEqual(resumed, ['m1']);
  assert.equal(mission.status, 'needs_review');
  assert.match(mission.guidance[0].correction, /skill-1/);
});

test('unrelated missions are not suspended by a demonstration', () => {
  const other = { missionId: 'm2', windowHandle: 99, status: 'active', guidance: [] };
  const missions = new Map([[other.missionId, other]]);
  assert.deepEqual(suspendMissionsForTeaching(missions, 42, { now: 100, ttlMs: 1_000 }), []);
  assert.equal(other.status, 'active');
});
