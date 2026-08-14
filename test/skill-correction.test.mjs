import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHumanApprovedCorrectionPlan,
  plannerProposalAsCorrectionSteps,
  replaceSkillStep
} from '../src/skill-correction.mjs';

function skill() {
  return {
    skillId: 'skill-1',
    revision: 1,
    steps: [
      { index: 0, type: 'click', point: { x: 0.1, y: 0.1 } },
      { index: 1, type: 'click', point: { x: 0.2, y: 0.2 } },
      { index: 2, type: 'typeText', point: { x: 0.3, y: 0.3 }, text: 'old' }
    ]
  };
}

test('mini-demonstration replaces the failed persistent step and preserves ordered continuation', () => {
  const patched = replaceSkillStep({
    skill: skill(),
    failedStepIndex: 1,
    replacementSteps: [
      { type: 'click', point: { x: 0.4, y: 0.4 } },
      { type: 'drag', from: { x: 0.4, y: 0.4 }, to: { x: 0.6, y: 0.6 }, modifiers: ['Control'] }
    ],
    source: { kind: 'mini_demonstration', sourceId: 'correction-1' }
  });
  assert.equal(patched.steps.length, 4);
  assert.deepEqual(patched.steps.map((step) => step.index), [0, 1, 2, 3]);
  assert.equal(patched.steps[1].point.x, 0.4);
  assert.deepEqual(patched.steps[2].modifiers, ['Control']);
  assert.equal(patched.steps[3].text, 'old');
  assert.equal(patched.resumeStepIndex, 3);
  assert.equal(patched.revision, 2);
  assert.equal(patched.corrections[0].failedStepIndex, 1);
});

test('a human-confirmed correction plan becomes a reusable learned step', () => {
  const steps = plannerProposalAsCorrectionSteps({
    action: { type: 'typeText', point: { x: 0.5, y: 0.2 }, text: 'new', targetHint: { name: 'Caption' } },
    expectedResult: 'The caption contains the new value.'
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'typeText');
  assert.equal(steps[0].text, 'new');
  assert.deepEqual(steps[0].target, { name: 'Caption' });
});

test('a text correction cannot mutate a skill before explicit positive feedback', () => {
  assert.equal(isHumanApprovedCorrectionPlan({ status: 'executed', humanFeedback: null }), false);
  assert.equal(isHumanApprovedCorrectionPlan({ status: 'executed', humanFeedback: 'negative' }), false);
  assert.equal(isHumanApprovedCorrectionPlan({ status: 'planned', humanFeedback: 'positive' }), false);
  assert.equal(isHumanApprovedCorrectionPlan({ status: 'executed', humanFeedback: 'positive' }), true);
});
