function defaultEstimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function compactEvent(event) {
  return {
    sequence: event.sequence,
    type: event.type,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    ...(event.toolInvocationId ? { toolInvocationId: event.toolInvocationId } : {}),
    payload: cloneJson(event.payload ?? {})
  };
}

function makeCompactionReferences(orderedEvents, recentEvents) {
  const omittedCount = orderedEvents.length - recentEvents.length;
  if (omittedCount <= 0) return [];
  const omitted = orderedEvents.slice(0, omittedCount);
  return [{
    fromSequence: omitted[0].sequence,
    toSequence: omitted.at(-1).sequence,
    count: omitted.length
  }];
}

function contextBody({ pinned, relevantMemory, recentEvents, orderedEvents }) {
  return {
    pinned,
    relevantMemory,
    recentEvents,
    compactionReferences: makeCompactionReferences(orderedEvents, recentEvents)
  };
}

export function compileAgentContext({
  state,
  events = [],
  contextWindowTokens,
  estimateTokens = defaultEstimateTokens
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('AgentSession state is required.');
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
    throw new TypeError('contextWindowTokens must be a positive safe integer.');
  }
  if (typeof estimateTokens !== 'function') throw new TypeError('estimateTokens must be a function.');

  const inputBudget = Math.floor(contextWindowTokens * 0.65);
  const outputReserve = Math.floor(contextWindowTokens * 0.20);
  const recoveryReserve = contextWindowTokens - inputBudget - outputReserve;
  const pinned = {
    protocolVersion: state.versions?.protocol ?? 1,
    sessionId: state.sessionId,
    goal: state.goal,
    mode: state.mode,
    surface: cloneJson(state.surface ?? null),
    allowedTools: cloneJson(state.allowedTools ?? []),
    permissions: cloneJson(state.permissions ?? null),
    pendingCriteria: cloneJson(state.pendingCriteria ?? []),
    corrections: cloneJson(state.corrections ?? []),
    hypothesis: cloneJson(state.hypothesis ?? null),
    lastObservation: cloneJson(state.lastObservation ?? null),
    lastToolResult: cloneJson(state.lastToolResult ?? null),
    versions: cloneJson(state.versions ?? { protocol: 1 })
  };

  const orderedEvents = events
    .filter((event) => event && Number.isSafeInteger(event.sequence) &&
      (!event.sessionId || event.sessionId === state.sessionId))
    .sort((left, right) => left.sequence - right.sequence)
    .map(compactEvent);
  const availableMemory = cloneJson(state.relevantMemory ?? state.verifiedMemory ?? []);
  const relevantMemory = [];
  const recentEvents = [];

  const pinnedOnly = contextBody({ pinned, relevantMemory, recentEvents, orderedEvents });
  if (estimateTokens(pinnedOnly) > inputBudget) {
    const error = new Error('Pinned AgentSession context exceeds the model input budget.');
    error.code = 'context_pinned_over_budget';
    throw error;
  }

  for (const memory of Array.isArray(availableMemory) ? availableMemory : []) {
    const candidateMemory = [...relevantMemory, memory];
    const candidate = contextBody({ pinned, relevantMemory: candidateMemory, recentEvents, orderedEvents });
    if (estimateTokens(candidate) <= inputBudget) relevantMemory.push(memory);
  }

  for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
    const candidateEvents = [orderedEvents[index], ...recentEvents];
    const candidate = contextBody({ pinned, relevantMemory, recentEvents: candidateEvents, orderedEvents });
    if (estimateTokens(candidate) > inputBudget) break;
    recentEvents.unshift(orderedEvents[index]);
  }

  const body = contextBody({ pinned, relevantMemory, recentEvents, orderedEvents });
  return {
    ...body,
    contextUsage: {
      contextWindowTokens,
      inputBudget,
      outputReserve,
      recoveryReserve,
      estimatedInputTokens: estimateTokens(body)
    }
  };
}

export class ContextCompiler {
  constructor({ contextWindowTokens, estimateTokens = defaultEstimateTokens } = {}) {
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
      throw new TypeError('contextWindowTokens must be a positive safe integer.');
    }
    if (typeof estimateTokens !== 'function') throw new TypeError('estimateTokens must be a function.');
    this.contextWindowTokens = contextWindowTokens;
    this.estimateTokens = estimateTokens;
  }

  compile({ state, events = [] } = {}) {
    return compileAgentContext({
      state,
      events,
      contextWindowTokens: this.contextWindowTokens,
      estimateTokens: this.estimateTokens
    });
  }
}
