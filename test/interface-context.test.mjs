import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInterfaceContext } from '../src/interface-context.mjs';

test('interface context exposes semantic controls with normalized centers', () => {
  const context = buildInterfaceContext([{
    name: 'Сохранить', automationId: 'save', controlType: 'Button', capabilities: ['invoke'],
    bounds: { x: 120, y: 140, width: 40, height: 20, empty: false }, enabled: true, offscreen: false
  }], { x: 100, y: 100, width: 200, height: 100 });
  assert.match(context, /Сохранить/);
  assert.match(context, /"x":0\.2/);
  assert.match(context, /automationId/);
});

test('password controls are excluded from model context', () => {
  const context = buildInterfaceContext([{
    name: 'Пароль', automationId: 'password', controlType: 'Edit', capabilities: ['value'], isPassword: true,
    bounds: { x: 0, y: 0, width: 100, height: 20, empty: false }
  }], { x: 0, y: 0, width: 200, height: 100 });
  assert.equal(context, '');
});
