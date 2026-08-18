const TERMINAL_STATUS_BY_EVENT = Object.freeze({
  'session.completed': 'completed',
  'session.failed': 'failed',
  'session.cancelled': 'cancelled',
  'session.waiting_for_user': 'waiting_for_user'
});

const TOOL_STATUS_BY_EVENT = Object.freeze({
  'tool.proposed': 'proposed',
  'tool.requested': 'requested',
  'tool.dispatched': 'dispatched',
  'tool.completed': 'completed',
  'tool.failed': 'failed',
  'tool.indeterminate': 'indeterminate'
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createInitialSessionState({ sessionId, goal, mode, surface, pendingCriteria = [], versions = {} } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId is required.');
  if (typeof goal !== 'string' || !goal.trim()) throw new TypeError('goal is required.');
  if (typeof mode !== 'string' || !mode.trim()) throw new TypeError('mode is required.');
  return deepFreeze({
    schemaVersion: 1,
    sessionId,
    goal: goal.trim(),
    mode,
    surface: cloneJson(surface ?? null),
    status: 'running',
    pendingCriteria: cloneJson(pendingCriteria),
    plan: [],
    corrections: [],
    hypothesis: null,
    lastObservation: null,
    lastToolResult: null,
    lastDecision: null,
    messages: [],
    tools: {},
    versions: { protocol: 1, ...cloneJson(versions) },
    terminalReason: null,
    lastEventSequence: 0
  });
}

function reduceToolEvent(state, event, status) {
  const payload = event.payload ?? {};
  const previous = state.tools[event.toolInvocationId] ?? {};
  const tool = payload.tool ?? previous.tool ?? null;
  const toolEntry = {
    ...previous,
    toolInvocationId: event.toolInvocationId,
    tool,
    status
  };
  if (payload.dispatchIndex != null) toolEntry.dispatchIndex = payload.dispatchIndex;
  if (payload.arguments != null) toolEntry.arguments = cloneJson(payload.arguments);
  if (payload.result != null) toolEntry.result = cloneJson(payload.result);
  if (payload.error != null) toolEntry.error = cloneJson(payload.error);
  if (event.causationId != null) toolEntry.causationId = event.causationId;

  const next = {
    ...state,
    tools: { ...state.tools, [event.toolInvocationId]: toolEntry }
  };
  if (status === 'completed' || status === 'failed' || status === 'indeterminate') {
    next.lastToolResult = {
      toolInvocationId: event.toolInvocationId,
      tool,
      status,
      ...(payload.result != null ? { result: cloneJson(payload.result) } : {}),
      ...(payload.error != null ? { error: cloneJson(payload.error) } : {})
    };
  }
  return next;
}

export function reduceSessionEvent(currentState, event = {}) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new TypeError('A typed session event is required.');
  }

  let state = currentState;
  if (event.type === 'session.started') {
    if (state) throw new Error('session.started can only create a new AgentSession.');
    state = createInitialSessionState({
      sessionId: event.sessionId,
      goal: event.payload?.goal,
      mode: event.payload?.mode,
      surface: event.payload?.surface ?? null,
      pendingCriteria: event.payload?.pendingCriteria ?? [],
      versions: event.payload?.versions ?? {}
    });
  } else if (!state) {
    throw new Error('The first AgentSession event must be session.started.');
  }

  if (event.sessionId && event.sessionId !== state.sessionId) {
    throw new Error(`Event session ${event.sessionId} does not match ${state.sessionId}.`);
  }

  const toolStatus = TOOL_STATUS_BY_EVENT[event.type];
  if (toolStatus) {
    state = reduceToolEvent(state, event, toolStatus);
  } else if (event.type === 'tool.approval_recorded') {
    const previous = state.tools[event.toolInvocationId];
    if (!previous || previous.status !== 'proposed') {
      throw new Error(`Tool ${event.toolInvocationId} is not pending approval.`);
    }
    state = {
      ...state,
      tools: {
        ...state.tools,
        [event.toolInvocationId]: {
          ...previous,
          approval: event.payload?.approved === true ? 'approved' : 'denied'
        }
      }
    };
  } else if (event.type === 'user.message') {
    state = {
      ...state,
      messages: [...state.messages, { role: 'user', text: String(event.payload?.text ?? '') }]
    };
  } else if (event.type === 'user.corrected') {
    state = {
      ...state,
      corrections: [...state.corrections, cloneJson(event.payload ?? {})]
    };
  } else if (event.type === 'model.decided') {
    state = { ...state, lastDecision: cloneJson(event.payload?.decision ?? event.payload ?? null) };
  } else if (event.type === 'observation.recorded') {
    state = { ...state, lastObservation: cloneJson(event.payload?.observation ?? event.payload ?? null) };
  } else if (event.type === 'session.hypothesis') {
    state = { ...state, hypothesis: cloneJson(event.payload?.hypothesis ?? null) };
  } else if (event.type === 'session.criteria_updated') {
    state = { ...state, pendingCriteria: cloneJson(event.payload?.pendingCriteria ?? []) };
  } else if (event.type === 'session.plan_updated') {
    state = { ...state, plan: cloneJson(event.payload?.plan ?? []) };
  } else if (event.type === 'session.resumed') {
    state = { ...state, status: 'running', terminalReason: null };
  } else if (TERMINAL_STATUS_BY_EVENT[event.type]) {
    state = {
      ...state,
      status: TERMINAL_STATUS_BY_EVENT[event.type],
      terminalReason: event.payload?.reason == null ? null : String(event.payload.reason)
    };
  }

  const sequence = Number.isSafeInteger(event.sequence) ? event.sequence : state.lastEventSequence + 1;
  return deepFreeze({ ...state, lastEventSequence: sequence });
}
