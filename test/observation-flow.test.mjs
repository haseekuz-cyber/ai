import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRepeatSemanticObservation,
  findLatestSemanticObservation,
  semanticObservationGoal,
  summarizeSemanticObservation
} from '../public/observation-flow.js';

function observedSkill(overrides = {}) {
  return {
    skillId: 'observation-1',
    createdAt: '2026-08-13T10:00:00.000Z',
    application: { processName: 'CorelDRW' },
    executionPolicy: { replayable: true },
    causalReplay: { ready: true },
    semanticExperience: {
      understood: true,
      confidence: 0.72,
      sessionGoal: 'Нарисовать круг',
      whyActions: 'Инструмент создаёт форму на холсте',
      comparison: { after: 'На холсте виден круг', outcome: 'Круг создан' },
      episodes: [{ title: 'Создание формы' }],
      portableKnowledge: []
    },
    ...overrides
  };
}

test('latest semantic observation is selected for the active application', () => {
  const old = observedSkill({ skillId: 'old', createdAt: '2026-08-12T10:00:00.000Z' });
  const latest = observedSkill({ skillId: 'latest', createdAt: '2026-08-13T11:00:00.000Z' });
  const other = observedSkill({ skillId: 'other', application: { processName: 'Telegram' }, createdAt: '2026-08-14T11:00:00.000Z' });
  assert.equal(findLatestSemanticObservation([old, other, latest], 'CorelDRW').skillId, 'latest');
});

test('observation can explain what it understood and build a semantic replay goal', () => {
  const skill = observedSkill();
  assert.equal(canRepeatSemanticObservation(skill), true);
  assert.match(summarizeSemanticObservation(skill), /Цель: Нарисовать круг/);
  const goal = semanticObservationGoal(skill);
  assert.equal(goal.goal, 'Нарисовать круг');
  assert.match(goal.hypothesis, /без слепого повтора координат/);
  assert.ok(goal.confidence >= 0.6);
});

test('unclear observation may be explained but cannot be executed as understood', () => {
  const skill = observedSkill({
    semanticExperience: {
      understood: false,
      confidence: 0.1,
      sessionGoal: '',
      whyActions: '',
      comparison: { outcome: 'Результат неясен' },
      episodes: [],
      portableKnowledge: []
    }
  });
  assert.equal(canRepeatSemanticObservation(skill), false);
  assert.equal(semanticObservationGoal(skill), null);
  assert.match(summarizeSemanticObservation(skill), /Понял: нет/);
});
