const DECISION_FIELDS = new Set([
  'type',
  'tool',
  'arguments',
  'reason',
  'status',
  'summary',
  'evidence',
  'question'
]);

const stringSchema = { type: 'string' };

export const AGENT_DECISION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['tool_call', 'final', 'user_question'] },
    tool: stringSchema,
    arguments: { type: 'object', additionalProperties: true },
    reason: stringSchema,
    status: { type: 'string', enum: ['completed', 'failed'] },
    summary: stringSchema,
    evidence: { type: 'array', items: stringSchema },
    question: stringSchema
  },
  required: ['type'],
  additionalProperties: false,
  oneOf: [
    {
      properties: { type: { type: 'string', enum: ['tool_call'] } },
      required: ['type', 'tool', 'arguments', 'reason']
    },
    {
      properties: { type: { type: 'string', enum: ['final'] } },
      required: ['type', 'status', 'summary', 'evidence']
    },
    {
      properties: { type: { type: 'string', enum: ['user_question'] } },
      required: ['type', 'question', 'reason']
    }
  ]
});

export const UNIFIED_AGENT_SYSTEM_PROMPT = `You are JARVIS, the single decision-making model for a local Windows agent.
Use only the supplied AgentSession context. Preserve its goal, corrections, surface and latest tool result.
Choose exactly one next decision: call one declared tool, return a final result, or ask the user one necessary question.
Never invent a tool, tool result, observation, permission or completed effect. Never assign work to another role.
The program owns identifiers, policy, execution, validation and durable state. You only choose the next decision.
Return JSON matching the supplied strict schema, with no markdown or extra fields.`;

function cloneAndFreeze(value) {
  const clone = JSON.parse(JSON.stringify(value));
  function freeze(entry) {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  }
  return freeze(clone);
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  return value.trim();
}

function rejectUnknownFields(value) {
  for (const field of Object.keys(value)) {
    if (!DECISION_FIELDS.has(field)) throw new TypeError(`unsupported decision field: ${field}`);
  }
}

function normalizeDecisionArguments(value, field = 'decision.arguments') {
  if (value == null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through and preserve the strict validation failure for non-object JSON payloads
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value) && value.length === 0) return {};
  throw new TypeError(`${field} must be an object.`);
}

function normalizeDecisionTool(value, field = 'decision.tool') {
  if (value == null) return 'ui.observe';
  if (typeof value !== 'string') throw new TypeError(`${field} must be a non-empty string.`);
  const trimmed = value.trim();
  return trimmed || 'ui.observe';
}

function normalizeDecisionReason(value, field = 'decision.reason', fallback = 'Proceed with the safest available action.') {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a non-empty string.`);
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function normalizeAgentDecision(value) {
  requireObject(value, 'decision');
  const type = requireString(value.type, 'decision.type');
  if (!['tool_call', 'final', 'user_question'].includes(type)) {
    throw new TypeError(`unsupported decision type: ${type}`);
  }
  rejectUnknownFields(value);

  if (type === 'tool_call') {
    const argumentsValue = normalizeDecisionArguments(value.arguments, 'decision.arguments');
    return cloneAndFreeze({
      type,
      tool: normalizeDecisionTool(value.tool, 'decision.tool'),
      arguments: argumentsValue,
      reason: normalizeDecisionReason(value.reason, 'decision.reason')
    });
  }
  if (type === 'final') {
    if (!['completed', 'failed'].includes(value.status)) {
      throw new TypeError('decision.status must be completed or failed.');
    }
    if (!Array.isArray(value.evidence) || value.evidence.some((entry) => typeof entry !== 'string')) {
      throw new TypeError('decision.evidence must be an array of strings.');
    }
    return cloneAndFreeze({
      type,
      status: value.status,
      summary: normalizeDecisionReason(value.summary, 'decision.summary', value.status === 'completed' ? 'Completed successfully.' : 'The task failed.'),
      evidence: value.evidence
    });
  }
  if (type === 'user_question') {
    return cloneAndFreeze({
      type,
      question: normalizeDecisionReason(value.question, 'decision.question', 'Need one missing detail to continue.'),
      reason: normalizeDecisionReason(value.reason, 'decision.reason')
    });
  }
  throw new TypeError(`unsupported decision type: ${type}`);
}
