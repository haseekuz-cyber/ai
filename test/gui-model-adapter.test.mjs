import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptGuiModelAnalysis, guiModelFamily } from '../src/gui-model-adapter.mjs';

test('GUI-Owl 0..1000 coordinates are converted to normalized coordinates', () => {
  const adapted = adaptGuiModelAnalysis('gui-owl-1.5-8b-instruct', {
    action: { type: 'click', point: { x: 983, y: 402 } },
    nextActions: [{ action: { type: 'drag', from: { x: 300, y: 250 }, to: { x: 700, y: 800 } } }]
  });
  assert.deepEqual(adapted.action.point, { x: 0.983, y: 0.402 });
  assert.deepEqual(adapted.nextActions[0].action.from, { x: 0.3, y: 0.25 });
  assert.deepEqual(adapted.nextActions[0].action.to, { x: 0.7, y: 0.8 });
});

test('already normalized GUI-Owl coordinates remain unchanged', () => {
  const adapted = adaptGuiModelAnalysis('gui-owl-1.5-8b-instruct', { action: { type: 'click', point: { x: 0.4, y: 0.5 } } });
  assert.deepEqual(adapted.action.point, { x: 0.4, y: 0.5 });
});

test('generic models retain screenshot-pixel coordinates for the existing normalizer', () => {
  const analysis = { action: { type: 'click', point: { x: 983, y: 402 } } };
  assert.equal(guiModelFamily('qwen/qwen3-vl-8b'), 'generic');
  assert.deepEqual(adaptGuiModelAnalysis('qwen/qwen3-vl-8b', analysis), analysis);
});
