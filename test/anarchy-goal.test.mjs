import test from 'node:test';
import assert from 'node:assert/strict';
import { anarchyPlanningInstruction, normalizeAnarchyGoal } from '../src/anarchy-goal.mjs';

test('normalizes one safe actionable autonomous goal', () => {
  const goal = normalizeAnarchyGoal({
    actionable: true,
    goal: 'Создать один небольшой учебный объект',
    learningObjective: 'Научиться отличать холст от готового объекта',
    hypothesis: 'Перетаскивание на пустом холсте создаст новый объект',
    reason: 'Открыт пустой локальный документ',
    successCriteria: 'На странице виден новый объект',
    risk: 'local_change',
    confidence: 0.86
  });
  assert.equal(goal.actionable, true);
  assert.match(anarchyPlanningInstruction(goal), /Автономная цель/);
  assert.match(anarchyPlanningInstruction(goal), /гипотеза JARVIS/i);
});

test('rejects a low-confidence or incomplete autonomous goal', () => {
  assert.equal(normalizeAnarchyGoal({ actionable: true, goal: 'Что-нибудь', confidence: 0.4 }).actionable, false);
  assert.equal(normalizeAnarchyGoal({ actionable: false, goal: '', confidence: 0.9 }).actionable, false);
});
