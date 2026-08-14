import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialSessionState, reduceSessionEvent } from '../src/session-reducer.mjs';

test('new user goal cannot inherit an unfinished previous goal', () => {
  const first = createInitialSessionState({ sessionId: 's1', goal: 'Старая задача', mode: 'guided', surface: null });
  const second = createInitialSessionState({ sessionId: 's2', goal: 'Привет кто ты?', mode: 'chat', surface: null });
  assert.equal(first.status, 'running');
  assert.equal(second.goal, 'Привет кто ты?');
  assert.deepEqual(second.pendingCriteria, []);
  assert.doesNotMatch(JSON.stringify(second), /Старая задача/);
});

test('reducer records tool lifecycle without executing effects or mutating prior state', () => {
  const state = createInitialSessionState({ sessionId: 's1', goal: 'Нажми кнопку', mode: 'guided', surface: null });
  const next = reduceSessionEvent(state, {
    sequence: 2,
    type: 'tool.dispatched',
    toolInvocationId: 't1',
    payload: { tool: 'ui.click', dispatchIndex: 0 }
  });
  assert.equal(next.tools.t1.status, 'dispatched');
  assert.equal(next.tools.t1.tool, 'ui.click');
  assert.equal(state.tools.t1, undefined);
  assert.equal(next.lastEventSequence, 2);
});

test('completed tool result becomes the single latest tool result', () => {
  const state = createInitialSessionState({ sessionId: 's1', goal: 'Проверь', mode: 'guided', surface: null });
  const next = reduceSessionEvent(state, {
    sequence: 2,
    type: 'tool.completed',
    toolInvocationId: 't1',
    payload: { tool: 'observe.display', result: { ok: true, sha256: 'frame-1' } }
  });
  assert.deepEqual(next.lastToolResult, {
    toolInvocationId: 't1',
    tool: 'observe.display',
    status: 'completed',
    result: { ok: true, sha256: 'frame-1' }
  });
});

test('session terminal event changes status without changing the original goal', () => {
  const state = createInitialSessionState({ sessionId: 's1', goal: 'Сохранить цель', mode: 'guided', surface: null });
  const next = reduceSessionEvent(state, {
    sequence: 2,
    type: 'session.cancelled',
    payload: { reason: 'user_stop' }
  });
  assert.equal(next.status, 'cancelled');
  assert.equal(next.goal, 'Сохранить цель');
  assert.equal(next.terminalReason, 'user_stop');
});
