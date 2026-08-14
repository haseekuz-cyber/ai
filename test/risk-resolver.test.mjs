import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveToolRisk } from '../src/risk-resolver.mjs';

test('model cannot lower manifest risk', () => {
  const manifest = { name: 'code.apply', risk: 'persistent_local' };
  assert.equal(resolveToolRisk(manifest, { modelRisk: 'read_only' }), 'persistent_local');
});

test('ambiguous tool arguments upgrade to stricter risk', () => {
  const manifest = { name: 'ui.click', risk: 'reversible_local', resolveRisk: () => null };
  assert.equal(resolveToolRisk(manifest, { target: null }), 'external_or_destructive');
});

test('deterministic resolver may raise but never lower manifest risk', () => {
  assert.equal(resolveToolRisk({
    name: 'ui.click', risk: 'reversible_local', resolveRisk: () => 'persistent_local'
  }, {}), 'persistent_local');
  assert.equal(resolveToolRisk({
    name: 'code.apply', risk: 'persistent_local', resolveRisk: () => 'read_only'
  }, {}), 'persistent_local');
});

test('unknown risk fails closed', () => {
  assert.equal(resolveToolRisk({ name: 'unknown', risk: 'mystery' }, {}), 'external_or_destructive');
});
