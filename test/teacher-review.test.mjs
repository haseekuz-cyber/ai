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

test('a full research result shrinks into the review prompt instead of aborting the mission', () => {
  // Live failure: after jarvis.research_completed returned three sources the builder threw
  // "Teacher review prompt is too large", /missions/plan-next answered with worker_error and
  // the mission was cancelled. The ladder could not drop the last source.
  const prompt = buildTeacherReviewPrompt({
    profile: { name: 'Qwen', mission: 'm'.repeat(600), values: 'v'.repeat(1_200) },
    instruction: 'i'.repeat(1_000),
    proposal: {
      action: { type: 'click', point: { x: 0.4, y: 0.4 }, targetHint: { name: 'Создать документ...' } },
      reason: 'r'.repeat(300),
      guardedMiniPlan: [{ action: { type: 'click', targetHint: { name: 'OK' } } }]
    },
    history: [{ action: { type: 'click' }, validation: { success: false, evidence: 'e'.repeat(300) } }],
    guidance: [{ correction: 'g'.repeat(400) }],
    principles: [{ name: 'p', description: 'd'.repeat(300) }],
    webSources: Array.from({ length: 3 }, () => ({
      title: 't'.repeat(180), url: 'u'.repeat(700), excerpt: 'x'.repeat(1_000)
    }))
  });
  assert.ok(prompt.length <= 3_900);
  const parsed = JSON.parse(prompt);
  assert.ok(parsed.task.length > 0);
  assert.equal(parsed.proposedStep.action.type, 'click');
  // The queued actions are what the teacher must approve, so shrinking never removes them.
  assert.equal(parsed.proposedStep.guardedMiniPlan.length, 1);
});

test('a review that already fits keeps its public documentation', () => {
  const parsed = JSON.parse(buildTeacherReviewPrompt({
    profile: { name: 'Qwen', mission: 'Учить', values: 'Не повторять' },
    instruction: 'Нарисуй круг',
    proposal: { action: { type: 'drag' } },
    webSources: [{ title: 'Docs', url: 'https://example.test/a', excerpt: 'Кнопка создаёт документ.' }]
  }));
  assert.equal(parsed.publicDocumentation.length, 1);
});
