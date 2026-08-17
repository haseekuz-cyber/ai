import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSettlingTracker,
  coalesceChangedCells,
  createSettlingTracker,
  selectTemporalKeyframePaths,
  WindowEventObserver
} from '../src/window-observer.mjs';

test('observer defaults to low-cost background timing and has a short active timing', () => {
  const observer = new WindowEventObserver({ scriptPath: 'observer.ps1' });
  assert.equal(observer.intervalMs, 1_200);
  assert.equal(observer.activeIntervalMs, 200);
  assert.equal(observer.currentIntervalMs, 1_200);
  assert.equal(observer.mode, 'idle');
});

test('adjacent changed cells become one normalized region', () => {
  const regions = coalesceChangedCells([
    { column: 1, row: 1 }, { column: 2, row: 1 }, { column: 2, row: 2 },
    { column: 7, row: 4 }
  ], 8, 6);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0], { x: 1 / 8, y: 1 / 6, width: 2 / 8, height: 2 / 6, cellCount: 3 });
});

test('event tracker reports changed and stable only after quiet frames', () => {
  const tracker = createSettlingTracker({ afterSequence: 4, startedAtMs: 1_000, minimumObservationMs: 500, stableSamples: 2 });
  assert.equal(advanceSettlingTracker(tracker, {
    type: 'frame', sequence: 5, changedFromPrevious: true, changedFraction: 0.02,
    changedCells: [{ column: 1, row: 1 }]
  }, 1_100).done, false);
  assert.equal(advanceSettlingTracker(tracker, {
    type: 'frame', sequence: 6, changedFromPrevious: false, changedFraction: 0, changedCells: []
  }, 1_350).done, false);
  assert.equal(advanceSettlingTracker(tracker, {
    type: 'frame', sequence: 7, changedFromPrevious: false, changedFraction: 0, changedCells: []
  }, 1_600).done, true);
  assert.equal(tracker.changed, true);
  assert.equal(tracker.stableStreak, 2);
});

test('frames at or before the action baseline are ignored', () => {
  const tracker = createSettlingTracker({ afterSequence: 10, startedAtMs: 0 });
  const result = advanceSettlingTracker(tracker, {
    type: 'frame', sequence: 10, changedFromPrevious: true, changedFraction: 1, changedCells: [{ column: 0, row: 0 }]
  }, 1_000);
  assert.equal(result.done, false);
  assert.equal(tracker.frameCount, 0);
  assert.equal(tracker.changed, false);
});

test('temporal keyframes are deduplicated and returned oldest to newest', () => {
  assert.deepEqual(selectTemporalKeyframePaths([
    { keyframePath: 'old.png' },
    { keyframePath: 'middle.png' },
    { keyframePath: 'middle.png' },
    { keyframePath: 'fresh.png' }
  ], { limit: 2 }), ['middle.png', 'fresh.png']);
});

test('temporal keyframes preserve the freshest frame and prefer important transitions', () => {
  assert.deepEqual(selectTemporalKeyframePaths([
    { keyframePath: 'critical.png', importance: 'critical' },
    { keyframePath: 'normal.png', importance: 'normal' },
    { keyframePath: 'low.png', importance: 'low' },
    { keyframePath: 'fresh.png', importance: 'low' }
  ], { limit: 3 }), ['critical.png', 'normal.png', 'fresh.png']);
});
