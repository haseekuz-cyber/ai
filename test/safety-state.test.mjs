import assert from 'node:assert/strict';
import test from 'node:test';

import { restoredSafetyPause, safetyStateToPersist } from '../src/safety-state.mjs';

test('a deliberate user stop survives a restart', () => {
  const restored = restoredSafetyPause({
    paused: true,
    source: 'user_stop',
    reason: 'Emergency hotkey Ctrl+Shift+F12',
    updatedAt: '2026-08-18T07:00:00.000Z'
  });
  assert.equal(restored.paused, true);
  assert.equal(restored.reason, 'Emergency hotkey Ctrl+Shift+F12');
  assert.equal(restored.source, 'user_stop');
  assert.equal(restored.discardedReason, null);
});

test('a pause written by a clean shutdown does not survive a restart', () => {
  const restored = restoredSafetyPause({
    paused: true,
    source: 'shutdown',
    reason: 'Full shutdown requested from AI Workstation',
    updatedAt: '2026-08-18T07:47:47.075Z'
  });
  assert.equal(restored.paused, false);
  assert.equal(restored.reason, null);
  assert.equal(restored.discardedReason, 'Full shutdown requested from AI Workstation');
});

test('a legacy record without a source is treated as a shutdown, not as a user stop', () => {
  const restored = restoredSafetyPause({
    paused: true,
    reason: 'Full shutdown requested from AI Workstation',
    updatedAt: '2026-08-18T07:47:47.075Z'
  });
  assert.equal(restored.paused, false);
  assert.equal(restored.discardedReason, 'Full shutdown requested from AI Workstation');
});

test('an unpaused record stays unpaused and a missing record is inert', () => {
  assert.equal(restoredSafetyPause({ paused: false, source: 'user_stop' }).paused, false);
  assert.equal(restoredSafetyPause(null).paused, false);
  assert.equal(restoredSafetyPause(undefined).discardedReason, null);
});

test('an unknown source is never trusted to restore a pause', () => {
  assert.equal(restoredSafetyPause({ paused: true, source: 'something_else' }).paused, false);
  assert.equal(restoredSafetyPause({ paused: true, source: 42 }).paused, false);
});

test('the persisted record always names the source that paused execution', () => {
  const persisted = safetyStateToPersist({
    paused: true,
    reason: 'Paused by user',
    source: 'user_stop',
    updatedAt: '2026-08-18T07:00:00.000Z'
  });
  assert.equal(persisted.source, 'user_stop');
  assert.equal(persisted.paused, true);
  assert.equal(safetyStateToPersist({ paused: false }).source, null);
});
