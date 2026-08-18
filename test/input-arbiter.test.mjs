import assert from 'node:assert/strict';
import test from 'node:test';

import { InputArbiter } from '../src/input-arbiter.mjs';
import { createBoundedPointerRequest } from '../src/pointer-bridge.mjs';
import { readWindowsUserActivity } from '../src/windows-user-activity.mjs';

test('lease is rejected when user activity changes before dispatch', async () => {
  let sequence = 4;
  const arbiter = new InputArbiter({ activityProvider: async () => ({ sequence }), now: () => 1_000, ttlMs: 250 });
  const lease = await arbiter.acquire({ id: 'display-1', mode: 'shared' });
  sequence = 5;
  assert.deepEqual(await arbiter.validate(lease, { id: 'display-1', mode: 'shared' }), {
    valid: false, reason: 'user_activity_changed'
  });
});

test('lease expires and cannot be reused for another surface', async () => {
  let now = 1_000;
  const arbiter = new InputArbiter({ activityProvider: async () => ({ sequence: 1 }), now: () => now, ttlMs: 250 });
  const lease = await arbiter.acquire({ id: 'display-1', mode: 'shared' });
  assert.deepEqual(await arbiter.validate(lease, { id: 'display-2', mode: 'shared' }), {
    valid: false, reason: 'wrong_surface'
  });
  now = 1_251;
  assert.deepEqual(await arbiter.validate(lease, { id: 'display-1', mode: 'shared' }), {
    valid: false, reason: 'expired'
  });
});

test('consuming a lease makes the physical dispatch at-most-once', async () => {
  const arbiter = new InputArbiter({ activityProvider: async () => ({ sequence: 1 }), now: () => 1_000 });
  const surface = { id: 'display-1', mode: 'shared' };
  const lease = await arbiter.acquire(surface);
  assert.equal((await arbiter.consume(lease, surface)).valid, true);
  assert.deepEqual(await arbiter.consume(lease, surface), { valid: false, reason: 'consumed' });
});

test('shared pointer request requires a lease bound to the execution surface', () => {
  const base = {
    action: { windowHandle: 1, action: 'click', confirmed: true, point: { x: 10, y: 10 } },
    allowedBounds: { x: 0, y: 0, width: 100, height: 100 },
    forbiddenProcessNames: [],
    executionSurface: { id: 'display-1', mode: 'shared' }
  };
  assert.throws(() => createBoundedPointerRequest(base), /inputLease/);
  const request = createBoundedPointerRequest({
    ...base,
    inputLease: {
      leaseId: 'lease-1', surfaceId: 'display-1', userActivitySequence: 'activity-1',
      issuedAtMs: 1_000, expiresAtMs: 1_250, lastInputTick: 10,
      cursor: { x: 1, y: 2 }, focusedWindowHandle: 3
    }
  });
  assert.equal(request.inputLease.surfaceId, 'display-1');
  assert.equal(request.executionSurface.mode, 'shared');
});

test('Windows activity adapter returns a stable compact snapshot', async () => {
  const snapshot = await readWindowsUserActivity(new URL('../scripts/user-activity.ps1', import.meta.url));
  assert.match(snapshot.sequence, /^[0-9a-f]{64}$/);
  assert.equal(Number.isSafeInteger(snapshot.lastInputTick), true);
  assert.equal(Number.isFinite(snapshot.cursor.x), true);
  assert.equal(Number.isSafeInteger(snapshot.focusedWindowHandle), true);
});
