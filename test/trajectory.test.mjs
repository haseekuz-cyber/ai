import test from 'node:test';
import assert from 'node:assert/strict';
import { learnedStepToPointerAction } from '../src/skill-runner.mjs';
import { trajectoryPolicy } from '../src/trajectory.mjs';

const bounds = { x: 100, y: 50, width: 1000, height: 800 };
const base = {
  type: 'drag', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 },
  durationMs: 500, trajectory: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.35 }, { x: 0.5, y: 0.5 }]
};

test('exact and adaptive modes pass the recorded path to the native executor', () => {
  for (const mode of ['exact', 'adaptive']) {
    const action = learnedStepToPointerAction({ ...base, trajectoryMode: mode }, bounds, 10);
    assert.equal(action.trajectory.length, 3);
    assert.deepEqual(action.trajectory[1], { x: 300, y: 330 });
  }
});

test('optional and replaceable modes use the shorter direct drag', () => {
  for (const mode of ['optional', 'replaceable']) {
    const action = learnedStepToPointerAction({ ...base, trajectoryMode: mode }, bounds, 10);
    assert.equal(action.trajectory, undefined);
    assert.equal(trajectoryPolicy({ ...base, trajectoryMode: mode }).includeRecordedPath, false);
  }
});

test('exact mode fails closed without a usable recorded path', () => {
  assert.throws(() => learnedStepToPointerAction({ ...base, trajectoryMode: 'exact', trajectory: [] }, bounds, 10), /requires at least two points/);
});
