function observationSignature(observation) {
  return typeof observation?.sha256 === 'string' ? observation.sha256.trim().toLowerCase() : '';
}

export function assessPreActionObservation({ plans, plan, currentObservation }) {
  if (!(plans instanceof Map)) throw new TypeError('plans must be a Map.');
  if (!plan?.planId) throw new TypeError('plan.planId is required.');

  const plannedSignature = observationSignature(plan.observation);
  const currentSignature = observationSignature(currentObservation);
  if (!plannedSignature || !currentSignature) {
    plans.delete(plan.planId);
    return {
      status: 'needs_review',
      error: 'pre_action_observation_unavailable',
      message: 'A fresh screenshot could not be verified before execution.'
    };
  }
  if (plannedSignature !== currentSignature) {
    plans.delete(plan.planId);
    return {
      status: 'needs_replan',
      error: 'needs_replan',
      reason: 'visual_state_changed',
      message: 'The visible window state changed after planning. A fresh plan is required.'
    };
  }
  return { status: 'fresh', observation: currentObservation };
}
