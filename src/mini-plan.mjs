import { evaluateActionPolicy } from './action-policy.mjs';
import { groundPlannerProposal } from './agent-grounding.mjs';
import { findRepeatedFailedAction, findRepeatedSuccessfulAction, plannedActionsEquivalent } from './agent-planner.mjs';

const queueableActions = new Set(['click', 'doubleClick', 'typeText']);
const semanticGrounding = new Set(['semantic_target_found', 'inside_editable_target', 'single_editable_target']);

function rejection(reason, steps = []) {
  return { steps, rejectedReason: reason };
}

function semanticActionKey(action) {
  const hint = action?.targetHint || {};
  return [
    action?.type || '',
    String(hint.automationId || '').trim().toLowerCase(),
    String(hint.name || hint.visibleText || '').trim().toLowerCase(),
    String(hint.controlType || '').trim().toLowerCase()
  ].join('|');
}

export function prepareMiniPlanContinuation({
  proposals = [],
  firstAction = null,
  history = [],
  elements = [],
  windowBounds,
  processName = ''
} = {}) {
  const prepared = [];
  const previousActions = firstAction ? [firstAction] : [];
  const semanticKeys = new Set(previousActions.map(semanticActionKey));
  for (const proposal of proposals.slice(0, 2)) {
    const action = proposal?.action;
    if (!queueableActions.has(action?.type)) return rejection('unsupported_action', prepared);
    if (proposal.checkpoint !== 'deterministic') return rejection('visual_checkpoint', prepared);
    if (!proposal.precondition || !proposal.expectedResult) return rejection('missing_conditions', prepared);
    if (Number(proposal.confidence) < 0.9) return rejection('low_confidence', prepared);
    if (!['read_only', 'local_change'].includes(proposal.risk?.level)) return rejection('elevated_risk', prepared);
    const policy = evaluateActionPolicy({ proposal, processName });
    if (!policy.allowExecution || policy.externalEnvironment) return rejection('external_or_blocked', prepared);
    const semanticKey = semanticActionKey(action);
    if (semanticKeys.has(semanticKey) || findRepeatedFailedAction(action, history) || findRepeatedSuccessfulAction(action, history) ||
        previousActions.some((previous) => plannedActionsEquivalent(previous, action))) {
      return rejection('repeated_action', prepared);
    }
    let grounded;
    try {
      grounded = groundPlannerProposal({ proposal, elements, windowBounds });
    } catch {
      return rejection('not_semantically_grounded', prepared);
    }
    if (!semanticGrounding.has(grounded.grounding?.reason) || !grounded.grounding?.target) {
      return rejection('not_semantically_grounded', prepared);
    }
    if (grounded.grounding.reason === 'semantic_target_found' && Number(grounded.grounding.confidence) < 0.8) {
      return rejection('low_grounding_confidence', prepared);
    }
    prepared.push({
      proposal: grounded.proposal,
      preparedGrounding: grounded.grounding
    });
    previousActions.push(action);
    semanticKeys.add(semanticKey);
  }
  return { steps: prepared, rejectedReason: null };
}

export function publicMiniPlan(miniPlan) {
  if (!miniPlan) return null;
  return {
    miniPlanId: miniPlan.miniPlanId,
    total: miniPlan.steps.length,
    completed: miniPlan.nextIndex,
    remaining: Math.max(0, miniPlan.steps.length - miniPlan.nextIndex),
    createdAt: miniPlan.createdAt,
    sourcePlanId: miniPlan.sourcePlanId || null
  };
}
