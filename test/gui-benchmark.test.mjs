import test from 'node:test';
import assert from 'node:assert/strict';
import { corelGroundingCases, scoreGuiPlan } from '../src/gui-benchmark.mjs';

test('GUI benchmark accepts the intended visible circle tool target', () => {
  const benchmarkCase = corelGroundingCases.find((item) => item.id === 'circle-task-first-step');
  const score = scoreGuiPlan({ current: { action: { type: 'click', point: { x: 0.012, y: 0.385 } } } }, benchmarkCase);
  assert.equal(score.passed, true);
});

test('GUI benchmark rejects a semantically unrelated text action', () => {
  const benchmarkCase = corelGroundingCases.find((item) => item.id === 'circle-task-first-step');
  const score = scoreGuiPlan({ current: { action: { type: 'typeText', point: { x: 0.4, y: 0.5 } } } }, benchmarkCase);
  assert.equal(score.passed, false);
  assert.equal(score.actionMatches, false);
  assert.equal(score.pointMatches, false);
});
