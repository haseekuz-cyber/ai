import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSkillFromRecording, summarizeDemonstration } from '../src/teaching.mjs';

test('demonstration summary keeps trajectory and safe keyboard evidence', () => {
  const summary = summarizeDemonstration({ events: [
    { type: 'pointerMove', atMs: 10, x: 110, y: 120 },
    { type: 'click', atMs: 20, x: 150, y: 160, button: 'left' },
    { type: 'keyPreview', atMs: 30, key: 'A', sensitive: false },
    { type: 'keyPreview', atMs: 40, key: 'B', sensitive: true }
  ] }, { x: 100, y: 100, width: 200, height: 200 });
  assert.deepEqual(summary.trajectory[0].point, { x: 0.05, y: 0.1 });
  assert.deepEqual(summary.keyboard.map((item) => item.key), ['A']);
  assert.match(summary.interpretationRule, /Adapt/);
});

test('preview-only mouse and keyboard events do not fragment logical text steps', () => {
  const skill = buildSkillFromRecording({
    skillId: 'skill-1',
    name: 'Введите текст',
    instruction: 'Введите AB',
    window: {
      name: 'Test', processName: 'TestApp', className: 'TestWindow',
      bounds: { x: 100, y: 100, width: 800, height: 600 }
    },
    recording: { events: [
      { type: 'pointerMove', atMs: 5, x: 130, y: 140 },
      { type: 'typeText', atMs: 10, x: 150, y: 160, automationId: 'field', name: 'Поле', text: 'A' },
      { type: 'keyPreview', atMs: 11, key: 'B' },
      { type: 'pointerMove', atMs: 12, x: 151, y: 160 },
      { type: 'typeText', atMs: 13, x: 150, y: 160, automationId: 'field', name: 'Поле', text: 'AB' }
    ] },
    elements: []
  });
  assert.equal(skill.steps.length, 1);
  assert.equal(skill.steps[0].type, 'typeText');
  assert.equal(skill.steps[0].text, 'AB');
  assert.ok(skill.demonstration.trajectory.length > 0);
  assert.deepEqual(skill.demonstration.keyboard.map((item) => item.key), ['B']);
});

test('passive application value changes are not learned as user typing', () => {
  const skill = buildSkillFromRecording({
    skillId: 'skill-2', name: 'Перетащить', instruction: 'Перетащите объект',
    window: {
      name: 'Test', processName: 'TestApp', className: 'TestWindow',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    },
    recording: { events: [
      { type: 'drag', atMs: 10, x: 100, y: 100, toX: 300, toY: 300 },
      { type: 'typeText', atMs: 20, x: 50, y: 20, automationId: 'x-position', name: '12 cm', text: '12 cm', source: 'uia-event' },
      { type: 'typeText', atMs: 25, x: 80, y: 20, automationId: 'y-position', name: '14 cm', text: '14 cm', source: 'uia-event' }
    ] },
    elements: []
  });
  assert.deepEqual(skill.steps.map((step) => step.type), ['drag']);
});
