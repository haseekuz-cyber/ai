import { classifyWindowChange } from './window-context.mjs';

export function assessPlanWindow({ plans, plan, currentWindow }) {
  if (!(plans instanceof Map)) throw new TypeError('plans must be a Map.');
  if (!plan?.planId) throw new TypeError('plan.planId is required.');

  const change = classifyWindowChange(currentWindow, plan.window);
  if (change === 'same') return { status: 'fresh' };

  plans.delete(plan.planId);
  if (change === 'geometry_changed') {
    return {
      status: 'needs_replan',
      error: 'needs_replan',
      message: 'Window position or size changed. A fresh plan is required for the same window.'
    };
  }
  return {
    status: 'stale',
    error: 'stale_plan',
    message: 'The target window, active document, or process changed after planning.'
  };
}
