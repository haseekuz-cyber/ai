import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePostActionValidation, verifyTypedValue } from '../src/event-validation.mjs';

test('exact accessible field value is verified without Qwen', () => {
  const deterministic = verifyTypedValue({
    action: { type: 'typeText', text: '40', textMode: 'replace' },
    grounding: { target: { runtimeId: 'field-1', name: 'Width', controlType: 'Edit' } },
    elements: [{ runtimeId: 'field-1', name: 'Width', controlType: 'Edit', value: '40' }]
  });
  const decision = decidePostActionValidation({ action: { type: 'typeText' }, deterministic });
  assert.equal(decision.route, 'deterministic');
  assert.equal(decision.validation.success, true);
});

test('canvas text and inaccessible fields still require vision', () => {
  const deterministic = verifyTypedValue({
    action: { type: 'typeText', text: 'Hello', textMode: 'insert' },
    grounding: { target: { name: 'Canvas' } },
    elements: []
  });
  assert.equal(decidePostActionValidation({
    action: { type: 'typeText' },
    deterministic,
    settling: { reason: 'changed_and_stable' }
  }).route, 'vision');
});

test('no change fails locally instead of spending a Qwen call', () => {
  const decision = decidePostActionValidation({
    action: { type: 'click' },
    settling: { reason: 'timeout_without_change' },
    deterministic: { available: false }
  });
  assert.equal(decision.route, 'local_no_change');
  assert.equal(decision.validation.success, false);
});
