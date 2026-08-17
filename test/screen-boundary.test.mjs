import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectBounds, resolveCaptureTarget } from '../src/screen-boundary.mjs';

test('the only secondary display becomes the default AI monitor', () => {
  const target = resolveCaptureTarget({
    hardware: {
      screens: [
        { deviceName: '\\\\.\\DISPLAY1', primary: false, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
        { deviceName: '\\\\.\\DISPLAY2', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
      ]
    }
  });
  assert.equal(target.deviceName, '\\\\.\\DISPLAY1');
  assert.equal(target.bounds.x, 1920);
});

test('multiple secondary displays still require an explicit assignment', () => {
  assert.throws(() => resolveCaptureTarget({
    hardware: {
      screens: [
        { deviceName: 'primary', primary: true },
        { deviceName: 'secondary-a', primary: false },
        { deviceName: 'secondary-b', primary: false }
      ]
    }
  }), /multiple secondary displays/);
});

test('vision can cover the whole display while execution is clipped to the visible application surface', () => {
  assert.deepEqual(
    intersectBounds(
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 1912, y: -8, width: 1936, height: 1096 }
    ),
    { x: 1920, y: 0, width: 1920, height: 1080 }
  );
  assert.deepEqual(
    intersectBounds(
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 2300, y: 100, width: 900, height: 700 }
    ),
    { x: 2300, y: 100, width: 900, height: 700 }
  );
});

test('execution refuses a surface that is outside the assigned display', () => {
  assert.throws(() => intersectBounds(
    { x: 1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1000, height: 800 }
  ), /outside the assigned AI display/);
});
