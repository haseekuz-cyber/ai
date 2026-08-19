// Safety pause semantics.
//
// One boolean used to encode two unrelated facts: "the operator stopped execution" and
// "the process is winding down". `shutdownWorkerRuntime` paused execution merely as the
// mechanism to halt in-flight work, and the pause was then persisted as if it had been an
// operator decision — so every clean shutdown poisoned the next boot with HTTP 423 on
// every action route. The source field separates the two facts durably.
//
// Only a deliberate stop is restored. Anything else — a shutdown, an unknown source, or a
// legacy record written before this field existed — starts unpaused, and the discarded
// reason is reported so the decision is visible in the audit log rather than silent.

export const SAFETY_PAUSE_SOURCES = Object.freeze(['user_stop', 'shutdown']);

const RESTORABLE_SOURCES = Object.freeze(['user_stop']);

export function normalizeSafetyPauseSource(value) {
  return SAFETY_PAUSE_SOURCES.includes(value) ? value : null;
}

export function safetyStateToPersist({ paused, reason = null, source = null, updatedAt = null } = {}) {
  const isPaused = paused === true;
  return {
    paused: isPaused,
    source: isPaused ? normalizeSafetyPauseSource(source) : null,
    reason: isPaused && typeof reason === 'string' && reason ? reason : null,
    updatedAt: typeof updatedAt === 'string' && updatedAt ? updatedAt : null
  };
}

export function restoredSafetyPause(stored) {
  const inert = { paused: false, reason: null, source: null, updatedAt: null, discardedReason: null };
  if (!stored || typeof stored !== 'object' || stored.paused !== true) return inert;
  const updatedAt = typeof stored.updatedAt === 'string' && stored.updatedAt ? stored.updatedAt : null;
  const reason = typeof stored.reason === 'string' && stored.reason ? stored.reason : null;
  if (!RESTORABLE_SOURCES.includes(stored.source)) return { ...inert, updatedAt, discardedReason: reason };
  return { paused: true, reason, source: stored.source, updatedAt, discardedReason: null };
}
