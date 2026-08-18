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

// Every branch field is required at the top level, and there is no `oneOf`. A local
// GBNF grammar (LM Studio, Ollama) enforces top-level `required` and `enum` but ignores
// `oneOf` branch requirements — proven live, where an oneOf schema let the model answer
// with a bare {"type":"final"} and the turn failed on the missing fields. Forcing the
// full field set makes the grammar emit a complete object for every decision type;
// normalizeAgentDecision keeps the strict per-type validation and drops the fields the
// chosen type does not use, so a tool_call never carries a fabricated summary downstream.
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
  required: ['type', 'tool', 'arguments', 'reason', 'status', 'summary', 'evidence', 'question'],
  additionalProperties: false
});

export const UNIFIED_AGENT_SYSTEM_PROMPT = `You are JARVIS, the single decision-making model for a local Windows agent.
Use only the supplied AgentSession context. Preserve its goal, corrections, surface and latest tool result.
Choose exactly one next decision: call one declared tool, return a final result, or ask the user one necessary question.
Never invent a tool, tool result, observation, permission or completed effect. Never assign work to another role.
The program owns identifiers, policy, execution, validation and durable state. You only choose the next decision.
The schema lists every field; populate the ones your chosen type needs and send empty values ("", [], {}) for the rest.
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

export function normalizeAgentDecision(value) {
  requireObject(value, 'decision');
  const type = requireString(value.type, 'decision.type');
  if (!['tool_call', 'final', 'user_question'].includes(type)) {
    throw new TypeError(`unsupported decision type: ${type}`);
  }
  rejectUnknownFields(value);

  if (type === 'tool_call') {
    return cloneAndFreeze({
      type,
      tool: requireString(value.tool, 'decision.tool'),
      arguments: normalizeDecisionArguments(value.arguments, 'decision.arguments'),
      reason: requireString(value.reason, 'decision.reason')
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
      summary: requireString(value.summary, 'decision.summary'),
      evidence: value.evidence
    });
  }
  if (type === 'user_question') {
    return cloneAndFreeze({
      type,
      question: requireString(value.question, 'decision.question'),
      reason: requireString(value.reason, 'decision.reason')
    });
  }
  throw new TypeError(`unsupported decision type: ${type}`);
}
