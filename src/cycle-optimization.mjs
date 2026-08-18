const fastPathActions = new Set(['click', 'doubleClick', 'typeText']);
const fastPathGrounding = new Set([
  'semantic_target_found',
  'inside_editable_target',
  'single_editable_target'
]);
const anarchyTryFirstActions = new Set(['click', 'doubleClick', 'typeText']);

function hasRecentFailure(history) {
  return Array.isArray(history) && history.some((item) => item?.validation?.success !== true);
}

function isLocalAnarchyAttempt({ proposal, policy, missionMode, history, recoveryAttempts }) {
  if (missionMode !== 'anarchy') return false;
  if (!anarchyTryFirstActions.has(proposal?.action?.type)) return false;
  if (!['read_only', 'local_change'].includes(policy?.effectiveRisk)) return false;
  if (policy?.externalEnvironment === true) return false;
  if (hasRecentFailure(history) || Number(recoveryAttempts) > 0) return false;
  const point = proposal?.action?.point;
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

/**
 * JARVIS remains mandatory whenever a proposal carries ambiguity or elevated
 * impact.  The only skipped review is a high-confidence, reversible action
 * that deterministic grounding already bound to one real UIA element.
 */
export function decideTeacherReview({
  proposal,
  grounding,
  policy,
  history = [],
  guidance = [],
  recoveryAttempts = 0,
  missionMode = 'guided',
  visualRefinement = null
} = {}) {
  // The Planner output is already JARVIS's decision. In anarchy mode a
  // second model call before an ordinary local click only discusses the same
  // step again. Try once, validate the fresh result, and restore the Teacher
  // after any failure.
  if (isLocalAnarchyAttempt({ proposal, policy, missionMode, history, recoveryAttempts })) {
    return {
      required: false,
      route: 'anarchy_try_then_verify',
      reasons: ['single_reversible_attempt', 'fresh_post_action_validation_required']
    };
  }
  const reasons = [];
  const actionType = proposal?.action?.type || '';

  if (missionMode === 'anarchy') reasons.push('autonomous_mission');
  if (!fastPathActions.has(actionType)) reasons.push('non_deterministic_action');
  if (!['read_only', 'local_change'].includes(policy?.effectiveRisk)) reasons.push('elevated_risk');
  if (policy?.externalEnvironment === true) reasons.push('external_environment');
  if (Number(proposal?.confidence) < 0.9) reasons.push('low_planner_confidence');
  if (!fastPathGrounding.has(grounding?.reason)) reasons.push('non_semantic_grounding');
  if (grounding?.reason === 'semantic_target_found' && Number(grounding?.confidence) < 0.8) {
    reasons.push('low_grounding_confidence');
  }
  if (visualRefinement) reasons.push('visual_refinement_used');
  if (Number(recoveryAttempts) > 0) reasons.push('planner_recovery_used');
  if (hasRecentFailure(history)) reasons.push('recent_failure');
  if (Array.isArray(guidance) && guidance.length > 0) reasons.push('human_correction_present');

  if (reasons.length > 0) {
    return { required: true, route: 'teacher_review', reasons: [...new Set(reasons)] };
  }
  return {
    required: false,
    route: 'deterministic_grounded_fast_path',
    reasons: ['high_confidence_semantic_grounding']
  };
}

export function skippedTeacherApproval(decision) {
  if (decision?.required !== false) throw new TypeError('A skipped approval requires a fast-path decision.');
  const exploratory = ['anarchy_exploratory_probe', 'anarchy_try_then_verify'].includes(decision.route);
  return {
    decision: 'approve',
    approved: true,
    reason: exploratory
      ? 'User-enabled anarchy probe: try one reversible local action, then trust only the fresh result validation.'
      : 'Deterministic fast path: a high-confidence reversible action is bound to one real UI element.',
    guidance: '',
    question: '',
    researchQuery: '',
    confidence: 1,
    skipped: true,
    route: decision.route,
    gateReasons: decision.reasons
  };
}
