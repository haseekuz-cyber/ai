import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWindowChange,
  normalizeWindowTitle,
  sameWindowContext,
  sameWindowGeometry,
  sameWindowIdentity
} from '../src/window-context.mjs';

const base = {
  processId: 42,
  nativeWindowHandle: 100,
  name: 'CorelDRAW - Безымянный-1',
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 }
};

test('window identity tolerates only the modified-document marker', () => {
  assert.equal(normalizeWindowTitle(`${base.name}*`), normalizeWindowTitle(base.name));
  assert.equal(sameWindowIdentity({ ...base, name: `${base.name}*` }, base), true);
  assert.equal(sameWindowContext({ ...base, name: `${base.name}*` }, base), true);
  assert.equal(sameWindowIdentity({ ...base, name: 'CorelDRAW - Другой.cdr' }, base), false);
  assert.equal(sameWindowIdentity({ ...base, processId: 43 }, base), false);
  assert.equal(sameWindowIdentity({ ...base, nativeWindowHandle: 101 }, base), false);
});

test('window geometry detects movement and resizing independently of identity', () => {
  const moved = { ...base, bounds: { ...base.bounds, x: 1912 } };
  const resized = { ...base, bounds: { ...base.bounds, width: 1936 } };
  assert.equal(sameWindowIdentity(moved, base), true);
  assert.equal(sameWindowGeometry(moved, base), false);
  assert.equal(sameWindowGeometry(resized, base), false);
  assert.equal(sameWindowGeometry(base, base), true);
});

test('classifyWindowChange distinguishes a safe replan from a stale target', () => {
  assert.equal(classifyWindowChange(base, base), 'same');
  assert.equal(classifyWindowChange({ ...base, bounds: { ...base.bounds, y: 8 } }, base), 'geometry_changed');
  assert.equal(classifyWindowChange({ ...base, name: 'CorelDRAW - Другой.cdr' }, base), 'identity_changed');
});
