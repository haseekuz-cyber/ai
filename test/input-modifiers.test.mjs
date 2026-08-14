import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerOutput, toScreenPointerAction } from '../src/agent-planner.mjs';
import { normalizeInputModifiers } from '../src/input-modifiers.mjs';
import { createBoundedPointerRequest, fitPointerActionToAllowedBounds, normalizePointerAction } from '../src/pointer-bridge.mjs';
import { learnedStepToPointerAction } from '../src/skill-runner.mjs';
import { buildSkillFromRecording } from '../src/teaching.mjs';

test('modifiers are strict, deduplicated, and ordered consistently', () => {
  assert.deepEqual(normalizeInputModifiers(['Alt', 'Control', 'Alt', 'Shift']), ['Control', 'Shift', 'Alt']);
  assert.throws(() => normalizeInputModifiers('Control'), /must be an array/);
  assert.throws(() => normalizeInputModifiers(['Meta']), /only Control, Shift, and Alt/);
});

test('pointer requests preserve an explicitly required drag modifier', () => {
  const action = normalizePointerAction({
    windowHandle: 10,
    action: 'drag',
    from: { x: 20, y: 30 },
    to: { x: 120, y: 130 },
    modifiers: ['Control'],
    confirmed: true
  });
  assert.deepEqual(action.modifiers, ['Control']);
  const bounded = createBoundedPointerRequest({
    action,
    allowedBounds: { x: 0, y: 0, width: 500, height: 500 },
    forbiddenProcessNames: []
  });
  assert.deepEqual(bounded.modifiers, ['Control']);
  assert.throws(() => normalizePointerAction({ ...action, modifiers: ['Meta'] }), /only Control, Shift, and Alt/);
});

test('display boundary fitting corrects only the invisible maximized-window frame', () => {
  const allowedBounds = { x: 1920, y: 0, width: 1920, height: 1080 };
  const fitted = fitPointerActionToAllowedBounds({
    windowHandle: 10,
    action: 'drag',
    confirmed: true,
    from: { x: 1912, y: -8 },
    to: { x: 2783, y: 485 },
    durationMs: 350,
    trajectory: [{ x: 1916, y: -2 }, { x: 2200, y: 200 }]
  }, allowedBounds);
  assert.equal(fitted.boundaryAdjusted, true);
  assert.deepEqual(fitted.action.from, { x: 1920, y: 0 });
  assert.deepEqual(fitted.action.to, { x: 2783, y: 485 });
  assert.deepEqual(fitted.action.trajectory[0], { x: 1920, y: 0 });
});

test('display boundary fitting still rejects a genuinely off-display point', () => {
  assert.throws(() => fitPointerActionToAllowedBounds({
    windowHandle: 10,
    action: 'drag',
    confirmed: true,
    from: { x: 1800, y: 100 },
    to: { x: 2783, y: 485 },
    durationMs: 350
  }, { x: 1920, y: 0, width: 1920, height: 1080 }), /outside the AI display/);
});

test('recorded and learned drags retain modifiers and trajectory semantics', () => {
  const window = {
    name: 'Drawing', processName: 'Draw', className: 'CanvasWindow',
    bounds: { x: 0, y: 0, width: 1000, height: 800 }
  };
  const skill = buildSkillFromRecording({
    skillId: '11111111-1111-4111-8111-111111111111',
    name: 'Идеальный круг',
    instruction: 'Нарисуй круг с Control',
    window,
    recording: { events: [{
      type: 'drag', atMs: 100, x: 100, y: 100, toX: 300, toY: 300,
      durationMs: 400, button: 'left', modifiers: ['Control'], controlType: 'Pane'
    }] },
    elements: []
  });
  assert.deepEqual(skill.steps[0].modifiers, ['Control']);
  assert.equal(skill.steps[0].trajectoryMode, 'adaptive');
  const action = learnedStepToPointerAction(skill.steps[0], window.bounds, 10);
  assert.deepEqual(action.modifiers, ['Control']);
});

test('planner carries only explicit valid modifiers into screen actions', () => {
  const proposal = normalizePlannerOutput({
    observation: 'Холст готов',
    action: { type: 'drag', from: { x: 0.1, y: 0.2 }, to: { x: 0.4, y: 0.5 }, modifiers: ['Control'] },
    reason: 'Создать идеальный круг', expectedResult: 'Появится круг',
    risk: { level: 'local_change', reason: 'Локальный рисунок' }, confidence: 0.9
  });
  assert.deepEqual(proposal.action.modifiers, ['Control']);
  assert.deepEqual(
    toScreenPointerAction(proposal.action, { x: 100, y: 50, width: 1000, height: 800 }, 10).modifiers,
    ['Control']
  );
});

test('canvas text insertion preserves insert mode through the pointer request', () => {
  const proposal = normalizePlannerOutput({
    observation: 'Текстовый инструмент активен',
    action: {
      type: 'typeText', point: { x: 0.5, y: 0.5 }, text: 'Привет', textMode: 'insert',
      targetHint: { name: 'Document canvas', controlType: 'Canvas' }
    },
    reason: 'Создать новый текст', expectedResult: 'Фраза появится',
    risk: { level: 'local_change', reason: 'Локальная правка' }, confidence: 0.9
  });
  const screen = toScreenPointerAction(proposal.action, { x: 0, y: 0, width: 1000, height: 800 }, 10);
  assert.equal(screen.textMode, 'insert');
  assert.equal(normalizePointerAction(screen).textMode, 'insert');
});
