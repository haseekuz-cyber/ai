export class ModelBroker {
  constructor({ enabled = true, roles = {}, idleTtlMs = 120_000, initialModel = null, onSwitch = null } = {}) {
    this.enabled = enabled;
    this.roles = { ...roles };
    this.idleTtlMs = idleTtlMs;
    this.onSwitch = onSwitch;
    this.activeModel = initialModel;
    this.activeRequests = 0;
    this.pendingRequests = 0;
    this.lastUsedAt = null;
    this.switches = 0;
    this.completed = 0;
    this.failures = 0;
    this.tail = Promise.resolve();
  }

  modelForRole(role, fallback = null) {
    return this.roles[role] || fallback;
  }

  async runModel(model, task, { role = 'unspecified' } = {}) {
    if (typeof task !== 'function') throw new TypeError('ModelBroker task must be a function.');
    if (!this.enabled) return task();
    this.pendingRequests += 1;
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    this.pendingRequests -= 1;
    try {
      if (model && model !== this.activeModel) {
        const previousModel = this.activeModel;
        if (this.onSwitch) await this.onSwitch({ previousModel, model, role });
        this.activeModel = model;
        this.switches += 1;
      }
      this.activeRequests += 1;
      const result = await task();
      this.completed += 1;
      return result;
    } catch (error) {
      this.failures += 1;
      throw error;
    } finally {
      this.activeRequests -= 1;
      this.lastUsedAt = new Date().toISOString();
      release();
    }
  }

  status() {
    return {
      enabled: this.enabled,
      activeModel: this.activeModel,
      activeRequests: this.activeRequests,
      pendingRequests: this.pendingRequests,
      lastUsedAt: this.lastUsedAt,
      idleTtlMs: this.idleTtlMs,
      switches: this.switches,
      completed: this.completed,
      failures: this.failures,
      roles: { ...this.roles }
    };
  }
}
