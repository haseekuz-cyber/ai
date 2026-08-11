import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoundedPlannerPrompt, MAX_LOCAL_PROMPT_CHARS } from '../src/planner-prompt.mjs';

test('planner prompt never exceeds the local client limit', () => {
  const prompt = buildBoundedPlannerPrompt({
    instruction: 'Нарисуй круг',
    directive: 'Предложи один следующий шаг.',
    contextParts: ['\n' + 'a'.repeat(2_000), '\n' + 'b'.repeat(2_000), '\n' + 'c'.repeat(2_000)]
  });
  assert.ok(prompt.length <= MAX_LOCAL_PROMPT_CHARS);
  assert.match(prompt, /Нарисуй круг/);
  assert.match(prompt, /Предложи один следующий шаг/);
});

test('oversized optional context is skipped without truncating JSON', () => {
  const valid = '\n{"controls":["Круг"]}';
  const prompt = buildBoundedPlannerPrompt({
    instruction: 'Задача', directive: 'Шаг', contextParts: ['x'.repeat(4_000), valid]
  });
  assert.match(prompt, /"Круг"/);
  assert.doesNotMatch(prompt, /xxx/);
});
