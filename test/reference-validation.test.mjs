import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMultiImageVisionRequest } from '../src/lmstudio-client.mjs';
import {
  applyReferenceComparison,
  normalizeReferenceComparison,
  referenceNeedsReview
} from '../src/reference-validation.mjs';

const png = 'data:image/png;base64,AA==';

test('LM Studio comparison request contains reference and current screenshots in order', () => {
  const request = buildMultiImageVisionRequest({
    model: 'vision-model', prompt: 'compare', imageDataUrls: [png, png], systemPrompt: 'system'
  });
  assert.deepEqual(request.input.map((item) => item.type), ['text', 'image', 'image']);
});

test('matched reference preserves success only when step validation also succeeded', () => {
  const comparison = normalizeReferenceComparison({ success: true, evidence: 'Совпадает', confidence: 0.9 });
  assert.equal(applyReferenceComparison({ success: true, confidence: 0.95 }, comparison).success, true);
  assert.equal(applyReferenceComparison({ success: false, confidence: 0 }, comparison).success, false);
});

test('missing or unsupported reference comparison is typed needs_review and never success', () => {
  const comparison = referenceNeedsReview(new Error('multi-image unsupported'));
  const result = applyReferenceComparison({ success: true, evidence: 'Шаг выполнен', confidence: 0.9 }, comparison);
  assert.equal(comparison.status, 'needs_review');
  assert.equal(comparison.error, 'reference_compare_unavailable');
  assert.equal(result.success, false);
  assert.match(result.limitations.join(' '), /требует проверки пользователем/);
});
