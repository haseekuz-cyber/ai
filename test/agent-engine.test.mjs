import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentEngine } from '../src/agent-engine.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { ToolInvocationLedger } from '../src/tool-invocation-ledger.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import { createAgentFixture } from './helpers/agent-fixture.mjs';

const isolatedSurface = { id: 'surface-1', mode: 'isolated' };

test('same session returns a tool result to the same active model context', async () => {
  const seen = [];
  const modelClient = async (context, options) => {
    seen.push({ context, options });
    return seen.length === 1
      ? { type: 'tool_call', tool: 'test.read', arguments: {}, reason: 'Inspect' }
      : { type: 'final', status: 'completed', summary: 'Готово', evidence: ['visible'] };
  };
  const { engine, sessionStore } = await createAgentFixture({ modelClient });
  const session = await engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  const first = await engine.next(session.sessionId);
  const second = await engine.next(session.sessionId);
  assert.equal(first.kind, 'tool_result');
  assert.equal(second.kind, 'final');
  assert.equal(seen[0].options.model, 'test-model');
  assert.deepEqual(seen[0].context.availableTools.map((tool) => tool.name), ['test.read']);
  assert.equal(seen[1].options.model, 'test-model');
  assert.equal(seen[1].context.pinned.goal, 'Проверь');
  assert.equal(seen[1].context.pinned.lastToolResult.tool, 'test.read');
  const loaded = await sessionStore.load(session.sessionId);
  assert.equal(loaded.events.filter((event) => event.type === 'model.requested').length, 2);
  assert.equal(loaded.events.filter((event) => event.type === 'model.decided').length, 2);
  assert.match(loaded.events.find((event) => event.type === 'model.decided').payload.decisionId, /^[0-9a-f-]{36}$/);
  assert.match(loaded.events.find((event) => event.type === 'tool.requested').toolInvocationId, /^[0-9a-f-]{36}$/);
  assert.equal((await engine.status(session.sessionId)).sessionId, session.sessionId);
});

test('invalid model format is repaired once by the same active model', async () => {
  const calls = [];
  const modelClient = async (_context, options) => {
    calls.push(options);
    return calls.length === 1
      ? { type: 'tool_call', tool: '' }
      : { type: 'final', status: 'completed', summary: 'Исправлено', evidence: [] };
  };
  const { engine } = await createAgentFixture({ modelClient });
  const session = await engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  const result = await engine.next(session.sessionId);
  assert.equal(result.kind, 'final');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.model), ['test-model', 'test-model']);
  assert.equal(calls[1].repair, true);
  assert.match(calls[1].formatError, /decision|tool|arguments/i);
});

test('transport failure is not misclassified as a format repair', async () => {
  let calls = 0;
  const { engine } = await createAgentFixture({
    modelClient: async () => {
      calls += 1;
      const error = new Error('LM Studio unavailable');
      error.code = 'ECONNREFUSED';
      throw error;
    }
  });
  const session = await engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  await assert.rejects(engine.next(session.sessionId), /LM Studio unavailable/);
  assert.equal(calls, 1);
});

test('next calls are serialized per session', async () => {
  let active = 0;
  let maximum = 0;
  const modelClient = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { type: 'final', status: 'completed', summary: 'Готово', evidence: [] };
  };
  const { engine } = await createAgentFixture({ modelClient });
  const session = await engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  await Promise.all([engine.next(session.sessionId), engine.next(session.sessionId)]);
  assert.equal(maximum, 1);
});

test('stop aborts the active model request, cancels the session and blocks queued tools', async () => {
  let modelCalls = 0;
  let toolExecutions = 0;
  const modelClient = async (_context, { signal }) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return { type: 'tool_call', tool: 'test.effect', arguments: {}, reason: 'Do it' };
  };
  const fixture = await createAgentFixture({ modelClient });
  fixture.toolRegistry.register({
    name: 'test.effect', risk: 'reversible_local', idempotency: 'at_most_once',
    inputSchema: { type: 'object', additionalProperties: false }
  }, async () => {
    toolExecutions += 1;
    return { ok: true };
  });
  const session = await fixture.engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  const active = fixture.engine.next(session.sessionId);
  const queued = fixture.engine.next(session.sessionId);
  const activeRejected = assert.rejects(active, /user_stop|aborted|cancelled/i);
  const queuedRejected = assert.rejects(queued, /user_stop|aborted|cancelled/i);
  while (modelCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const stopped = await fixture.engine.stop(session.sessionId, 'user_stop');
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(toolExecutions, 0);
});

test('a reopened engine continues the same session from the persisted event log', async () => {
  const firstFixture = await createAgentFixture({
    modelClient: async () => ({ type: 'tool_call', tool: 'test.read', arguments: {}, reason: 'Inspect' })
  });
  const session = await firstFixture.engine.start({ goal: 'Продолжи', mode: 'guided', surface: isolatedSurface });
  await firstFixture.engine.next(session.sessionId);

  const reopenedStore = new SessionStore({ directory: firstFixture.directory });
  const reopenedRegistry = new ToolRegistry({
    ledger: new ToolInvocationLedger({ eventStore: reopenedStore }),
    policy: { authorize: () => ({ allowed: true }) }
  });
  reopenedRegistry.register({
    name: 'test.read', risk: 'read_only', readOnly: true, idempotency: 'retryable',
    inputSchema: { type: 'object', additionalProperties: false }
  }, async () => ({ ok: true }));
  const contexts = [];
  const reopened = new AgentEngine({
    sessionStore: reopenedStore,
    contextCompiler: {
      compile: ({ state }) => {
        const context = { pinned: { goal: state.goal, lastToolResult: state.lastToolResult } };
        contexts.push(context);
        return context;
      }
    },
    modelClient: async () => ({ type: 'final', status: 'completed', summary: 'Продолжено', evidence: [] }),
    toolRegistry: reopenedRegistry,
    activeModel: 'test-model'
  });
  const result = await reopened.next(session.sessionId);
  assert.equal(result.kind, 'final');
  assert.equal(contexts[0].pinned.goal, 'Продолжи');
  assert.equal(contexts[0].pinned.lastToolResult.tool, 'test.read');
});

test('a new session context cannot inherit an old goal or error', async () => {
  const seen = [];
  const { engine } = await createAgentFixture({
    modelClient: async (context) => {
      seen.push(context);
      return { type: 'final', status: 'completed', summary: 'Готово', evidence: [] };
    }
  });
  const oldSession = await engine.start({ goal: 'Старая цель и ошибка', mode: 'guided', surface: isolatedSurface });
  await engine.next(oldSession.sessionId);
  const freshSession = await engine.start({ goal: 'Новая цель', mode: 'guided', surface: isolatedSurface });
  await engine.next(freshSession.sessionId);
  assert.equal(seen[1].pinned.goal, 'Новая цель');
  assert.equal(seen[1].pinned.lastToolResult, null);
  assert.doesNotMatch(JSON.stringify(seen[1]), /Старая цель|ошибка/);
});
