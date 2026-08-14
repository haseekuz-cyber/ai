import { randomUUID } from 'node:crypto';

import {
  AGENT_DECISION_SCHEMA,
  UNIFIED_AGENT_SYSTEM_PROMPT,
  normalizeAgentDecision
} from './agent-model-protocol.mjs';

function requireDependency(value, method, name) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`${name} must expose ${method}().`);
}

function abortError(reason) {
  const error = new Error(reason || 'AgentSession was cancelled.');
  error.name = 'AbortError';
  error.code = 'session_cancelled';
  return error;
}

function terminalResult(state) {
  if (state.status === 'cancelled') return { kind: 'cancelled', state };
  if (state.status === 'waiting_for_user') return { kind: 'user_question', state };
  return { kind: 'terminal', status: state.status, state };
}

function modelToolManifest(manifest = {}) {
  return {
    name: manifest.name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    risk: manifest.risk,
    readOnly: manifest.readOnly === true,
    inputSchema: manifest.inputSchema ?? { type: 'object', additionalProperties: false }
  };
}

export class AgentEngine {
  constructor({ sessionStore, contextCompiler, modelClient, toolRegistry, activeModel } = {}) {
    requireDependency(sessionStore, 'start', 'sessionStore');
    requireDependency(sessionStore, 'load', 'sessionStore');
    requireDependency(sessionStore, 'append', 'sessionStore');
    requireDependency(contextCompiler, 'compile', 'contextCompiler');
    if (typeof modelClient !== 'function') throw new TypeError('modelClient must be a function.');
    requireDependency(toolRegistry, 'executeBatch', 'toolRegistry');
    if (typeof activeModel !== 'string' || !activeModel.trim()) throw new TypeError('activeModel is required.');
    this.sessionStore = sessionStore;
    this.contextCompiler = contextCompiler;
    this.modelClient = modelClient;
    this.toolRegistry = toolRegistry;
    this.activeModel = activeModel.trim();
    this.tails = new Map();
    this.activeRequests = new Map();
    this.cancelReasons = new Map();
  }

  async start({ goal, mode = 'guided', surface = null, pendingCriteria = [], versions = {} } = {}) {
    const sessionId = randomUUID();
    const { state } = await this.sessionStore.start({
      sessionId,
      goal,
      mode,
      surface,
      pendingCriteria,
      versions: { ...versions, agentProtocol: 1, activeModel: this.activeModel }
    });
    return state;
  }

  next(sessionId) {
    return this.#serialize(sessionId, () => this.#nextTurn(sessionId));
  }

  async status(sessionId) {
    return (await this.sessionStore.load(sessionId)).state;
  }

  async message(sessionId, text) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('message text is required.');
    const loaded = await this.sessionStore.load(sessionId);
    if (loaded.state.status === 'cancelled' || loaded.state.status === 'completed' || loaded.state.status === 'failed') {
      return terminalResult(loaded.state);
    }
    await this.sessionStore.append(sessionId, { type: 'user.message', payload: { text: text.trim() } });
    if (loaded.state.status === 'waiting_for_user') {
      await this.sessionStore.append(sessionId, { type: 'session.resumed', payload: { reason: 'user_message' } });
    }
    return this.next(sessionId);
  }

  async stop(sessionId, reason = 'user_stop') {
    const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'user_stop';
    this.cancelReasons.set(sessionId, normalizedReason);
    const active = this.activeRequests.get(sessionId);
    if (active && !active.signal.aborted) active.abort(abortError(normalizedReason));
    const loaded = await this.sessionStore.load(sessionId);
    if (loaded.state.status === 'cancelled') return loaded.state;
    if (loaded.state.status === 'completed' || loaded.state.status === 'failed') return loaded.state;
    const { state } = await this.sessionStore.append(sessionId, {
      type: 'session.cancelled',
      payload: { reason: normalizedReason }
    });
    return state;
  }

  #serialize(sessionId, operation) {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(sessionId, current.then(() => undefined, () => undefined));
    return current;
  }

  async #requestModel(context, controller, formatError = null) {
    const options = {
      model: this.activeModel,
      signal: controller.signal,
      systemPrompt: UNIFIED_AGENT_SYSTEM_PROMPT,
      responseSchema: AGENT_DECISION_SCHEMA,
      ...(formatError ? { repair: true, formatError } : {})
    };
    const value = await this.modelClient(context, options);
    controller.signal.throwIfAborted();
    return value;
  }

  async #nextTurn(sessionId) {
    const loaded = await this.sessionStore.load(sessionId);
    if (loaded.state.status !== 'running') return terminalResult(loaded.state);
    if (this.cancelReasons.has(sessionId)) throw abortError(this.cancelReasons.get(sessionId));

    const controller = new AbortController();
    this.activeRequests.set(sessionId, controller);
    if (this.cancelReasons.has(sessionId)) controller.abort(abortError(this.cancelReasons.get(sessionId)));
    const requestId = randomUUID();
    try {
      const context = {
        ...this.contextCompiler.compile(loaded),
        availableTools: this.toolRegistry.manifests().map(modelToolManifest)
      };
      await this.sessionStore.append(sessionId, {
        type: 'model.requested',
        causationId: requestId,
        payload: { requestId, model: this.activeModel, repair: false }
      });

      let decision;
      const rawDecision = await this.#requestModel(context, controller);
      try {
        decision = normalizeAgentDecision(rawDecision);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason ?? error;
        await this.sessionStore.append(sessionId, {
          type: 'model.requested',
          causationId: requestId,
          payload: { requestId, model: this.activeModel, repair: true, formatError: error.message }
        });
        decision = normalizeAgentDecision(await this.#requestModel(context, controller, error.message));
      }

      controller.signal.throwIfAborted();
      const decisionId = randomUUID();
      await this.sessionStore.append(sessionId, {
        type: 'model.decided',
        causationId: requestId,
        payload: { decisionId, decision }
      });

      if (decision.type === 'tool_call') {
        controller.signal.throwIfAborted();
        const toolInvocationId = randomUUID();
        const results = await this.toolRegistry.executeBatch({
          sessionId,
          surface: loaded.state.surface,
          calls: [{
            toolInvocationId,
            causationId: decisionId,
            name: decision.tool,
            arguments: decision.arguments
          }]
        });
        return { kind: 'tool_result', decisionId, decision, results, state: (await this.sessionStore.load(sessionId)).state };
      }

      if (decision.type === 'user_question') {
        const { state } = await this.sessionStore.append(sessionId, {
          type: 'session.waiting_for_user',
          causationId: decisionId,
          payload: { reason: decision.reason, question: decision.question }
        });
        return { kind: 'user_question', decisionId, decision, state };
      }

      const terminalType = decision.status === 'completed' ? 'session.completed' : 'session.failed';
      const { state } = await this.sessionStore.append(sessionId, {
        type: terminalType,
        causationId: decisionId,
        payload: { reason: decision.summary, evidence: decision.evidence }
      });
      return { kind: 'final', decisionId, decision, state };
    } finally {
      if (this.activeRequests.get(sessionId) === controller) this.activeRequests.delete(sessionId);
    }
  }
}
