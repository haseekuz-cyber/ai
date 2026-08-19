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

const REVIEW_PROMPT_LIMIT = 3_900;

function boundedText(value, maxLength = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// Truncates every string in place without removing a field. The reviewed proposal may carry a
// guardedMiniPlan whose queued actions the teacher is required to see, so shrinking it must
// never drop structure the safety contract depends on.
function boundedStrings(value, maxLength, depth = 0) {
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (depth >= 8) return Array.isArray(value) ? [] : value;
  if (Array.isArray(value)) return value.map((item) => boundedStrings(item, maxLength, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, boundedStrings(item, maxLength, depth + 1)]));
  }
  return value;
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
  // Ordered from least to most damaging. Every step must be able to run to the end, otherwise
  // the ladder has a floor above the limit and a normal three-source research result aborts the
  // mission instead of being reviewed with less context.
  const shrinkSteps = [
    () => (payload.durablePrinciples.length ? Boolean(payload.durablePrinciples.pop()) : false),
    () => (payload.publicDocumentation.length > 1 ? Boolean(payload.publicDocumentation.pop()) : false),
    () => {
      if (!payload.publicDocumentation.length) return false;
      const before = JSON.stringify(payload.publicDocumentation);
      payload.publicDocumentation = payload.publicDocumentation.map((source) => ({
        title: boundedText(source.title, 120),
        url: boundedText(source.url, 200),
        excerpt: boundedText(source.excerpt, 400)
      }));
      return JSON.stringify(payload.publicDocumentation) !== before;
    },
    () => (payload.publicDocumentation.length ? Boolean(payload.publicDocumentation.pop()) : false),
    () => (payload.verifiedHistory.length > 1 ? Boolean(payload.verifiedHistory.shift()) : false),
    () => (payload.humanGuidance.length > 1 ? Boolean(payload.humanGuidance.shift()) : false),
    () => {
      if (payload.teacher.values.length <= 600 && payload.task.length <= 600) return false;
      payload.teacher.values = payload.teacher.values.slice(0, 600);
      payload.task = payload.task.slice(0, 600);
      return true;
    },
    () => (payload.verifiedHistory.length ? Boolean(payload.verifiedHistory.shift()) : false),
    () => (payload.humanGuidance.length ? Boolean(payload.humanGuidance.shift()) : false),
    () => {
      if (!payload.teacher.mission && !payload.teacher.values) return false;
      payload.teacher.mission = '';
      payload.teacher.values = '';
      return true;
    },
    () => {
      const bounded = boundedStrings(payload.proposedStep, 400);
      if (JSON.stringify(bounded) === JSON.stringify(payload.proposedStep)) return false;
      payload.proposedStep = bounded;
      return true;
    },
    () => {
      const bounded = boundedStrings(payload.proposedStep, 120);
      if (JSON.stringify(bounded) === JSON.stringify(payload.proposedStep)) return false;
      payload.proposedStep = bounded;
      return true;
    },
    () => {
      if (payload.task.length <= 300) return false;
      payload.task = payload.task.slice(0, 300);
      return true;
    }
  ];

  let serialized = JSON.stringify(payload);
  for (const shrink of shrinkSteps) {
    while (serialized.length > REVIEW_PROMPT_LIMIT && shrink()) {
      serialized = JSON.stringify(payload);
    }
    if (serialized.length <= REVIEW_PROMPT_LIMIT) return serialized;
  }
  // Only reachable when the proposal alone, with every string cut to 120 characters, still
  // exceeds the limit. Dropping the queued actions instead would hide them from the review.
  throw new TypeError('Teacher review prompt is too large.');
}
