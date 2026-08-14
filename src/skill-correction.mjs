const supportedTypes = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replacementStep(step, source) {
  if (!step || !supportedTypes.has(step.type)) throw new TypeError(`Unsupported correction step: ${step?.type || 'unknown'}`);
  return {
    ...clone(step),
    causal: {
      ...(step.causal || {}),
      schemaVersion: 1,
      role: 'essential',
      purpose: step.causal?.purpose || 'Исправленное пользователем выполнение конкретного шага.'
    },
    correctionSource: source
  };
}

export function replaceSkillStep({ skill, failedStepIndex, replacementSteps, source }) {
  if (!skill || !Array.isArray(skill.steps) || skill.steps.length === 0) throw new TypeError('Original skill is invalid.');
  const index = Number(failedStepIndex);
  if (!Number.isInteger(index) || index < 0 || index >= skill.steps.length) throw new RangeError('failedStepIndex is outside the skill.');
  if (!Array.isArray(replacementSteps) || replacementSteps.length === 0) throw new TypeError('At least one correction step is required.');
  const sourceRecord = {
    kind: source?.kind === 'validated_plan' ? 'validated_plan' : 'mini_demonstration',
    sourceId: String(source?.sourceId || ''),
    appliedAt: new Date().toISOString()
  };
  const replacements = replacementSteps.map((step) => replacementStep(step, sourceRecord));
  const steps = [
    ...skill.steps.slice(0, index),
    ...replacements,
    ...skill.steps.slice(index + 1)
  ].map((step, stepIndex) => ({ ...step, index: stepIndex }));
  return {
    ...clone(skill),
    steps,
    causalSteps: undefined,
    causalReplay: undefined,
    revision: Math.max(1, Number(skill.revision) || 1) + 1,
    corrections: [
      ...(Array.isArray(skill.corrections) ? skill.corrections : []),
      {
        ...sourceRecord,
        failedStepIndex: index,
        replacementStepCount: replacements.length
      }
    ].slice(-100),
    lastCorrectedAt: sourceRecord.appliedAt,
    resumeStepIndex: index + replacements.length
  };
}

export function plannerProposalAsCorrectionSteps(proposal, visualEvidence = null) {
  const action = proposal?.action;
  if (!action || !supportedTypes.has(action.type)) throw new TypeError('The confirmed plan has no reusable UI action.');
  const step = {
    index: 0,
    type: action.type,
    target: action.targetHint || null,
    expectedResult: proposal.expectedResult || 'Исправленный результат должен быть виден на свежем экране.',
    requiresConfirmation: true
  };
  for (const key of ['point', 'from', 'to', 'delta', 'durationMs', 'button', 'modifiers', 'trajectoryMode', 'trajectory']) {
    if (action[key] != null) step[key] = clone(action[key]);
  }
  if (action.type === 'typeText') step.text = String(action.text ?? '');
  if (action.type === 'pressKey') step.key = String(action.key ?? '');
  if (visualEvidence) step.visualEvidence = clone(visualEvidence);
  return [step];
}

export function isHumanApprovedCorrectionPlan(plan) {
  return Boolean(plan && plan.status === 'executed' && plan.humanFeedback === 'positive');
}
