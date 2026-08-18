import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTeacherReview, skippedTeacherApproval } from '../src/cycle-optimization.mjs';
import { normalizeValidatorOutput } from '../src/agent-planner.mjs';

function safeClick(overrides = {}) {
  return {
    proposal: {
      action: { type: 'click' },
      confidence: 0.96,
      ...overrides.proposal
    },
    grounding: {
      reason: 'semantic_target_found',
      confidence: 0.9,
      ...overrides.grounding
    },
    policy: {
      effectiveRisk: 'local_change',
      externalEnvironment: false,
      ...overrides.policy
    },
    ...overrides
  };
}

test('high-confidence semantic local action bypasses duplicate teacher review', () => {
  const decision = decideTeacherReview(safeClick());
  assert.equal(decision.required, false);
  assert.equal(decision.route, 'deterministic_grounded_fast_path');
  const approval = skippedTeacherApproval(decision);
  assert.equal(approval.approved, true);
  assert.equal(approval.skipped, true);
});

test('exploratory anarchy probe has a truthful skipped-review result', () => {
  const approval = skippedTeacherApproval({
    required: false,
    route: 'anarchy_exploratory_probe',
    reasons: ['reversible_fresh_visual_probe']
  });
  assert.equal(approval.approved, true);
  assert.equal(approval.skipped, true);
  assert.match(approval.reason, /reversible local action/i);
});

test('visual gestures, recovery, failure and human correction keep teacher review', () => {
  for (const scenario of [
    safeClick({ proposal: { action: { type: 'drag' }, confidence: 0.96 } }),
    safeClick({ recoveryAttempts: 1 }),
    safeClick({ history: [{ validation: { success: false } }] }),
    safeClick({ guidance: [{ correction: 'use another target' }] }),
    safeClick({ visualRefinement: { applied: true } })
  ]) {
    assert.equal(decideTeacherReview(scenario).required, true);
  }
});

test('anarchy tries one local reversible click before a second teacher call', () => {
  const decision = decideTeacherReview(safeClick({
    missionMode: 'anarchy',
    proposal: { action: { type: 'click', point: { x: 0.5, y: 0.5 } } }
  }));
  assert.equal(decision.required, false);
  assert.equal(decision.route, 'anarchy_try_then_verify');
  assert.equal(skippedTeacherApproval(decision).approved, true);
});

test('anarchy returns to teacher review after a failed attempt', () => {
  assert.equal(decideTeacherReview(safeClick({
    missionMode: 'anarchy',
    history: [{ validation: { success: false } }]
  })).required, true);
});

test('external, non-click autonomous and low-confidence actions keep teacher review', () => {
  assert.equal(decideTeacherReview(safeClick({ policy: { effectiveRisk: 'external_effect', externalEnvironment: true } })).required, true);
  assert.equal(decideTeacherReview(safeClick({ missionMode: 'anarchy', proposal: { action: { type: 'drag' } } })).required, true);
  assert.equal(decideTeacherReview(safeClick({ proposal: { action: { type: 'click' }, confidence: 0.7 } })).required, true);
  assert.equal(decideTeacherReview(safeClick({ grounding: { reason: 'semantic_target_found', confidence: 0.7 } })).required, true);
});

test('validator may return portable learning without a second model call', () => {
  const validation = normalizeValidatorOutput({
    success: true,
    evidence: 'The control is visibly selected.',
    confidence: 0.98,
    limitations: [],
    learningUpdate: {
      type: 'technique',
      name: 'Visible selection prerequisite',
      description: 'Select the target before changing its property.'
    }
  });
  assert.equal(validation.learningUpdate.type, 'technique');
  assert.equal(normalizeValidatorOutput({ success: false, confidence: 0 }).learningUpdate, null);
});
