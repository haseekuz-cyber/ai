import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnarchyRecoveryState,
  decideAnarchyRecovery,
  resetAnarchyRecoveryState
} from '../public/anarchy-recovery.js';

test('anarchy records one correction and abandons a repeated identical failure', () => {
  const first = decideAnarchyRecovery(createAnarchyRecoveryState(), {
    missionId: 'mission-1', errorCode: 'invalid_local_plan',
    abortReason: 'visual_target_not_verified', message: 'target is not visible'
  });
  assert.equal(first.action, 'retry');
  assert.equal(first.shouldRecordCorrection, true);

  const second = decideAnarchyRecovery(first.state, {
    missionId: 'mission-1', errorCode: 'invalid_local_plan',
    abortReason: 'visual_target_not_verified', message: 'target is not visible'
  });
  assert.equal(second.action, 'new_mission');
  assert.equal(second.shouldRecordCorrection, false);
  assert.match(second.report, /той же ошибке/);
});

test('stale window or document starts a fresh mission without polluting guidance', () => {
  const result = decideAnarchyRecovery(resetAnarchyRecoveryState('mission-1'), {
    missionId: 'mission-1', errorCode: 'stale_mission', message: 'document changed'
  });
  assert.equal(result.action, 'new_mission');
  assert.equal(result.shouldRecordCorrection, false);
  assert.match(result.report, /новому снимку/);
});

test('the same failure remains tracked across replacement missions', () => {
  const previous = decideAnarchyRecovery(createAnarchyRecoveryState(), {
    missionId: 'mission-1', errorCode: 'invalid_local_plan', message: 'failed'
  });
  const next = decideAnarchyRecovery(previous.state, {
    missionId: 'mission-2', errorCode: 'invalid_local_plan', message: 'failed'
  });
  assert.equal(next.state.total, 2);
  assert.equal(next.state.repeated, 2);
  assert.equal(next.action, 'new_mission');
});

test('anarchy pauses for a human instead of spinning forever', () => {
  let state = createAnarchyRecoveryState();
  let decision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    decision = decideAnarchyRecovery(state, {
      missionId: `mission-${attempt + 1}`,
      errorCode: 'invalid_local_plan',
      abortReason: 'visual_target_not_verified',
      message: 'same failure'
    });
    state = decision.state;
  }
  assert.equal(decision.action, 'needs_user');
  assert.equal(decision.delayMs, null);
  assert.match(decision.report, /приостановлен/);
});

test('an infrastructure capture failure stops retries and is never learned as a bad UI action', () => {
  const decision = decideAnarchyRecovery(createAnarchyRecoveryState(), {
    missionId: 'mission-1',
    errorCode: 'display_capture_failed',
    message: 'capture-display.ps1 failed'
  });
  assert.equal(decision.action, 'infrastructure_error');
  assert.equal(decision.shouldRecordCorrection, false);
  assert.equal(decision.delayMs, null);
  assert.match(decision.report, /технического слоя/);
});

test('an image crop failure is infrastructure and never becomes UI guidance', () => {
  const decision = decideAnarchyRecovery(createAnarchyRecoveryState(), {
    missionId: 'mission-1',
    errorCode: 'image_crop_failed',
    message: 'crop-image-region.ps1 failed'
  });
  assert.equal(decision.action, 'infrastructure_error');
  assert.equal(decision.shouldRecordCorrection, false);
  assert.equal(decision.delayMs, null);
});
