import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abortActiveLmStudioRequests,
  activeLmStudioRequestCount,
  analyzeTextWithLmStudio,
  toStructuredChatCompletionRequest
} from '../src/lmstudio-client.mjs';

test('an in-flight local model request is aborted immediately on stop', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  try {
    const pending = analyzeTextWithLmStudio({
      baseUrl: 'http://127.0.0.1:1234',
      model: 'test-model',
      prompt: 'test',
      systemPrompt: 'test system',
      timeoutMs: 30_000
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeLmStudioRequestCount(), 1);
    assert.equal(abortActiveLmStudioRequests('stopped now'), 1);
    await assert.rejects(pending, /stopped now/);
    assert.equal(activeLmStudioRequestCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a completion cut off by the token limit is rejected before JSON parsing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: 'length',
          message: { content: '{"partial":' }
        }]
      };
    }
  });
  try {
    await assert.rejects(
      analyzeTextWithLmStudio({
        baseUrl: 'http://127.0.0.1:1234',
        model: 'test-model',
        prompt: 'test',
        systemPrompt: 'test system',
        maxOutputTokens: 1
      }),
      (error) => error?.code === 'lm_output_truncated' && error?.finishReason === 'length'
    );
    assert.equal(activeLmStudioRequestCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a truncated structured response is retried automatically with a larger output budget', async () => {
  const originalFetch = globalThis.fetch;
  const requestedLimits = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedLimits.push(request.max_tokens);
    return {
      ok: true,
      status: 200,
      async json() {
        if (requestedLimits.length === 1) {
          return { choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] };
        }
        return { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] };
      }
    };
  };
  try {
    const result = await analyzeTextWithLmStudio({
      baseUrl: 'http://127.0.0.1:1234',
      model: 'test-model',
      prompt: 'test',
      systemPrompt: 'test system',
      maxOutputTokens: 100
    });
    assert.deepEqual(requestedLimits, [100, 1_600]);
    assert.deepEqual(result.analysis, { ok: true });
    assert.equal(result.stats.outputTokenLimit, 1_600);
    assert.equal(result.stats.truncationRetries, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('planner structured output requires physical fields for each action type', () => {
  const request = toStructuredChatCompletionRequest({
    model: 'test-model',
    system_prompt: 'You are the local interface planner used in this test.',
    input: [{ type: 'text', content: 'next step' }],
    temperature: 0,
    max_output_tokens: 100
  });
  const variants = request.response_format.json_schema.schema.properties.action.oneOf;
  const byType = new Map(variants.map((variant) => [variant.properties.type.enum[0], variant]));
  assert.deepEqual(byType.get('click').required, ['type', 'point', 'targetHint']);
  assert.deepEqual(byType.get('drag').required, ['type', 'from', 'to', 'durationMs']);
  assert.deepEqual(byType.get('typeText').required, ['type', 'point', 'text', 'textMode', 'targetHint']);
  assert.deepEqual(byType.get('done').required, ['type']);
});

test('visual refinement schemas require coordinates when the target is visible', () => {
  const pointRequest = toStructuredChatCompletionRequest({
    model: 'test-model',
    system_prompt: 'You verify a point on a universal Windows application editing surface.',
    input: [{ type: 'text', content: 'find surface' }],
    temperature: 0,
    max_output_tokens: 100
  });
  const pointVisible = pointRequest.response_format.json_schema.schema.oneOf[0];
  assert.deepEqual(pointVisible.required, ['targetVisible', 'point', 'confidence', 'evidence']);

  const gestureRequest = toStructuredChatCompletionRequest({
    model: 'test-model',
    system_prompt: 'You recover a drawing gesture on a universal Windows application surface.',
    input: [{ type: 'text', content: 'find gesture' }],
    temperature: 0,
    max_output_tokens: 100
  });
  const gestureVisible = gestureRequest.response_format.json_schema.schema.oneOf[0];
  assert.deepEqual(gestureVisible.required, ['targetVisible', 'from', 'to', 'confidence', 'evidence']);
});
