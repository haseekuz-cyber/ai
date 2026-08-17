const STATES = ['raw', 'interpreted', 'verified', 'training_approved'];

export function normalizeExperienceTransition(input = {}) {
  const action = input.action && typeof input.action === 'object' ? input.action : null;
  if (!action?.type) throw new TypeError('Experience action.type is required.');
  const state = STATES.includes(input.state) ? input.state : 'raw';
  const modifiers = Array.isArray(input.modifiers) ? [...new Set(input.modifiers.map(String))] : [];
  const trajectory = Array.isArray(input.trajectory) ? input.trajectory.map((point) => ({
    x: Number(point.x), y: Number(point.y), t: Number(point.t ?? point.timeMs ?? 0)
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.t)) : [];
  return {
    schemaVersion: 1,
    episodeId: String(input.episodeId || ''),
    state,
    goal: String(input.goal || '').trim(),
    application: input.application || null,
    before: input.before || null,
    action: { ...action, text: action.text == null ? undefined : '[redacted]' },
    modifiers,
    trajectory: {
      importance: ['exact', 'adaptive', 'optional', 'replaceable'].includes(input.trajectoryImportance)
        ? input.trajectoryImportance : 'adaptive',
      points: trajectory
    },
    after: input.after || null,
    expectedResult: String(input.expectedResult || '').trim(),
    validation: input.validation || null,
    humanFeedback: input.humanFeedback || null,
    visualReference: input.visualReference || null,
    versions: input.versions || null
  };
}

export function promoteExperience(transition, nextState, evidence = {}) {
  const currentIndex = STATES.indexOf(transition?.state);
  const nextIndex = STATES.indexOf(nextState);
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) throw new Error('Experience states must be promoted one verified stage at a time.');
  if (nextState === 'verified' && evidence.validationSuccess !== true) throw new Error('Successful validation is required before an experience becomes verified.');
  if (nextState === 'training_approved' && evidence.humanApproved !== true) throw new Error('Human approval is required before training export.');
  return { ...transition, state: nextState, promotion: { at: new Date().toISOString(), evidence: { ...evidence } } };
}
