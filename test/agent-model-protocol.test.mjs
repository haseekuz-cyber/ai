import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_DECISION_SCHEMA,
  UNIFIED_AGENT_SYSTEM_PROMPT,
  normalizeAgentDecision
} from '../src/agent-model-protocol.mjs';
import { config } from '../src/config.mjs';
import { createLmStudioAgentClient } from '../src/lmstudio-client.mjs';

test('decision protocol accepts one tool call or final result but no role switch', () => {
  const decision = normalizeAgentDecision({
    type: 'tool_call',
    tool: 'repo.search',
    arguments: { query: 'sendTeacherMessage' },
    reason: 'Find caller'
  });
  assert.equal(decision.tool, 'repo.search');
  assert.throws(
    () => normalizeAgentDecision({ type: 'delegate', role: 'critic' }),
    /unsupported decision type/i
  );
});

test('decision protocol is strict, detached and contains no agent roles', () => {
  const input = {
    type: 'final',
    status: 'completed',
    summary: 'Готово',
    evidence: ['tool result']
  };
  const normalized = normalizeAgentDecision(input);
  input.evidence.push('mutated');
  assert.deepEqual(normalized.evidence, ['tool result']);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(AGENT_DECISION_SCHEMA.additionalProperties, false);
  assert.doesNotMatch(UNIFIED_AGENT_SYSTEM_PROMPT, /planner|critic|teacher|coder/i);
  assert.throws(
    () => normalizeAgentDecision({ ...input, extra: true }),
    /unsupported decision field/i
  );
});

test('the protocol never invents a tool, reason, summary or question for an unusable answer', () => {
  assert.throws(() => normalizeAgentDecision({ type: 'tool_call', arguments: {}, reason: 'Inspect' }), /decision\.tool/);
  assert.throws(() => normalizeAgentDecision({ type: 'tool_call', tool: '   ', arguments: {}, reason: 'Inspect' }), /decision\.tool/);
  assert.throws(() => normalizeAgentDecision({ type: 'tool_call', tool: 'repo.search', arguments: {}, reason: '   ' }), /decision\.reason/);
  assert.throws(() => normalizeAgentDecision({ type: 'final', status: 'completed', summary: '  ', evidence: [] }), /decision\.summary/);
  assert.throws(() => normalizeAgentDecision({ type: 'user_question', question: '', reason: 'Need input' }), /decision\.question/);
  for (const argumentsValue of [null, [], ' {} ']) {
    const decision = normalizeAgentDecision({ type: 'tool_call', tool: 'repo.search', arguments: argumentsValue, reason: 'Inspect' });
    assert.deepEqual(decision.arguments, {});
  }
});

test('active model overrides every legacy role alias even when old variables conflict', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    AI_WORKSTATION_ACTIVE_MODEL: 'one-model',
    AI_WORKSTATION_LM_STUDIO_MODEL: 'legacy-model',
    AI_WORKSTATION_VISION_MODEL: 'vision-model',
    AI_WORKSTATION_PLANNER_MODEL: 'planner-model',
    AI_WORKSTATION_CRITIC_MODEL: 'critic-model',
    AI_WORKSTATION_TEACHER_MODEL: 'teacher-model',
    AI_WORKSTATION_CODER_MODEL: 'coder-model'
  });
  try {
    const { config } = await import(`../src/config.mjs?single-model=${Date.now()}`);
    assert.equal(config.activeModel, 'one-model');
    assert.deepEqual(
      [config.lmStudioModel, config.visionModel, config.plannerModel, config.criticModel, config.teacherModel, config.coderModel],
      Array(6).fill('one-model')
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test('LM Studio adapter uses the unified strict schema for a full compiled context', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"type":"final","status":"completed","summary":"ok","evidence":[]}' }
          }]
        };
      }
    };
  };
  try {
    const client = createLmStudioAgentClient({ baseUrl: 'http://127.0.0.1:1234' });
    const result = await client({ pinned: { goal: 'x'.repeat(25_000) } }, {
      model: 'test-model',
      systemPrompt: UNIFIED_AGENT_SYSTEM_PROMPT,
      responseSchema: AGENT_DECISION_SCHEMA
    });
    assert.equal(result.type, 'final');
    assert.equal(request.model, 'test-model');
    assert.equal(request.response_format.json_schema.name, 'jarvis_agent_decision');
    assert.deepEqual(request.response_format.json_schema.schema, AGENT_DECISION_SCHEMA);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LM Studio adapter caps oversized agent prompts to the active context budget', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ finish_reason: 'stop', message: { content: '{"type":"final","status":"completed","summary":"ok","evidence":[]}' } }]
        };
      }
    };
  };
  try {
    const client = createLmStudioAgentClient({ baseUrl: 'http://127.0.0.1:1234' });
    const oversizedContext = {
      pinned: { goal: 'x'.repeat(200_000) },
      relevantMemory: Array.from({ length: 80 }, (_, index) => ({ text: 'memory '.repeat(400) + index })),
      recentEvents: Array.from({ length: 50 }, (_, index) => ({ sequence: index + 1, type: 'diagnostic.note', payload: { text: 'y'.repeat(500) } }))
    };
    await client(oversizedContext, {
      model: 'test-model', systemPrompt: UNIFIED_AGENT_SYSTEM_PROMPT, responseSchema: AGENT_DECISION_SCHEMA
    });
    const promptText = JSON.stringify(request.messages[1].content);
    const tokenEstimate = Math.ceil(promptText.length / 4);
    assert.ok(tokenEstimate <= Math.floor(config.unifiedAgentContextTokens * 0.60));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LM Studio adapter attaches the fresh observation returned by a UI tool', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-observation-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const screenshotPath = path.join(directory, 'frame.png');
  await fs.writeFile(screenshotPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ finish_reason: 'stop', message: { content: '{"type":"final","status":"completed","summary":"ok","evidence":[]}' } }] };
      }
    };
  };
  try {
    const client = createLmStudioAgentClient({ baseUrl: 'http://127.0.0.1:1234' });
    await client({ pinned: { lastToolResult: { tool: 'ui.observe', result: { screenshotPath } } } }, {
      model: 'test-model', systemPrompt: UNIFIED_AGENT_SYSTEM_PROMPT, responseSchema: AGENT_DECISION_SCHEMA
    });
    const userContent = request.messages[1].content;
    assert.equal(userContent.some((item) => item.type === 'image_url'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
