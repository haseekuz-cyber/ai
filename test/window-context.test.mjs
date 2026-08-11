import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWindowTitle, sameWindowContext } from '../src/window-context.mjs';

const base = {
  processId: 42,
  nativeWindowHandle: 100,
  name: 'CorelDRAW 2026 - C:\\Design\\draft.cdr'
};

test('trailing modified marker does not change document identity', () => {
  assert.equal(normalizeWindowTitle(`${base.name}*`), normalizeWindowTitle(base.name));
  assert.equal(sameWindowContext({ ...base, name: `${base.name}*` }, base), true);
});

test('switching the active document makes a plan stale', () => {
  assert.equal(sameWindowContext({
    ...base,
    name: 'CorelDRAW 2026 - C:\\Design\\another.cdr'
  }, base), false);
});

test('process or native handle changes make a plan stale', () => {
  assert.equal(sameWindowContext({ ...base, processId: 43 }, base), false);
  assert.equal(sameWindowContext({ ...base, nativeWindowHandle: 101 }, base), false);
});
