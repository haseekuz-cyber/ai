import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, logicalStateHash } from '../src/canonical-json.mjs';
import { createSessionEvent, validateSessionEvent } from '../src/session-events.mjs';

test('canonical state hash is independent of object insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(logicalStateHash({ b: 2, a: 1 }), logicalStateHash({ a: 1, b: 2 }));
});

test('canonical state preserves array order', () => {
  assert.equal(canonicalJson({ values: [3, 2, 1] }), '{"values":[3,2,1]}');
  assert.notEqual(logicalStateHash([1, 2]), logicalStateHash([2, 1]));
});

test('canonical state rejects values outside the JSON data model', () => {
  assert.throws(() => canonicalJson({ confidence: Number.NaN }), /finite JSON number/);
  assert.throws(() => canonicalJson({ missing: undefined }), /only JSON values/);
  assert.throws(() => canonicalJson(new Date()), /only JSON values/);
});

test('tool lifecycle events require toolInvocationId', () => {
  assert.throws(() => createSessionEvent({
    sessionId: 's1', sequence: 1, type: 'tool.requested', payload: { tool: 'ui.click' }, stateHash: 'a'.repeat(64)
  }), /toolInvocationId/);
});

test('event sequence must be contiguous', () => {
  const event = createSessionEvent({
    sessionId: 's1', sequence: 3, type: 'session.started', payload: {}, stateHash: 'a'.repeat(64)
  });
  assert.throws(() => validateSessionEvent(event, 1), /expected sequence 2/);
});

test('event schema rejects unknown fields and malformed hashes', () => {
  assert.throws(() => createSessionEvent({
    sessionId: 's1', sequence: 1, type: 'session.started', payload: {}, stateHash: 'not-a-hash'
  }), /stateHash/);
  assert.throws(() => createSessionEvent({
    sessionId: 's1', sequence: 1, type: 'session.started', payload: {}, stateHash: 'a'.repeat(64), role: 'planner'
  }), /unknown event field: role/);
});

test('validated events are detached from mutable input payloads', () => {
  const payload = { goal: 'Создать документ' };
  const event = createSessionEvent({
    sessionId: 's1', sequence: 1, type: 'session.started', payload, stateHash: 'a'.repeat(64)
  });
  payload.goal = 'Изменено снаружи';
  assert.equal(event.payload.goal, 'Создать документ');
  assert.equal(validateSessionEvent(event, 0), event);
});
