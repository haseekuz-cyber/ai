import { canonicalJson } from './canonical-json.mjs';

const EVENT_FIELDS = new Set([
  'schemaVersion',
  'sessionId',
  'sequence',
  'type',
  'causationId',
  'toolInvocationId',
  'at',
  'payload',
  'stateHash'
]);

const TOOL_LIFECYCLE_TYPES = new Set([
  'tool.proposed',
  'tool.approval_recorded',
  'tool.requested',
  'tool.dispatched',
  'tool.completed',
  'tool.failed',
  'tool.indeterminate'
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function cloneJsonValue(value, field) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${field} must contain only JSON values: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createSessionEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Session event input must be an object.');
  }
  for (const field of Object.keys(input)) {
    if (!EVENT_FIELDS.has(field)) throw new TypeError(`unknown event field: ${field}`);
  }

  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new TypeError('schemaVersion must be 1.');
  requireNonEmptyString(input.sessionId, 'sessionId');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError('sequence must be a positive safe integer.');
  }
  requireNonEmptyString(input.type, 'type');
  if (input.causationId != null) requireNonEmptyString(input.causationId, 'causationId');
  if (input.toolInvocationId != null) requireNonEmptyString(input.toolInvocationId, 'toolInvocationId');
  if (TOOL_LIFECYCLE_TYPES.has(input.type) && !input.toolInvocationId) {
    throw new TypeError(`toolInvocationId is required for ${input.type}.`);
  }
  const at = input.at ?? new Date().toISOString();
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new TypeError('at must be a valid ISO timestamp.');
  }
  if (!/^[0-9a-f]{64}$/.test(input.stateHash ?? '')) {
    throw new TypeError('stateHash must be 64 lowercase hexadecimal characters.');
  }

  const event = {
    schemaVersion,
    sessionId: input.sessionId,
    sequence: input.sequence,
    type: input.type,
    at,
    payload: cloneJsonValue(input.payload ?? {}, 'payload'),
    stateHash: input.stateHash
  };
  if (input.causationId != null) event.causationId = input.causationId;
  if (input.toolInvocationId != null) event.toolInvocationId = input.toolInvocationId;
  return deepFreeze(event);
}

export function validateSessionEvent(event, previousSequence = 0) {
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    throw new TypeError('previousSequence must be a non-negative safe integer.');
  }
  const validated = createSessionEvent(event);
  const expected = previousSequence + 1;
  if (validated.sequence !== expected) {
    throw new Error(`Session event expected sequence ${expected}, received ${validated.sequence}.`);
  }
  return event;
}
