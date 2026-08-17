import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { createAgentFixture } from './helpers/agent-fixture.mjs';

test('controller forwards every unified AgentSession route', async () => {
  const controller = await fs.readFile(new URL('../src/controller.mjs', import.meta.url), 'utf8');
  const worker = await fs.readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  for (const route of ['/agent/sessions', '/agent/sessions/next', '/agent/sessions/approve', '/agent/sessions/message', '/agent/sessions/stop', '/agent/sessions/status']) {
    assert.match(controller, new RegExp(`callWorker\\(['"]${route.replaceAll('/', '\\/')}['"]`));
    assert.match(worker, new RegExp(`url\\.pathname === ['"]${route.replaceAll('/', '\\/')}['"]`));
  }
});

test('fresh greeting cannot inherit an old UI error or trigger web search', async () => {
  const contexts = [];
  let webSearches = 0;
  const { engine, toolRegistry } = await createAgentFixture({
    modelClient: async (modelContext) => {
      contexts.push(modelContext);
      if (modelContext.pinned.goal.includes('старая')) {
        return { type: 'final', status: 'failed', summary: 'UI error', evidence: ['old failure'] };
      }
      return { type: 'final', status: 'completed', summary: 'Я JARVIS', evidence: [] };
    }
  });
  toolRegistry.register({
    name: 'web.search', risk: 'read_only', readOnly: true, idempotency: 'retryable',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }
  }, async () => {
    webSearches += 1;
    return { results: [] };
  });
  const oldSession = await engine.start({ goal: 'старая ошибка UI', mode: 'guided', surface: null });
  await engine.next(oldSession.sessionId);
  const greeting = await engine.start({ goal: 'привет кто ты?', mode: 'chat', surface: null });
  await engine.next(greeting.sessionId);
  assert.equal(contexts[1].pinned.goal, 'привет кто ты?');
  assert.doesNotMatch(JSON.stringify(contexts[1]), /старая ошибка|old failure/);
  assert.equal(webSearches, 0);
});

test('frontend uses one AgentSession identity and canonical autonomous copy', async () => {
  const [html, app] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(app, /currentAgentSessionId/);
  assert.match(app, /currentAgentAwaitingUser/);
  assert.match(app, /currentAgentPendingApproval/);
  assert.match(app, /\/api\/agent\/sessions/);
  assert.match(app, /\/api\/agent\/sessions\/approve/);
  assert.match(app, /\/api\/agent\/sessions\/message/);
  assert.match(app, /mode:\s*'autonomous'/);
  assert.match(html, />Автономный режим</);
  assert.doesNotMatch(html, />Анархичность</);
});

test('a stop the user asked for is reported as a stop, not as an agent failure', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // The server answers a cancelled turn with the session_cancelled code and the
  // stop reason as the message, so the quiet branch must key off the code.
  assert.match(app, /body\?\.error [!=]== 'session_cancelled'/);
  const turn = app.match(/async function runUnifiedAgentTurn[\s\S]*?\n\}\n/);
  assert.ok(turn, 'runUnifiedAgentTurn must stay one reviewable function');
  assert.doesNotMatch(turn[0], /String\(error\.message\)\.includes\('session_replaced'\)/);
  assert.match(turn[0], /cancelledTurnNotice\(error\)/);
});
