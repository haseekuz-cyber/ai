import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findRepeatedFailedAction,
  findRepeatedSuccessfulAction
} from '../src/agent-planner.mjs';

test('a successful click cannot be proposed again merely for confirmation', () => {
  const action = { type: 'click', point: { x: 0.12, y: 0.34 } };
  const history = [{
    action: { type: 'click', point: { x: 0.12, y: 0.34 } },
    validation: { success: true, evidence: 'Tool is visibly active' }
  }];
  assert.equal(findRepeatedSuccessfulAction(action, history), history[0]);
  assert.equal(findRepeatedFailedAction(action, history), null);
});

test('a different next action is not blocked by successful history', () => {
  const history = [{
    action: { type: 'click', point: { x: 0.12, y: 0.34 } },
    validation: { success: true }
  }];
  assert.equal(findRepeatedSuccessfulAction({
    type: 'drag',
    from: { x: 0.3, y: 0.3 },
    to: { x: 0.6, y: 0.6 }
  }, history), null);
});
