const allowedRisks = new Set(['read_only', 'local_change']);

export const ANARCHY_GOAL_SYSTEM_PROMPT = `You choose one coherent practice goal for a universal Windows UI agent.
Inspect only the supplied fresh screenshot. Do not continue an earlier user task and do not turn a saved demonstration into the goal.
Choose a small, useful, reversible learning experiment inside the visible application. State what JARVIS wants the worker to learn and one falsifiable hypothesis about how the visible interface behaves. The goal may inspect local state or create/edit unsaved local content. Never send, submit, publish, purchase, delete, overwrite a file, change account/security/system settings, or interact with another person.
An empty white artboard, page, or canvas is an editable surface, not an existing selectable object. Do not claim that the page background is a rectangle or another user object. If the app is an editor with an empty surface, a valid goal can be to create one small local practice object using visible tools.
Choose the goal only; do not return clicks, coordinates, buttons, or a sequence of steps.
Return JSON only:
{
  "actionable":true,
  "goal":"short Russian goal",
  "learningObjective":"general UI ability the worker should learn",
  "hypothesis":"what JARVIS predicts will happen and why",
  "reason":"why this goal fits the fresh visible state",
  "successCriteria":"one result that can be checked visually",
  "risk":"read_only|local_change",
  "confidence":0.0
}
If there is no clearly grounded safe local goal, set actionable to false, explain why, and use an empty goal.`;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeAnarchyGoal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Anarchy goal must be an object.');
  }
  const goal = cleanText(value.goal, 500);
  const learningObjective = cleanText(value.learningObjective, 500);
  const hypothesis = cleanText(value.hypothesis, 700);
  const reason = cleanText(value.reason, 700);
  const successCriteria = cleanText(value.successCriteria, 700);
  const risk = allowedRisks.has(value.risk) ? value.risk : 'local_change';
  const confidence = Math.min(Math.max(Number(value.confidence) || 0, 0), 1);
  const actionable = value.actionable === true && Boolean(goal) && Boolean(successCriteria) && confidence >= 0.6;
  return {
    actionable,
    goal: actionable ? goal : '',
    learningObjective: actionable ? learningObjective : '',
    hypothesis: actionable ? hypothesis : '',
    reason,
    successCriteria,
    risk,
    confidence
  };
}

export function anarchyPlanningInstruction(goal) {
  const normalized = normalizeAnarchyGoal({ ...goal, actionable: true });
  if (!normalized.actionable) throw new TypeError('A usable autonomous goal is required.');
  return [
    `Автономная цель этой сессии: ${normalized.goal}`,
    normalized.learningObjective ? `Чему JARVIS обучает рабочего агента: ${normalized.learningObjective}` : '',
    normalized.hypothesis ? `Проверяемая гипотеза JARVIS: ${normalized.hypothesis}` : '',
    `Критерий завершения: ${normalized.successCriteria}`
  ].filter(Boolean).join('\n');
}
