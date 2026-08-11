import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPlanWindow } from '../src/plan-freshness.mjs';

const window = {
  processId: 42,
  nativeWindowHandle: 100,
  name: 'CorelDRAW - Безымянный-1',
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 }
};

function setup() {
  const plan = { planId: 'plan-1', window };
  const plans = new Map([[plan.planId, plan]]);
  return { plan, plans };
}

test('same window with changed geometry invalidates the plan and requests replan', () => {
  const { plan, plans } = setup();
  const result = assessPlanWindow({ plans, plan, currentWindow: { ...window, bounds: { ...window.bounds, x: 1912 } } });
  assert.equal(result.error, 'needs_replan');
  assert.equal(plans.has(plan.planId), false);
});

test('changed window identity invalidates the plan as stale', () => {
  const { plan, plans } = setup();
  const result = assessPlanWindow({ plans, plan, currentWindow: { ...window, name: 'CorelDRAW - Другой.cdr' } });
  assert.equal(result.error, 'stale_plan');
  assert.equal(plans.has(plan.planId), false);
});

test('unchanged window keeps the plan executable', () => {
  const { plan, plans } = setup();
  assert.equal(assessPlanWindow({ plans, plan, currentWindow: window }).status, 'fresh');
  assert.equal(plans.has(plan.planId), true);
});
