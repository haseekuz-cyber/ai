import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendTeacherExperience,
  isGeneralizedTeacherUpdate,
  normalizeTeacherUpdate,
  readTeacherExperiences,
  teacherExperiencesForPrompt
} from '../src/teacher-learning.mjs';

test('teacher experience persists and is filtered by selected application', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-learning-'));
  const filePath = path.join(directory, 'experiences.jsonl');
  const universal = normalizeTeacherUpdate({
    type: 'technique', name: 'Свежий экран', description: 'Проверять состояние интерфейса перед действием', scope: 'universal'
  });
  const scoped = normalizeTeacherUpdate({
    type: 'lesson', name: 'Инструмент активен', description: 'Не выбирать активный инструмент повторно', scope: 'selected_application'
  }, { application: { processName: 'DesignApp', name: 'Document' } });
  await appendTeacherExperience(filePath, universal);
  await appendTeacherExperience(filePath, scoped);
  assert.equal((await readTeacherExperiences(filePath, { processName: 'DesignApp' })).length, 2);
  assert.equal((await readTeacherExperiences(filePath, { processName: 'OtherApp' })).length, 1);
  assert.match(teacherExperiencesForPrompt([universal, scoped]), /свежим экраном/);
});

test('task-specific dimensions and literal text are rejected while portable technique is accepted', () => {
  const task = 'Сделай квадрат 40 см на 40 см и напиши «Привет»';
  const bad = normalizeTeacherUpdate({
    type: 'technique', name: 'Квадрат 40 см', description: 'Создать квадрат 40 см и написать «Привет»'
  });
  const good = normalizeTeacherUpdate({
    type: 'technique', name: 'Пропорциональная фигура',
    description: 'Удерживать модификатор равных сторон на всей траектории построения.',
    trigger: 'когда требуются равные стороны', expectedResult: 'ширина и высота фигуры совпадают'
  });
  assert.equal(isGeneralizedTeacherUpdate(bad, { userMessage: task, currentTask: task }), false);
  assert.equal(isGeneralizedTeacherUpdate(good, { userMessage: task, currentTask: task }), true);
});
