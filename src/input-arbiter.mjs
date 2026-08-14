import { randomUUID } from 'node:crypto';

function normalizeSurface(surface) {
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
    throw new TypeError('Execution surface is required.');
  }
  if (typeof surface.id !== 'string' || !surface.id) throw new TypeError('Execution surface id is required.');
  if (!['shared', 'isolated'].includes(surface.mode)) throw new TypeError('Execution surface mode must be shared or isolated.');
  return { id: surface.id, mode: surface.mode };
}

function invalid(reason) {
  return { valid: false, reason };
}

export class InputArbiter {
  constructor({ activityProvider, now = Date.now, ttlMs = 250 } = {}) {
    if (typeof activityProvider !== 'function') throw new TypeError('activityProvider is required.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 250) {
      throw new TypeError('ttlMs must be between 1 and 250 milliseconds.');
    }
    this.activityProvider = activityProvider;
    this.now = now;
    this.ttlMs = ttlMs;
    this.leases = new Map();
  }

  async acquire(surface) {
    const normalizedSurface = normalizeSurface(surface);
    const activity = await this.activityProvider();
    if (activity?.sequence == null) throw new TypeError('User activity snapshot sequence is required.');
    const issuedAtMs = this.now();
    const lease = Object.freeze({
      leaseId: randomUUID(),
      surfaceId: normalizedSurface.id,
      userActivitySequence: activity.sequence,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
      ...(Number.isSafeInteger(activity.lastInputTick) ? { lastInputTick: activity.lastInputTick } : {}),
      ...(activity.cursor ? { cursor: { x: Number(activity.cursor.x), y: Number(activity.cursor.y) } } : {}),
      ...(Number.isSafeInteger(activity.focusedWindowHandle)
        ? { focusedWindowHandle: activity.focusedWindowHandle }
        : {})
    });
    this.leases.set(lease.leaseId, { lease, consumed: false });
    return lease;
  }

  #basicValidation(lease, surface) {
    let normalizedSurface;
    try {
      normalizedSurface = normalizeSurface(surface);
    } catch {
      return invalid('invalid_surface');
    }
    const entry = lease?.leaseId ? this.leases.get(lease.leaseId) : null;
    if (!entry) return invalid('unknown_lease');
    if (entry.lease !== lease) return invalid('lease_mismatch');
    if (entry.consumed) return invalid('consumed');
    if (lease.surfaceId !== normalizedSurface.id) return invalid('wrong_surface');
    if (this.now() > lease.expiresAtMs) return invalid('expired');
    return { valid: true, entry };
  }

  async validate(lease, surface) {
    const basic = this.#basicValidation(lease, surface);
    if (!basic.valid) return basic;
    const activity = await this.activityProvider();
    if (activity?.sequence !== lease.userActivitySequence) return invalid('user_activity_changed');
    return { valid: true };
  }

  async consume(lease, surface) {
    const basic = this.#basicValidation(lease, surface);
    if (!basic.valid) return basic;
    basic.entry.consumed = true;
    const activity = await this.activityProvider();
    if (activity?.sequence !== lease.userActivitySequence) return invalid('user_activity_changed');
    return { valid: true };
  }
}
