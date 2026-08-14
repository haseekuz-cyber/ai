import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_PRINCIPLES,
  createPrinciple,
  deletePrinciple,
  ensureCorePrinciples,
  ensurePrinciplesFromEpisodes,
  principlesForPrompt,
  readPrinciples,
  updatePrinciple,
  updatePrinciplesFromFeedback
} from '../src/knowledge-store.mjs';

test('core JARVIS principles replace task-specific principles and are protected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-core-'));
  const filePath = path.join(directory, 'principles.json');
  await fs.writeFile(filePath, JSON.stringify({ principles: [{ principleId: 'bad', name: 'Квадрат 40x40' }] }), 'utf8');
  const store = await ensureCorePrinciples(filePath);
  assert.equal(store.principles.length, CORE_PRINCIPLES.length);
  assert.ok(store.principles.every((item) => item.protected && item.source === 'jarvis_core'));
  await assert.rejects(deletePrinciple(filePath, store.principles[0].principleId), /cannot be deleted/i);
});

test('Qwen teacher can create an editable criterion without changing model weights', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-principles-teacher-'));
  const filePath = path.join(directory, 'principles.json');
  const created = await createPrinciple(filePath, {
    name: 'Переход после успеха',
    description: 'Если результат шага виден, не повторять действие.',
    applications: ['AnyApp'],
    source: 'qwen_teacher'
  });
  assert.equal(created.created, true);
  assert.equal(created.principle.source, 'qwen_teacher');
  const edited = await updatePrinciple(filePath, {
    principleId: created.principle.principleId,
    name: 'Переходить дальше',
    description: 'После видимого успеха планировать следующий результат.'
  });
  assert.equal(edited.principle.name, 'Переходить дальше');
});

test('persists model-independent UI principles and aggregates human outcomes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-principles-'));
  const filePath = path.join(directory, 'principles.json');
  const base = {
    createdAt: '2026-08-11T00:00:00.000Z',
    application: { processName: 'DesignApp' },
    step: { action: { type: 'drag', modifiers: ['Control'] } }
  };
  await updatePrinciplesFromFeedback(filePath, { ...base, rating: 'positive' });
  await updatePrinciplesFromFeedback(filePath, { ...base, rating: 'negative', application: { processName: 'OtherApp' } });
  const store = await readPrinciples(filePath);
  assert.equal(store.principles.length, 1);
  assert.equal(store.principles[0].positive, 1);
  assert.equal(store.principles[0].negative, 1);
  assert.deepEqual(store.principles[0].applications, ['DesignApp', 'OtherApp']);
  assert.equal(store.principles[0].name, 'Перетаскивание с Control');
  assert.match(principlesForPrompt(store.principles), /независимо от текущей модели/);
});

test('bootstraps principles from existing durable feedback episodes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-principles-bootstrap-'));
  const episodesPath = path.join(directory, 'episodes.jsonl');
  const principlesPath = path.join(directory, 'principles.json');
  const record = {
    rating: 'positive',
    createdAt: '2026-08-11T00:00:00.000Z',
    application: { processName: 'AnyApp' },
    step: { action: { type: 'click' } }
  };
  await fs.writeFile(episodesPath, `${JSON.stringify(record)}\n`, 'utf8');
  const result = await ensurePrinciplesFromEpisodes(principlesPath, episodesPath);
  assert.equal(result.imported, 1);
  assert.equal(result.store.principles[0].positive, 1);
});

test('allows a user to rename, describe, and delete a principle', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-principles-edit-'));
  const filePath = path.join(directory, 'principles.json');
  const created = await updatePrinciplesFromFeedback(filePath, {
    rating: 'positive',
    application: { processName: 'AnyApp' },
    step: { action: { type: 'click' } }
  });
  const principleId = created.principle.principleId;
  const edited = await updatePrinciple(filePath, {
    principleId,
    name: 'Клик только по подтверждённой кнопке',
    description: 'Перед кликом найди кнопку на свежем экране и проверь её назначение.'
  });
  assert.equal(edited.principle.editedByUser, true);
  assert.equal(edited.principle.name, 'Клик только по подтверждённой кнопке');
  const removed = await deletePrinciple(filePath, principleId);
  assert.equal(removed.deleted.principleId, principleId);
  assert.equal((await readPrinciples(filePath)).principles.length, 0);
});
