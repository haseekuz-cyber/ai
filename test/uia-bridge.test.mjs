import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUiAutomationTimeoutMs } from '../src/uia-bridge.mjs';

test('slow read-only UI Automation operations receive a cold-start allowance', () => {
  assert.equal(resolveUiAutomationTimeoutMs({ operation: 'listWindows' }), 30_000);
  assert.equal(resolveUiAutomationTimeoutMs({ operation: 'inspect' }), 30_000);
});

test('UI actions keep the short default timeout', () => {
  assert.equal(resolveUiAutomationTimeoutMs({ operation: 'action' }), 10_000);
});

test('an explicit UI Automation timeout overrides the operation default', () => {
  assert.equal(resolveUiAutomationTimeoutMs({ operation: 'listWindows' }, 12_345), 12_345);
});
