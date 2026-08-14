const decisions = new Set(['approve', 'revise', 'research', 'abort', 'select']);

export const LIVE_TEACHER_SYSTEM_PROMPT = `You are JARVIS, an autonomous supervisor powered by Qwen and responsible for the success of a universal Windows UI agent.
You receive a fresh screenshot, the user's task, verified step history, durable values, and one proposed action. The proposal may include guardedMiniPlan with up to two following semantic actions.
Review the current action and every guardedMiniPlan action before any physical action occurs. Approve only when every queued action is local, reversible, currently visible, uniquely identifiable, and remains valid after the preceding action. Revise if the chain crosses a visual checkpoint or depends on a control that is not yet visible.
Return JSON only in this exact shape:
{
  "decision":"approve|revise|research|abort",
  "reason":"short Russian explanation",
  "guidance":"specific correction for the planner or empty string",
  "researchQuery":"public documentation query or empty string",
  "confidence":0.0
}
Approve only when the action is the next useful step and is supported by the fresh screenshot.
Before approving an edit, color, transform, property, or command, verify its visible prerequisite state: the intended object is present and selected and the required tool or mode is active. If not, revise toward the missing prerequisite first.
When a warning, dialog, menu, tooltip, or overlay obstructs the target after a failed attempt, revise toward safely dismissing the obstruction before continuing the goal.
If a required state was already achieved by a verified successful step, never approve repeating it merely for confirmation; request the next unmet result.
Use revise when the planner can correct the proposal from visible evidence, verified history, durable knowledge, or common UI semantics.
Use research only when public documentation about the selected application can resolve the uncertainty. Formulate one narrow query.
Use abort only for an irreversible or externally dangerous request. Ordinary uncertainty, a failed local action, or a blocking popup must become revise or research, not abort. Do not ask the user to solve the planning problem.
Do not invent controls, coordinates, completed results, or user intent. Do not perform actions yourself.`;

function boundedText(value, maxLength = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeTeacherReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Teacher review must be an object.');
  }
  const legacyAsk = value.decision === 'ask_user';
  const decision = decisions.has(value.decision) ? value.decision : legacyAsk ? 'revise' : 'abort';
  const confidence = Math.min(Math.max(Number(value.confidence) || 0, 0), 1);
  return {
    decision,
    approved: decision === 'approve',
    reason: boundedText(value.reason),
    guidance: boundedText(value.guidance) || (legacyAsk ? boundedText(value.question, 500) : ''),
    question: '',
    researchQuery: boundedText(value.researchQuery, 500),
    confidence
  };
}

export function buildTeacherReviewPrompt({ profile, instruction, proposal, history = [], principles = [], guidance = [], webSources = [] }) {
  const compactHistory = history.slice(-4).map((item) => ({
    action: item.action,
    success: item.validation?.success === true,
    evidence: boundedText(item.validation?.evidence, 300),
    humanFeedback: item.humanFeedback || null
  }));
  const compactPrinciples = principles.slice(0, 8).map((item) => ({
    name: boundedText(item.name, 120),
    rule: boundedText(item.description || item.statement, 300)
  }));
  const payload = {
    teacher: {
      name: boundedText(profile?.name, 120),
      mission: boundedText(profile?.mission, 600),
      values: boundedText(profile?.values, 1_200)
    },
    task: boundedText(instruction, 1_000),
    humanGuidance: guidance.slice(-4).map((item) => boundedText(item?.correction || item, 400)),
    verifiedHistory: compactHistory,
    durablePrinciples: compactPrinciples,
    publicDocumentation: webSources.slice(0, 3).map((source) => ({
      title: boundedText(source?.title, 180),
      url: boundedText(source?.url, 700),
      excerpt: boundedText(source?.excerpt, 1_000)
    })),
    proposedStep: proposal
  };
  let serialized = JSON.stringify(payload);
  while (serialized.length > 3_900 && payload.durablePrinciples.length) {
    payload.durablePrinciples.pop();
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > 3_900 && payload.publicDocumentation.length > 1) {
    payload.publicDocumentation.pop();
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > 3_900 && payload.verifiedHistory.length > 1) {
    payload.verifiedHistory.shift();
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > 3_900 && payload.humanGuidance.length > 1) {
    payload.humanGuidance.shift();
    serialized = JSON.stringify(payload);
  }
  if (serialized.length > 3_900) {
    payload.teacher.values = payload.teacher.values.slice(0, 600);
    payload.task = payload.task.slice(0, 600);
    serialized = JSON.stringify(payload);
  }
  if (serialized.length > 3_900) throw new TypeError('Teacher review prompt is too large.');
  return serialized;
}
