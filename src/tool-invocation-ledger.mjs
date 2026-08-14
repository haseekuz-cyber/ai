export class ToolInvocationLedger {
  constructor({ eventStore } = {}) {
    if (!eventStore || typeof eventStore.load !== 'function' || typeof eventStore.append !== 'function') {
      throw new TypeError('ToolInvocationLedger requires an AgentSession event store.');
    }
    this.eventStore = eventStore;
  }

  async get(sessionId, toolInvocationId) {
    const { state } = await this.eventStore.load(sessionId);
    return state.tools?.[toolInvocationId] ?? null;
  }

  requested(sessionId, value) {
    return this.#record(sessionId, 'tool.requested', value);
  }

  dispatched(sessionId, value) {
    return this.#record(sessionId, 'tool.dispatched', value);
  }

  completed(sessionId, value) {
    return this.#record(sessionId, 'tool.completed', value);
  }

  failed(sessionId, value) {
    return this.#record(sessionId, 'tool.failed', value);
  }

  indeterminate(sessionId, value) {
    return this.#record(sessionId, 'tool.indeterminate', value);
  }

  #record(sessionId, type, { toolInvocationId, tool, dispatchIndex, arguments: args, result, error, causationId } = {}) {
    const payload = {
      tool,
      dispatchIndex,
      ...(args !== undefined ? { arguments: args } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {})
    };
    return this.eventStore.append(sessionId, {
      type,
      toolInvocationId,
      ...(causationId ? { causationId } : {}),
      payload
    });
  }
}
