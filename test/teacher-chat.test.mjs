import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyPreparedTeacherEdits,
  buildTeacherChatPrompt,
  normalizeTeacherChatInput,
  normalizeTeacherChatResponse,
  prepareTeacherEdits,
  TEACHER_CHAT_SYSTEM_PROMPT,
  validateTeacherProposalArchitecture
} from '../src/teacher-chat.mjs';

test('teacher chat accepts text or a PNG and rejects untrusted image formats', () => {
  const input = normalizeTeacherChatInput({
    message: 'Объясни ошибку', mode: 'code', useInternet: true, windowHandle: 42, currentTask: 'Создать текст'
  });
  assert.equal(input.message, 'Объясни ошибку');
  assert.equal(input.mode, 'code');
  assert.equal(input.useInternet, true);
  assert.equal(input.windowHandle, 42);
  assert.throws(() => normalizeTeacherChatInput({ screenshotDataUrl: 'data:image/svg+xml;base64,AAAA' }), /PNG/);
});

test('teacher response carries durable learning and a safe experiment task', () => {
  const response = normalizeTeacherChatResponse({
    reply: 'Сохраняю правило и готовлю испытание.',
    agentUpdates: [{
      type: 'technique', name: 'Не повторять успех', description: 'Переходить дальше.',
      trigger: 'результат виден', expectedResult: 'следующий шаг', scope: 'universal'
    }],
    agentTask: { instruction: 'Продолжи текущую задачу', successCriteria: 'Появился следующий результат' },
    researchQueries: ['официальная документация']
  });
  assert.equal(response.agentUpdates.length, 1);
  assert.equal(response.agentTask.instruction, 'Продолжи текущую задачу');
  assert.deepEqual(response.researchQueries, ['официальная документация']);
});

test('teacher chat prompt keeps goals, conversation and bounded project context', () => {
  const prompt = buildTeacherChatPrompt({
    profile: { name: 'Qwen', mission: 'Учить', values: 'Проверять' },
    message: 'Исправь код',
    history: [{ role: 'user', text: 'Предыдущий вопрос' }],
    projectContext: [{ path: 'src/example.mjs', excerpt: 'x'.repeat(12_000) }]
  });
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.userMessage, 'Исправь код');
  assert.equal(parsed.requestMode, 'jarvis');
  assert.ok(prompt.length <= 18_000);
});

test('JARVIS chat never claims that a merely prepared task was physically completed', () => {
  assert.match(TEACHER_CHAT_SYSTEM_PROMPT, /does not execute physical UI actions/i);
  assert.match(TEACHER_CHAT_SYSTEM_PROMPT, /must not change the requested result/i);
});

test('JARVIS programmer may change model wrappers and the admin panel through tested files', () => {
  assert.match(TEACHER_CHAT_SYSTEM_PROMPT, /web admin panel/i);
  assert.match(TEACHER_CHAT_SYSTEM_PROMPT, /HTML, CSS, and JavaScript admin panel/i);
  assert.match(TEACHER_CHAT_SYSTEM_PROMPT, /tests pass/i);
});

test('teacher code edit is path-bounded, exact and applicable', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-code-'));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, 'src'));
  await fs.writeFile(path.join(projectRoot, 'src', 'sample.mjs'), 'export const value = 1;\n', 'utf8');
  const response = normalizeTeacherChatResponse({
    reply: 'Меняю значение.',
    proposedEdits: [{
      operation: 'replace', path: 'src/sample.mjs',
      search: 'value = 1', replacement: 'value = 2', reason: 'тест'
    }]
  });
  const prepared = await prepareTeacherEdits(projectRoot, response.proposedEdits);
  await applyPreparedTeacherEdits(prepared);
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'sample.mjs'), 'utf8'), 'export const value = 2;\n');
  await assert.rejects(
    prepareTeacherEdits(projectRoot, [{ ...response.proposedEdits[0], path: '../outside.mjs' }]),
    /Unsafe/
  );
});

test('teacher cannot replace an ambiguous fragment', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-code-'));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, 'public'));
  await fs.writeFile(path.join(projectRoot, 'public', 'app.js'), 'same\nsame\n', 'utf8');
  await assert.rejects(prepareTeacherEdits(projectRoot, [{
    operation: 'replace', path: 'public/app.js', search: 'same', replacement: 'new', reason: ''
  }]), /exactly once/);
});

test('JARVIS cannot pass an orphan runtime file as a working reprogramming', async (context) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-code-'));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, 'src'));
  const orphan = await prepareTeacherEdits(projectRoot, [{
    operation: 'create', path: 'src/orphan.mjs', search: '', replacement: 'export const unused = true;\n', reason: ''
  }]);
  assert.throws(() => validateTeacherProposalArchitecture(orphan), /unconnected runtime file/);

  await fs.writeFile(path.join(projectRoot, 'src', 'worker.mjs'), "export const ready = true;\n", 'utf8');
  const integrated = await prepareTeacherEdits(projectRoot, [
    { operation: 'create', path: 'src/feature.mjs', search: '', replacement: 'export const feature = true;\n', reason: '' },
    { operation: 'replace', path: 'src/worker.mjs', search: 'export const ready = true;', replacement: "import './feature.mjs';\nexport const ready = true;", reason: '' }
  ]);
  assert.equal(validateTeacherProposalArchitecture(integrated), true);
});
