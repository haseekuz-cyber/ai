import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedStepsForPrompt, buildApprovedStep, buildPlanFeedback, ratedStepsForPrompt } from '../src/feedback-store.mjs';

test('buildApprovedStep keeps a compact human-approved example', () => {
  const record = buildApprovedStep({
    feedbackId: 'feedback-1',
    createdAt: '2026-08-11T00:00:00.000Z',
    plan: {
      planId: 'plan-1', status: 'executed', missionId: 'mission-1', instruction: 'Нарисуй круг',
      window: { processName: 'CorelDRW', className: 'CorelDRAW27' },
      beforeScreenshot: 'before.png',
      beforeSha256: 'BEFORE',
      afterScreenshot: 'after.png',
      proposal: { action: { type: 'click', point: { x: 0.1, y: 0.2 } }, reason: 'Выбрать эллипс', expectedResult: 'Инструмент выбран' },
      validation: { success: true }
    }
  });
  assert.equal(record.kind, 'step_approved');
  assert.equal(record.step.humanApproved, true);
  assert.equal(record.application.processName, 'CorelDRW');
  assert.deepEqual(record.step.visualEvidence, {
    schemaVersion: 1,
    beforeImagePath: 'before.png',
    afterImagePath: 'after.png',
    beforeSha256: 'BEFORE',
    afterSha256: null,
    source: 'agent-execution'
  });
});

test('approvedStepsForPrompt states that coordinates are not replayed blindly', () => {
  const prompt = approvedStepsForPrompt([{ instruction: 'Задача', step: { action: { type: 'click' }, reason: 'Причина' } }]);
  assert.match(prompt, /свежим изображением/);
  assert.match(prompt, /не повторяй старые координаты вслепую/);
});

test('negative feedback is preserved as experience to avoid', () => {
  const record = buildPlanFeedback({
    feedbackId: 'feedback-2',
    rating: 'negative',
    plan: {
      planId: 'plan-2', status: 'executed', instruction: 'Нарисуй круг',
      window: { processName: 'CorelDRW' },
      proposal: { action: { type: 'click' }, reason: 'Неверный способ', expectedResult: 'Круг' }
    }
  });
  assert.equal(record.rating, 'negative');
  assert.equal(record.step.humanApproved, false);
  assert.match(ratedStepsForPrompt([record]), /не повторяй его без изменения/);
});
