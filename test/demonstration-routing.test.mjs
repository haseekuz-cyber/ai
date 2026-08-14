import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRelevantDemonstrations } from '../src/demonstration-context.mjs';

const textSkill = {
  name: 'Написать фразу текстовым инструментом',
  instruction: 'Написать фразу Привет я твой ИИ ассистент на холсте',
  application: { processName: 'CorelDRW' },
  createdAt: '2026-08-12T00:00:00.000Z',
  steps: [{ type: 'typeText', text: 'Привет я твой ИИ ассистент' }],
  demonstration: { trajectory: [], keyboard: [] }
};

test('an unrelated saved demonstration cannot replace the current task', () => {
  const selected = selectRelevantDemonstrations([textSkill], {
    instruction: 'Нарисовать простой красный квадрат на чистой странице',
    processName: 'CorelDRW'
  });
  assert.deepEqual(selected, []);
});

test('a sufficiently similar saved demonstration remains available as evidence', () => {
  const selected = selectRelevantDemonstrations([textSkill], {
    instruction: 'Написать новую фразу текстовым инструментом на странице',
    processName: 'CorelDRW'
  });
  assert.equal(selected[0], textSkill);
});

test('semantic observation is found by its inferred goal rather than its generic recording title', () => {
  const observed = {
    name: 'Наблюдать за моей работой',
    instruction: 'Сохранять переносимые приёмы',
    application: { processName: 'browser' },
    createdAt: '2026-08-13T00:00:00.000Z',
    semanticExperience: {
      sessionGoal: 'Сделать три пирожка более прямоугольной формы',
      whyActions: 'Пользователь уточнял форму результата',
      comparison: { outcome: 'Форма пирожков скорректирована' },
      episodes: [{ title: 'Коррекция формы', goal: 'Прямоугольные пирожки', result: 'Форма изменена', technique: 'уточнять геометрию', retrievalTerms: ['пирожки'] }],
      portableKnowledge: []
    }
  };
  const selected = selectRelevantDemonstrations([observed], {
    instruction: 'Скорректируй форму пирожков',
    processName: 'browser'
  });
  assert.equal(selected[0], observed);
});
