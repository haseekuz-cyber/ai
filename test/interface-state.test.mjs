import test from 'node:test';
import assert from 'node:assert/strict';
import { publicInterfaceState, updateInterfaceState } from '../src/interface-state.mjs';

function inspected(elements) {
  return {
    window: { nativeWindowHandle: 7, processId: 8, processName: 'Test', name: 'Document', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    elements
  };
}

test('interface state tracks appearance, movement, value changes and disappearance', () => {
  const first = updateInterfaceState(null, inspected([
    { runtimeId: 'a', name: 'Width', controlType: 'Edit', value: '10', bounds: { x: 10, y: 10, width: 80, height: 20 } },
    { runtimeId: 'b', name: 'Apply', controlType: 'Button', bounds: { x: 100, y: 10, width: 50, height: 20 } }
  ]), { now: 0 });
  const second = updateInterfaceState(first, inspected([
    { runtimeId: 'a', name: 'Width', controlType: 'Edit', value: '40', bounds: { x: 20, y: 10, width: 80, height: 20 } },
    { runtimeId: 'c', name: 'Cancel', controlType: 'Button', bounds: { x: 160, y: 10, width: 50, height: 20 } }
  ]), { now: 1_000 });
  assert.equal(second.version, 2);
  assert.deepEqual(second.changes.added.map((item) => item.name), ['Cancel']);
  assert.deepEqual(second.changes.removed.map((item) => item.name), ['Apply']);
  assert.deepEqual(second.changes.moved.map((item) => item.name), ['Width']);
  assert.deepEqual(second.changes.changed[0].properties, ['value']);
  assert.equal(publicInterfaceState(second).elementCount, 2);
});

test('password values never enter the interface state map', () => {
  const state = updateInterfaceState(null, inspected([
    { runtimeId: 'secret', name: 'Password', controlType: 'Edit', isPassword: true, value: 'hidden' }
  ]));
  assert.equal(state.elements.size, 0);
});
