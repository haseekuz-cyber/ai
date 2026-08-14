import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionStore } from '../src/session-store.mjs';

async function makeStore(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-session-'));
  return { directory, store: new SessionStore({ directory, ...options }) };
}

test('store restores identical state from log and verified snapshot', async () => {
  const { directory, store } = await makeStore({ snapshotEvery: 2 });
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  await store.append('s1', { type: 'user.message', payload: { text: 'уточнение' } });
  const before = await store.load('s1');
  const reopened = await new SessionStore({ directory, snapshotEvery: 2 }).load('s1');
  assert.deepEqual(reopened.state, before.state);
  assert.equal(reopened.events.length, 2);
  await fs.access(path.join(directory, 's1', 'snapshots', '2.json'));
});

test('serialized concurrent appends receive contiguous sequences', async () => {
  const { store } = await makeStore();
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  await Promise.all([
    store.append('s1', { type: 'user.message', payload: { text: 'первое' } }),
    store.append('s1', { type: 'user.message', payload: { text: 'второе' } })
  ]);
  const loaded = await store.load('s1');
  assert.deepEqual(loaded.events.map((event) => event.sequence), [1, 2, 3]);
});

test('changed payload with a stale state hash is rejected as session_corrupt', async () => {
  const { directory, store } = await makeStore();
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  await store.append('s1', { type: 'user.message', payload: { text: 'исходное' } });
  const eventsPath = path.join(directory, 's1', 'events.jsonl');
  const lines = (await fs.readFile(eventsPath, 'utf8')).trimEnd().split('\n');
  const changed = JSON.parse(lines[1]);
  changed.payload.text = 'подменено';
  lines[1] = JSON.stringify(changed);
  await fs.writeFile(eventsPath, `${lines.join('\n')}\n`, 'utf8');
  await assert.rejects(
    () => new SessionStore({ directory }).load('s1'),
    (error) => error?.code === 'session_corrupt' && /stateHash/.test(error.message)
  );
});

test('sequence gap is rejected as session_corrupt', async () => {
  const { directory, store } = await makeStore();
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  await store.append('s1', { type: 'user.message', payload: { text: 'два' } });
  await store.append('s1', { type: 'user.message', payload: { text: 'три' } });
  const eventsPath = path.join(directory, 's1', 'events.jsonl');
  const lines = (await fs.readFile(eventsPath, 'utf8')).trimEnd().split('\n');
  await fs.writeFile(eventsPath, `${lines[0]}\n${lines[2]}\n`, 'utf8');
  await assert.rejects(
    () => new SessionStore({ directory }).load('s1'),
    (error) => error?.code === 'session_corrupt' && /sequence/.test(error.message)
  );
});

test('truncated final event is never silently ignored', async () => {
  const { directory, store } = await makeStore();
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  const eventsPath = path.join(directory, 's1', 'events.jsonl');
  await fs.appendFile(eventsPath, '{"schemaVersion":1', 'utf8');
  await assert.rejects(
    () => new SessionStore({ directory }).load('s1'),
    (error) => error?.code === 'session_corrupt' && /truncated|JSON/.test(error.message)
  );
});
