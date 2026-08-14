import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTeacherReviewPrompt,
  LIVE_TEACHER_SYSTEM_PROMPT,
  normalizeTeacherReview
} from '../src/teacher-review.mjs';
import { buildTextRequest } from '../src/lmstudio-client.mjs';

test('teacher accepts only the typed live-review decisions', () => {
  assert.equal(normalizeTeacherReview({ decision: 'approve', confidence: 2 }).approved, true);
  const fallback = normalizeTeacherReview({ decision: 'anything', reason: 'сомнение' });
  assert.equal(fallback.decision, 'abort');
  assert.equal(fallback.approved, false);
});

test('teacher sees current task, human correction, verified history and proposal', () => {
  const prompt = buildTeacherReviewPrompt({
    profile: { name: 'Qwen', mission: 'Учить', values: 'Не повторять' },
    instruction: 'Нарисуй круг',
    proposal: { action: { type: 'drag' } },
    history: [{ action: { type: 'click' }, validation: { success: true, evidence: 'Инструмент активен' } }],
    guidance: [{ correction: 'Теперь тяни по холсту с Ctrl' }],
    principles: [{ name: 'Проверка', description: 'Смотри результат' }]
  });
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.task, 'Нарисуй круг');
  assert.deepEqual(parsed.humanGuidance, ['Теперь тяни по холсту с Ctrl']);
  assert.equal(parsed.verifiedHistory[0].success, true);
  assert.equal(parsed.proposedStep.action.type, 'drag');
  assert.ok(prompt.length <= 3_900);
});

test('teacher system policy forbids blind repetition of verified success', () => {
  assert.match(LIVE_TEACHER_SYSTEM_PROMPT, /never approve repeating/i);
  assert.match(LIVE_TEACHER_SYSTEM_PROMPT, /fresh screenshot/i);
  assert.doesNotMatch(LIVE_TEACHER_SYSTEM_PROMPT, /Use ask_user/);
});

test('text-only teacher development chat can carry bounded code context beyond vision limit', () => {
  const request = buildTextRequest({
    model: 'qwen',
    systemPrompt: 'Return JSON.',
    prompt: 'x'.repeat(10_000)
  });
  assert.equal(request.input[0].content.length, 10_000);
});
