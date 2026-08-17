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

test('printable keyboard-hook text is combined into one reusable canvas text step', () => {
  const skill = buildSkillFromRecording({
    skillId: 'keyboard-canvas',
    name: 'Canvas typing',
    instruction: 'Type on the canvas',
    window: {
      name: 'Untitled', processName: 'Editor', className: 'Canvas',
      bounds: { x: 0, y: 0, width: 1000, height: 800 }
    },
    recording: { events: [
      { type: 'click', atMs: 1, x: 300, y: 250, button: 'left' },
      { type: 'typeText', source: 'keyboard-hook', atMs: 10, x: 300, y: 250, automationId: 'canvas', name: 'Canvas', controlType: 'Pane', text: 'П' },
      { type: 'typeText', source: 'keyboard-hook', atMs: 20, x: 300, y: 250, automationId: 'canvas', name: 'Canvas', controlType: 'Pane', text: 'р' }
    ] },
    elements: []
  });
  assert.equal(skill.steps.length, 2);
  assert.equal(skill.steps[1].type, 'typeText');
  assert.equal(skill.steps[1].text, 'Пр');
  assert.deepEqual(skill.steps[1].point, { x: 0.3, y: 0.3125 });
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

test('a demonstrated drag retains its non-linear path as adaptive evidence', () => {
  const skill = buildSkillFromRecording({
    skillId: 'skill-path', name: 'Кривая', instruction: 'Нарисуйте кривую',
    window: {
      name: 'Test', processName: 'TestApp', className: 'TestWindow',
      bounds: { x: 0, y: 0, width: 1000, height: 1000 }
    },
    recording: { events: [
      { type: 'pointerMove', atMs: 110, x: 200, y: 350 },
      { type: 'pointerMove', atMs: 180, x: 350, y: 200 },
      { type: 'drag', atMs: 100, x: 100, y: 100, toX: 500, toY: 500, durationMs: 200, controlType: 'Pane' }
    ] },
    elements: []
  });
  assert.equal(skill.steps[0].trajectoryMode, 'adaptive');
  assert.match(skill.steps[0].expectedResult, /visibl/i);
  assert.deepEqual(skill.steps[0].trajectory, [
    { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.35 }, { x: 0.35, y: 0.2 }, { x: 0.5, y: 0.5 }
  ]);
});

test('logical demonstration steps keep their own before and after visual evidence', () => {
  const skill = buildSkillFromRecording({
    skillId: 'skill-frames', name: 'Two steps', instruction: 'Perform two visible actions',
    window: {
      name: 'Test', processName: 'TestApp', className: 'TestWindow',
      bounds: { x: 0, y: 0, width: 1000, height: 800 }
    },
    recording: {
      initialVisualFrame: { imagePath: 'before.png', sha256: 'BEFORE', atMs: 0, throughSequence: 0 },
      finalVisualFrame: { imagePath: 'final.png', sha256: 'FINAL', atMs: 500, throughSequence: 2 },
      visualFrames: [
        { imagePath: 'step-1.png', atMs: 150, throughSequence: 1 },
        { imagePath: 'step-2.png', atMs: 300, throughSequence: 2 }
      ],
      events: [
        { type: 'click', sequence: 1, atMs: 100, x: 100, y: 100, button: 'left' },
        { type: 'pressKey', sequence: 2, atMs: 250, key: 'Enter' }
      ]
    },
    elements: []
  });
  assert.deepEqual(skill.steps[0].visualEvidence, {
    schemaVersion: 1,
    beforeImagePath: 'before.png',
    afterImagePath: 'step-1.png',
    beforeSha256: 'BEFORE',
    afterSha256: null,
    capturedAtMs: 150,
    source: 'live-demonstration'
  });
  assert.equal(skill.steps[1].visualEvidence.beforeImagePath, 'step-1.png');
  assert.equal(skill.steps[1].visualEvidence.afterImagePath, 'step-2.png');
});

test('desktop observation keeps per-window coordinates and explicit guidance', () => {
  const skill = buildSkillFromRecording({
    skillId: 'desktop-skill', name: 'Desktop teaching', instruction: 'Observe the teacher',
    window: {
      name: 'Fallback', processName: 'browser', className: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }
    },
    recording: {
      captureScope: 'desktop',
      captureBounds: { x: 0, y: 0, width: 3840, height: 1080 },
      primaryApplication: {
        processName: 'CorelDRW', windowName: 'CorelDRAW - Безымянный-1',
        windowBounds: { x: 1920, y: 0, width: 1920, height: 1080 }
      },
      observedApplications: [{ processName: 'CorelDRW', windowName: 'CorelDRAW - Безымянный-1', count: 1 }],
      guidance: [{ text: 'Сначала создайте документ, затем подтвердите диалог.' }],
      events: [{
        type: 'click', sequence: 1, atMs: 100, x: 2112, y: 216, button: 'left',
        processName: 'CorelDRW', windowName: 'CorelDRAW - Безымянный-1', windowHandle: 55,
        windowBounds: { x: 1920, y: 0, width: 1920, height: 1080 }
      }]
    },
    elements: []
  });
  assert.equal(skill.application.processName, 'CorelDRW');
  assert.equal(skill.demonstration.captureScope, 'desktop');
  assert.match(skill.demonstration.guidance[0].text, /создайте документ/i);
  assert.deepEqual(skill.steps[0].point, { x: 0.1, y: 0.2 });
  assert.equal(skill.steps[0].windowContext.processName, 'CorelDRW');
});
