import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextCompiler, compileAgentContext } from '../src/context-compiler.mjs';

const estimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 4);

function state(overrides = {}) {
  return {
    sessionId: 's1',
    goal: 'Создать документ',
    mode: 'guided',
    surface: null,
    pendingCriteria: ['Документ виден'],
    corrections: [],
    hypothesis: null,
    lastObservation: { sha256: 'screen-1' },
    lastToolResult: { toolInvocationId: 'tool-last', tool: 'observe.display', ok: true },
    versions: { protocol: 1, model: 'test-model' },
    ...overrides
  };
}

test('compiler never removes goal, pending criteria or last tool result', () => {
  const compiled = compileAgentContext({
    state: state(),
    events: Array.from({ length: 200 }, (_, index) => ({
      sessionId: 's1',
      sequence: index + 1,
      type: 'diagnostic.note',
      payload: { text: `noise-${index}-${'x'.repeat(80)}` }
    })),
    contextWindowTokens: 8_192,
    estimateTokens
  });
  assert.equal(compiled.pinned.goal, 'Создать документ');
  assert.deepEqual(compiled.pinned.pendingCriteria, ['Документ виден']);
  assert.equal(compiled.pinned.lastToolResult.toolInvocationId, 'tool-last');
  assert.ok(compiled.contextUsage.estimatedInputTokens <= Math.floor(8_192 * 0.65));
});

test('compiler is reproducible and excludes events from another session', () => {
  const input = {
    state: state({ sessionId: 'new-chat', goal: 'Привет кто ты?', mode: 'chat' }),
    events: [
      { sessionId: 'old-ui', sequence: 1, type: 'tool.failed', payload: { error: 'CorelDRAW старая ошибка' } },
      { sessionId: 'new-chat', sequence: 1, type: 'session.started', payload: { goal: 'Привет кто ты?' } }
    ],
    contextWindowTokens: 8_192,
    estimateTokens
  };
  const first = compileAgentContext(input);
  const second = compileAgentContext(input);
  assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), /CorelDRAW старая ошибка/);
});

test('compaction reference identifies the exact omitted sequence range', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    sessionId: 's1', sequence: index + 1, type: 'diagnostic.note', payload: { text: 'x'.repeat(120) }
  }));
  const compiled = compileAgentContext({
    state: state(),
    events,
    contextWindowTokens: 1_000,
    estimateTokens
  });
  assert.ok(compiled.recentEvents.length < events.length);
  const reference = compiled.compactionReferences[0];
  assert.deepEqual(reference, {
    fromSequence: 1,
    toSequence: compiled.recentEvents[0].sequence - 1,
    count: compiled.recentEvents[0].sequence - 1
  });
});

test('pinned context fails explicitly when the model window cannot contain it', () => {
  assert.throws(() => compileAgentContext({
    state: state({ goal: 'x'.repeat(2_000) }),
    events: [],
    contextWindowTokens: 128,
    estimateTokens
  }), (error) => error?.code === 'context_pinned_over_budget');
});

test('ContextCompiler class applies its configured budget deterministically', () => {
  const compiler = new ContextCompiler({ contextWindowTokens: 4_096, estimateTokens });
  const compiled = compiler.compile({ state: state(), events: [] });
  assert.deepEqual(compiled.contextUsage, {
    contextWindowTokens: 4_096,
    inputBudget: 2_662,
    outputReserve: 819,
    recoveryReserve: 615,
    estimatedInputTokens: compiled.contextUsage.estimatedInputTokens
  });
});
