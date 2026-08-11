import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWindowTitle, sameWindowContext, sameWindowIdentity, sameWindowGeometry, windowIdentitySummary } from '../src/window-context.mjs';

const base = {
  processId: 42,
  nativeWindowHandle: 100,
  name: 'CorelDRAW 2026 - C:\\Design\\draft.cdr',
  x: 100,
  y: 100,
  width: 800,
  height: 600,
  processName: 'CORELDRW.EXE',
  className: 'CorelDRAW Window Class'
};

const baseWithBounds = {
  processId: 42,
  nativeWindowHandle: 100,
  name: 'CorelDRAW 2026 - C:\\Design\\draft.cdr',
  bounds: { x: 100, y: 100, width: 800, height: 600 },
  processName: 'CORELDRW.EXE',
  className: 'CorelDRAW Window Class'
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

test('sameWindowIdentity separates identity from geometry', () => {
  const moved = { ...base, x: 200, y: 200 };
  const resized = { ...base, width: 1000, height: 800 };
  assert.equal(sameWindowIdentity(moved, base), true, 'move should not change identity');
  assert.equal(sameWindowIdentity(resized, base), true, 'resize should not change identity');
  assert.equal(sameWindowContext(moved, base), true, 'sameWindowContext should tolerate move');
  assert.equal(sameWindowContext(resized, base), true, 'sameWindowContext should tolerate resize');
});

test('sameWindowGeometry detects position and size changes', () => {
  const moved = { ...base, x: 200, y: 200 };
  const resized = { ...base, width: 1000, height: 800 };
  assert.equal(sameWindowGeometry(moved, base), false, 'move should be detected');
  assert.equal(sameWindowGeometry(resized, base), false, 'resize should be detected');
  assert.equal(sameWindowGeometry(base, base), true, 'same bounds should match');
});

test('sameWindowGeometry with tolerance allows small moves', () => {
  const slightMove = { ...base, x: base.x + 5, y: base.y + 5 };
  assert.equal(sameWindowGeometry(slightMove, base, 0), false, 'no tolerance: slight move detected');
  assert.equal(sameWindowGeometry(slightMove, base, 10), true, 'tolerance 10: slight move allowed');
});

test('windowIdentitySummary extracts identity fields', () => {
  const summary = windowIdentitySummary(base);
  assert.equal(summary.processId, 42);
  assert.equal(summary.nativeWindowHandle, 100);
  assert.equal(summary.name, normalizeWindowTitle(base.name));
  assert.equal(summary.processName, 'CORELDRW.EXE');
  assert.equal(summary.className, 'CorelDRAW Window Class');
});

test('windowIdentitySummary handles null input', () => {
  assert.equal(windowIdentitySummary(null), null);
  assert.equal(windowIdentitySummary(undefined), null);
});

test('sameWindowGeometry rejects invalid bounds', () => {
  assert.equal(sameWindowGeometry({ x: 'a', y: 0, width: 100, height: 100 }, base), false);
  assert.equal(sameWindowGeometry(base, { width: NaN, height: 100 }), false);
});

test('sameWindowGeometry works with bounds object (UIA style)', () => {
  const movedBounds = { ...baseWithBounds, bounds: { x: 200, y: 200, width: 800, height: 600 } };
  const resizedBounds = { ...baseWithBounds, bounds: { x: 100, y: 100, width: 1000, height: 800 } };
  assert.equal(sameWindowGeometry(movedBounds, baseWithBounds), false, 'move in bounds object detected');
  assert.equal(sameWindowGeometry(resizedBounds, baseWithBounds), false, 'resize in bounds object detected');
  assert.equal(sameWindowGeometry(baseWithBounds, baseWithBounds), true, 'same bounds object matches');
});

test('sameWindowGeometry with tolerance on bounds object', () => {
  const slightMoveBounds = { ...baseWithBounds, bounds: { x: baseWithBounds.bounds.x + 5, y: baseWithBounds.bounds.y + 5, width: 800, height: 600 } };
  assert.equal(sameWindowGeometry(slightMoveBounds, baseWithBounds, 0), false, 'no tolerance: slight move detected in bounds');
  assert.equal(sameWindowGeometry(slightMoveBounds, baseWithBounds, 10), true, 'tolerance 10: slight move allowed in bounds');
});

test('sameWindowGeometry mixes flat and bounds styles', () => {
  assert.equal(sameWindowGeometry(baseWithBounds, base), true, 'bounds object vs flat with same values');
  assert.equal(sameWindowGeometry(base, baseWithBounds), true, 'flat vs bounds object with same values');
  const movedFlat = { ...base, x: 200, y: 200 };
  assert.equal(sameWindowGeometry(baseWithBounds, movedFlat), false, 'bounds object vs moved flat detected');
});
