import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettlingEvidence } from '../src/action-validation.mjs';

const success = { success: true, evidence: 'Модель считает шаг успешным.', confidence: 0.95, limitations: [] };

test('a non-wait action fails closed when the screen never changes', () => {
  const result = applySettlingEvidence(success, { reason: 'timeout_without_change' }, { actionType: 'drag' });
  assert.equal(result.success, false);
  assert.equal(result.confidence, 0);
  assert.match(result.evidence, /No visible change/);
});

test('wait and visibly settled actions preserve visual validation', () => {
  assert.equal(applySettlingEvidence(success, { reason: 'timeout_without_change' }, { actionType: 'wait' }).success, true);
  assert.equal(applySettlingEvidence(success, { reason: 'changed_and_stable' }, { actionType: 'click' }).success, true);
});
