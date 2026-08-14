import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_TEACHER_PROFILE,
  ensureTeacherProfile,
  readTeacherProfile,
  writeTeacherProfile
} from '../src/teacher-profile.mjs';

test('teacher profile is created once and persists editable goals and values', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-teacher-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'teacher-profile.json');

  const initial = await ensureTeacherProfile(filePath);
  assert.equal(initial.name, DEFAULT_TEACHER_PROFILE.name);
  assert.ok(initial.updatedAt);

  const saved = await writeTeacherProfile(filePath, {
    name: 'JARVIS',
    mission: 'Учи агента понимать цель.',
    values: 'Не повторяй успешное действие.'
  });
  const loaded = await readTeacherProfile(filePath);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.name, 'JARVIS');
});

test('empty profile fields keep the last valid teacher configuration', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-teacher-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'teacher-profile.json');
  await writeTeacherProfile(filePath, { name: 'Наставник', mission: 'Цель', values: 'Правило' });
  const saved = await writeTeacherProfile(filePath, { name: '', mission: '', values: '' });
  assert.equal(saved.name, 'Наставник');
  assert.equal(saved.mission, 'Цель');
  assert.equal(saved.values, 'Правило');
});
