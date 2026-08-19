import assert from 'node:assert/strict';
import test from 'node:test';

import { createUnifiedPolicy } from '../src/unified-policy.mjs';

const manifest = (name, risk, readOnly = false) => ({ name, risk, readOnly });

test('read-only tools do not depend on the rollout mutation gate', async () => {
  const policy = createUnifiedPolicy({ gateProvider: () => ({ allowed: false, reason: 'benchmark_failed' }) });
  assert.equal((await policy.authorize({ manifest: manifest('repo.read', 'read_only', true), sessionMode: 'chat' })).allowed, true);
});

test('guided UI mutation remains two-phase even after a model benchmark passes', async () => {
  const policy = createUnifiedPolicy({ gateProvider: () => ({ allowed: true, reason: 'benchmark_passed' }) });
  const result = await policy.authorize({ manifest: manifest('ui.uia', 'reversible_local'), sessionMode: 'guided' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'user_confirmation_required');
});

test('guided UI mutation is allowed only for the exact durably approved invocation', async () => {
  const policy = createUnifiedPolicy({
    gateProvider: () => ({ allowed: true, reason: 'benchmark_passed' }),
    sessionProvider: async () => ({
      mode: 'guided',
      tools: { approved: { approval: 'approved' }, denied: { approval: 'denied' } }
    })
  });
  assert.equal((await policy.authorize({
    sessionId: 's', toolInvocationId: 'approved', manifest: manifest('ui.uia', 'reversible_local')
  })).allowed, true);
  assert.equal((await policy.authorize({
    sessionId: 's', toolInvocationId: 'denied', manifest: manifest('ui.uia', 'reversible_local')
  })).reason, 'user_confirmation_required');
});

test('autonomous mode can use only gated reversible local tools', async () => {
  const passing = createUnifiedPolicy({ gateProvider: () => ({ allowed: true, reason: 'benchmark_passed' }) });
  assert.equal((await passing.authorize({ manifest: manifest('ui.uia', 'reversible_local'), sessionMode: 'autonomous' })).allowed, true);
  assert.equal((await passing.authorize({ manifest: manifest('code.apply', 'persistent_local'), sessionMode: 'autonomous' })).allowed, false);
  const blocked = createUnifiedPolicy({ gateProvider: () => ({ allowed: false, reason: 'benchmark_failed' }) });
  assert.equal((await blocked.authorize({ manifest: manifest('ui.uia', 'reversible_local'), sessionMode: 'autonomous' })).reason, 'benchmark_failed');
});

test('programmer can modify only an isolated candidate and never apply it', async () => {
  const policy = createUnifiedPolicy({ gateProvider: () => ({ allowed: true, reason: 'benchmark_passed' }) });
  assert.equal((await policy.authorize({ manifest: manifest('code.patch', 'reversible_local'), sessionMode: 'programmer' })).allowed, true);
  assert.equal((await policy.authorize({ manifest: manifest('ui.uia', 'reversible_local'), sessionMode: 'programmer' })).allowed, false);
  assert.equal((await policy.authorize({ manifest: manifest('code.apply', 'persistent_local'), sessionMode: 'programmer' })).allowed, false);
});

test('an exact user confirmation authorizes a reversible action even while the rollout gate is closed', async () => {
  const policy = createUnifiedPolicy({
    gateProvider: () => ({ allowed: false, reason: 'mutations_not_requested' }),
    sessionProvider: async () => ({ mode: 'guided', tools: { approved: { approval: 'approved' } } })
  });
  const result = await policy.authorize({
    sessionId: 's', toolInvocationId: 'approved', manifest: manifest('ui.uia', 'reversible_local')
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'user_confirmed_exact_invocation');
});

test('a closed rollout gate still blocks autonomous mutations and unconfirmed guided ones', async () => {
  const policy = createUnifiedPolicy({
    gateProvider: () => ({ allowed: false, reason: 'mutations_not_requested' }),
    sessionProvider: async () => ({ mode: 'guided', tools: {} })
  });
  assert.equal((await policy.authorize({
    manifest: manifest('ui.uia', 'reversible_local'), sessionMode: 'autonomous'
  })).reason, 'mutations_not_requested');
  assert.equal((await policy.authorize({
    sessionId: 's', toolInvocationId: 'unknown', manifest: manifest('ui.uia', 'reversible_local')
  })).reason, 'user_confirmation_required');
});
