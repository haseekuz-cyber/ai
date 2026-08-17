import { resolveToolRisk, RISK_CLASSES } from './risk-resolver.mjs';

function normalizeError(error, fallbackCode = 'tool_failed') {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
    message: typeof error?.message === 'string' && error.message ? error.message : String(error ?? 'Tool failed.')
  };
}

function assertSchemaValue(value, schema, path = 'arguments') {
  if (!schema) return;
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    throw new TypeError(`${path} must be one of the declared enum values.`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new TypeError(`${path}.${required} is required.`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) throw new TypeError(`${path}.${key} is not allowed.`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) assertSchemaValue(value[key], child, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    value.forEach((entry, index) => assertSchemaValue(entry, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string' && typeof value !== 'string') {
    throw new TypeError(`${path} must be a string.`);
  } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${path} must be a finite number.`);
  } else if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
    throw new TypeError(`${path} must be a safe integer.`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new TypeError(`${path} must be a boolean.`);
  } else if (schema.type === 'null' && value !== null) {
    throw new TypeError(`${path} must be null.`);
  }
}

function normalizeManifest(manifest = {}) {
  if (typeof manifest.name !== 'string' || !manifest.name) throw new TypeError('Tool manifest name is required.');
  if (!RISK_CLASSES.includes(manifest.risk)) throw new TypeError(`Tool ${manifest.name} has an invalid risk class.`);
  const readOnly = manifest.readOnly === true;
  const idempotency = manifest.idempotency ?? (readOnly ? 'retryable' : 'at_most_once');
  if (!['retryable', 'at_most_once', 'adapter_required'].includes(idempotency)) {
    throw new TypeError(`Tool ${manifest.name} has an invalid idempotency mode.`);
  }
  if (readOnly && manifest.physicalInput === true) throw new TypeError('A read-only tool cannot use physical input.');
  return Object.freeze({ ...manifest, readOnly, idempotency, physicalInput: manifest.physicalInput === true });
}

function cachedToolResult(entry) {
  return {
    toolInvocationId: entry.toolInvocationId,
    tool: entry.tool,
    status: entry.status,
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    cached: true
  };
}

export class ToolRegistry {
  constructor({ ledger, policy, inputArbiter = null } = {}) {
    if (!ledger || typeof ledger.get !== 'function') throw new TypeError('ToolRegistry ledger is required.');
    if (!policy || typeof policy.authorize !== 'function') throw new TypeError('ToolRegistry policy is required.');
    this.ledger = ledger;
    this.policy = policy;
    this.inputArbiter = inputArbiter;
    this.tools = new Map();
  }

  register(manifest, handler) {
    const normalized = normalizeManifest(manifest);
    if (typeof handler !== 'function') throw new TypeError(`Tool ${normalized.name} handler is required.`);
    if (this.tools.has(normalized.name)) throw new Error(`Tool ${normalized.name} is already registered.`);
    this.tools.set(normalized.name, { manifest: normalized, handler });
    return this;
  }

  manifests() {
    return [...this.tools.values()].map(({ manifest }) => manifest);
  }

  manifest(name) {
    return this.tools.get(name)?.manifest ?? null;
  }

  async executeBatch({ sessionId, calls, surface = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required.');
    if (!Array.isArray(calls) || calls.length === 0) throw new TypeError('At least one tool call is required.');
    const seen = new Set();
    const normalizedCalls = calls.map((call, dispatchIndex) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) throw new TypeError(`Tool call ${dispatchIndex} must be an object.`);
      if (typeof call.toolInvocationId !== 'string' || !call.toolInvocationId) throw new TypeError(`Tool call ${dispatchIndex} needs toolInvocationId.`);
      if (seen.has(call.toolInvocationId)) throw new TypeError(`Duplicate toolInvocationId ${call.toolInvocationId}.`);
      seen.add(call.toolInvocationId);
      const args = call.arguments ?? {};
      const normalized = { ...call, arguments: args, dispatchIndex };
      // A model can name a tool that does not exist, or pass arguments its schema forbids.
      // Those are recoverable observations, not engine faults: turn them into a recorded
      // tool.failed result the agent can see and correct on its next turn, never a throw
      // that escapes executeBatch, kills the turn and leaves the failure unrecorded.
      const registered = this.tools.get(call.name);
      if (!registered) return { ...normalized, rejection: { code: 'unknown_tool', message: `Unknown tool: ${call.name}.` } };
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { ...normalized, rejection: { code: 'invalid_arguments', message: `Arguments for ${call.name} must be an object.` } };
      }
      try {
        assertSchemaValue(args, registered.manifest.inputSchema);
      } catch (error) {
        return { ...normalized, rejection: { code: 'invalid_arguments', message: error.message } };
      }
      return { ...normalized, ...registered };
    });

    const results = new Array(normalizedCalls.length);
    for (let index = 0; index < normalizedCalls.length;) {
      const current = normalizedCalls[index];
      if (current.rejection) {
        results[index] = await this.#rejectCall(sessionId, current);
        index += 1;
      } else if (current.manifest.readOnly) {
        let end = index + 1;
        while (end < normalizedCalls.length && !normalizedCalls[end].rejection && normalizedCalls[end].manifest.readOnly) end += 1;
        const groupResults = await this.#executeReadOnlyGroup(sessionId, normalizedCalls.slice(index, end), surface);
        groupResults.forEach((result, offset) => { results[index + offset] = result; });
        index = end;
      } else {
        results[index] = await this.#executeSequential(sessionId, current, surface);
        index += 1;
      }
    }
    return results;
  }

  async #rejectCall(sessionId, call) {
    const existing = await this.ledger.get(sessionId, call.toolInvocationId);
    if (existing?.status === 'completed' || existing?.status === 'failed' || existing?.status === 'indeterminate') {
      return cachedToolResult(existing);
    }
    const error = call.rejection;
    await this.ledger.requested(sessionId, {
      toolInvocationId: call.toolInvocationId,
      tool: call.name,
      dispatchIndex: call.dispatchIndex,
      arguments: call.arguments,
      causationId: call.causationId
    });
    await this.ledger.failed(sessionId, {
      toolInvocationId: call.toolInvocationId,
      tool: call.name,
      dispatchIndex: call.dispatchIndex,
      error,
      causationId: call.causationId
    });
    return { toolInvocationId: call.toolInvocationId, tool: call.name, status: 'failed', error };
  }

  async #prepare(sessionId, call, surface) {
    const existing = await this.ledger.get(sessionId, call.toolInvocationId);
    if (existing?.status === 'completed' || existing?.status === 'failed' || existing?.status === 'indeterminate') {
      return { immediate: cachedToolResult(existing) };
    }
    if (existing?.status === 'dispatched' && call.manifest.idempotency !== 'retryable') {
      const error = { code: 'indeterminate_after_dispatch', message: 'The prior effect may already have happened and will not be repeated.' };
      await this.ledger.indeterminate(sessionId, {
        toolInvocationId: call.toolInvocationId,
        tool: call.name,
        dispatchIndex: call.dispatchIndex,
        error,
        causationId: call.causationId
      });
      return {
        immediate: {
          toolInvocationId: call.toolInvocationId,
          tool: call.name,
          status: 'indeterminate',
          error
        }
      };
    }
    if (!existing) {
      await this.ledger.requested(sessionId, {
        toolInvocationId: call.toolInvocationId,
        tool: call.name,
        dispatchIndex: call.dispatchIndex,
        arguments: call.arguments,
        causationId: call.causationId
      });
    }

    const risk = resolveToolRisk(call.manifest, call.arguments);
    const authorization = await this.policy.authorize({
      sessionId,
      toolInvocationId: call.toolInvocationId,
      manifest: call.manifest,
      arguments: call.arguments,
      risk,
      surface
    });
    const allowed = authorization?.allowed === true || authorization?.allowExecution === true;
    if (!allowed) {
      const error = { code: 'policy_denied', message: authorization?.reason || 'Tool execution was denied by policy.' };
      await this.ledger.failed(sessionId, {
        toolInvocationId: call.toolInvocationId,
        tool: call.name,
        dispatchIndex: call.dispatchIndex,
        error,
        causationId: call.causationId
      });
      return { immediate: { toolInvocationId: call.toolInvocationId, tool: call.name, status: 'failed', error } };
    }

    await this.ledger.dispatched(sessionId, {
      toolInvocationId: call.toolInvocationId,
      tool: call.name,
      dispatchIndex: call.dispatchIndex,
      causationId: call.causationId
    });

    let inputLease = null;
    if (call.manifest.physicalInput && surface?.mode === 'shared') {
      if (!this.inputArbiter) {
        const error = { code: 'input_lease_unavailable', message: 'Shared physical input requires InputArbiter.' };
        return { call, risk, error };
      }
      inputLease = await this.inputArbiter.acquire(surface);
      const consumed = await this.inputArbiter.consume(inputLease, surface);
      if (!consumed.valid) {
        const error = { code: 'input_lease_invalid', message: consumed.reason };
        return { call, risk, inputLease, error };
      }
    }
    return { call, risk, inputLease };
  }

  async #invoke(prepared, sessionId, surface) {
    if (prepared.error) return { error: prepared.error };
    try {
      const result = await prepared.call.handler(prepared.call.arguments, {
        sessionId,
        toolInvocationId: prepared.call.toolInvocationId,
        dispatchIndex: prepared.call.dispatchIndex,
        surface,
        risk: prepared.risk,
        inputLease: prepared.inputLease
      });
      return { result };
    } catch (error) {
      return { error: normalizeError(error) };
    }
  }

  async #commit(sessionId, prepared, outcome) {
    if (prepared.immediate) return prepared.immediate;
    const call = prepared.call;
    if (outcome.error) {
      await this.ledger.failed(sessionId, {
        toolInvocationId: call.toolInvocationId,
        tool: call.name,
        dispatchIndex: call.dispatchIndex,
        error: outcome.error,
        causationId: call.causationId
      });
      return { toolInvocationId: call.toolInvocationId, tool: call.name, status: 'failed', error: outcome.error };
    }
    await this.ledger.completed(sessionId, {
      toolInvocationId: call.toolInvocationId,
      tool: call.name,
      dispatchIndex: call.dispatchIndex,
      result: outcome.result,
      causationId: call.causationId
    });
    return { toolInvocationId: call.toolInvocationId, tool: call.name, status: 'completed', result: outcome.result };
  }

  async #executeReadOnlyGroup(sessionId, calls, surface) {
    const prepared = [];
    for (const call of calls) prepared.push(await this.#prepare(sessionId, call, surface));
    const outcomes = await Promise.all(prepared.map((entry) => entry.immediate ? null : this.#invoke(entry, sessionId, surface)));
    const results = [];
    for (let index = 0; index < prepared.length; index += 1) {
      results.push(await this.#commit(sessionId, prepared[index], outcomes[index]));
    }
    return results;
  }

  async #executeSequential(sessionId, call, surface) {
    const prepared = await this.#prepare(sessionId, call, surface);
    if (prepared.immediate) return prepared.immediate;
    return this.#commit(sessionId, prepared, await this.#invoke(prepared, sessionId, surface));
  }
}
