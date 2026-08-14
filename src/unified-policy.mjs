export function createUnifiedPolicy({ gateProvider, sessionProvider = null } = {}) {
  if (typeof gateProvider !== 'function') throw new TypeError('gateProvider is required.');
  if (sessionProvider != null && typeof sessionProvider !== 'function') throw new TypeError('sessionProvider must be a function.');
  return Object.freeze({
    async authorize({ sessionId, toolInvocationId, manifest, risk, sessionMode = null } = {}) {
      const effectiveRisk = risk || manifest?.risk;
      if (manifest?.readOnly === true || effectiveRisk === 'read_only') return { allowed: true, reason: 'read_only' };
      const gate = gateProvider();
      if (gate?.allowed !== true) return { allowed: false, reason: gate?.reason || 'benchmark_gate_blocked' };
      let mode = sessionMode;
      if (!mode && sessionProvider) mode = (await sessionProvider(sessionId))?.mode || null;
      if (effectiveRisk === 'persistent_local' || effectiveRisk === 'external_or_destructive') {
        return { allowed: false, reason: 'explicit_confirmation_required' };
      }
      if (mode === 'autonomous' && effectiveRisk === 'reversible_local') {
        return { allowed: true, reason: 'gated_autonomous_reversible_action' };
      }
      if (mode === 'programmer' && effectiveRisk === 'reversible_local' && String(manifest?.name || '').startsWith('code.')) {
        return { allowed: true, reason: 'isolated_code_candidate' };
      }
      if (mode === 'guided') {
        const session = sessionProvider ? await sessionProvider(sessionId) : null;
        if (session?.tools?.[toolInvocationId]?.approval === 'approved') {
          return { allowed: true, reason: 'user_confirmed_exact_invocation' };
        }
        return { allowed: false, reason: 'user_confirmation_required' };
      }
      return { allowed: false, reason: 'tool_not_allowed_in_session_mode' };
    }
  });
}
