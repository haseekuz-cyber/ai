import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionStore } from '../src/session-store.mjs';
import { ToolInvocationLedger } from '../src/tool-invocation-ledger.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

async function fixture({ policy = { authorize: () => ({ allowed: true }) }, inputArbiter = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tools-'));
  const eventStore = new SessionStore({ directory });
  await eventStore.start({ sessionId: 's1', goal: 'Тест', mode: 'guided', surface: { id: 'surface-1', mode: 'isolated' } });
  const ledger = new ToolInvocationLedger({ eventStore });
  return { eventStore, registry: new ToolRegistry({ ledger, policy, inputArbiter }) };
}

test('completed invocation returns cached result without repeating effect', async () => {
  const { registry } = await fixture();
  const isolatedSurface = { id: 'surface-1', mode: 'isolated' };
  let executions = 0;
  registry.register({ name: 'test.effect', risk: 'reversible_local', idempotency: 'at_most_once' }, async () => {
    executions += 1;
    return { ok: true };
  });
  const call = { toolInvocationId: 't1', name: 'test.effect', arguments: {} };
  const first = await registry.executeBatch({ sessionId: 's1', calls: [call], surface: isolatedSurface });
  const second = await registry.executeBatch({ sessionId: 's1', calls: [call], surface: isolatedSurface });
  assert.equal(executions, 1);
  assert.equal(first[0].status, 'completed');
  assert.equal(second[0].cached, true);
});

test('parallel read-only completions are committed by dispatchIndex', async () => {
  const { registry, eventStore } = await fixture();
  registry.register({ name: 'read.slow', risk: 'read_only', readOnly: true, idempotency: 'retryable' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { value: 'slow' };
  });
  registry.register({ name: 'read.fast', risk: 'read_only', readOnly: true, idempotency: 'retryable' }, async () => ({ value: 'fast' }));
  const results = await registry.executeBatch({
    sessionId: 's1',
    surface: { id: 'surface-1', mode: 'isolated' },
    calls: [
      { toolInvocationId: 'slow', name: 'read.slow', arguments: {} },
      { toolInvocationId: 'fast', name: 'read.fast', arguments: {} }
    ]
  });
  assert.deepEqual(results.map((result) => result.result.value), ['slow', 'fast']);
  const loaded = await eventStore.load('s1');
  const completed = loaded.events.filter((event) => event.type === 'tool.completed');
  assert.deepEqual(completed.map((event) => event.payload.dispatchIndex), [0, 1]);
});

test('recovered dispatched at-most-once invocation becomes indeterminate without another effect', async () => {
  const { registry, eventStore } = await fixture();
  let executions = 0;
  registry.register({ name: 'ui.effect', risk: 'reversible_local', idempotency: 'at_most_once' }, async () => {
    executions += 1;
    return { ok: true };
  });
  await eventStore.append('s1', {
    type: 'tool.requested', toolInvocationId: 't1', payload: { tool: 'ui.effect', arguments: {}, dispatchIndex: 0 }
  });
  await eventStore.append('s1', {
    type: 'tool.dispatched', toolInvocationId: 't1', payload: { tool: 'ui.effect', dispatchIndex: 0 }
  });
  const [result] = await registry.executeBatch({
    sessionId: 's1', calls: [{ toolInvocationId: 't1', name: 'ui.effect', arguments: {} }],
    surface: { id: 'surface-1', mode: 'isolated' }
  });
  assert.equal(executions, 0);
  assert.equal(result.status, 'indeterminate');
});

test('policy denial records a failed result and never calls the handler', async () => {
  const { registry } = await fixture({ policy: { authorize: () => ({ allowed: false, reason: 'confirmation_required' }) } });
  let executions = 0;
  registry.register({ name: 'code.apply', risk: 'persistent_local', idempotency: 'at_most_once' }, async () => {
    executions += 1;
  });
  const [result] = await registry.executeBatch({
    sessionId: 's1', calls: [{ toolInvocationId: 't1', name: 'code.apply', arguments: {} }],
    surface: { id: 'surface-1', mode: 'isolated' }
  });
  assert.equal(executions, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'policy_denied');
});

test('shared physical tool consumes a fresh lease before invoking its handler', async () => {
  const surface = { id: 'surface-1', mode: 'shared' };
  const inputArbiter = {
    acquire: async () => ({ leaseId: 'lease-1' }),
    consume: async () => ({ valid: false, reason: 'user_activity_changed' })
  };
  const { registry } = await fixture({ inputArbiter });
  let executions = 0;
  registry.register({
    name: 'ui.click', risk: 'reversible_local', idempotency: 'at_most_once', physicalInput: true
  }, async () => {
    executions += 1;
  });
  const [result] = await registry.executeBatch({
    sessionId: 's1', calls: [{ toolInvocationId: 't1', name: 'ui.click', arguments: {} }], surface
  });
  assert.equal(executions, 0);
  assert.equal(result.error.code, 'input_lease_invalid');
});
