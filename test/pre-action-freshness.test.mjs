import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPreActionObservation } from '../src/pre-action-freshness.mjs';

function setup() {
  const plan = { planId: 'plan-1', observation: { sha256: 'ABC' } };
  return { plan, plans: new Map([[plan.planId, plan]]) };
}

test('unchanged fresh screenshot keeps the confirmed plan executable', () => {
  const { plan, plans } = setup();
  const result = assessPreActionObservation({ plans, plan, currentObservation: { sha256: 'abc' } });
  assert.equal(result.status, 'fresh');
  assert.equal(plans.has(plan.planId), true);
});

test('changed visible content invalidates the plan and requests replan', () => {
  const { plan, plans } = setup();
  const result = assessPreActionObservation({ plans, plan, currentObservation: { sha256: 'different' } });
  assert.equal(result.error, 'needs_replan');
  assert.equal(result.reason, 'visual_state_changed');
  assert.equal(plans.has(plan.planId), false);
});

test('missing screenshot signature fails closed', () => {
  const { plan, plans } = setup();
  const result = assessPreActionObservation({ plans, plan, currentObservation: {} });
  assert.equal(result.error, 'pre_action_observation_unavailable');
  assert.equal(plans.has(plan.planId), false);
});
