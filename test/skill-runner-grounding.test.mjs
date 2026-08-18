import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRunState, groundLearnedStepToElements } from '../src/skill-runner.mjs';
import { sameWindowIdentity } from '../src/window-context.mjs';

const bounds = { x: 1920, y: 0, width: 1920, height: 1080 };

test('a generic document Pane never pulls a demonstrated canvas point to the window center', () => {
  const step = {
    type: 'click',
    point: { x: 0.12, y: 0.34 },
    target: { automationId: '1', controlType: 'Pane' }
  };
  const result = groundLearnedStepToElements(step, [{
    automationId: '1',
    controlType: 'Pane',
    enabled: true,
    offscreen: false,
    isPassword: false,
    bounds: { x: 1920, y: 80, width: 1800, height: 930 }
  }], bounds);
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'generic_surface_use_relative_point');
  assert.deepEqual(result.step.point, { x: 0.12, y: 0.34 });
});

test('a unique compact control still adapts a learned click to its fresh position', () => {
  const step = {
    type: 'click',
    point: { x: 0.1, y: 0.1 },
    target: { automationId: 'save-button', name: 'Save', controlType: 'Button' }
  };
  const result = groundLearnedStepToElements(step, [{
    automationId: 'save-button',
    name: 'Save',
    controlType: 'Button',
    enabled: true,
    offscreen: false,
    isPassword: false,
    bounds: { x: 3500, y: 100, width: 100, height: 40 }
  }], bounds);
  assert.equal(result.matched, true);
  assert.notDeepEqual(result.step.point, step.point);
});

test('a resized generic surface blocks a learned point that no longer belongs to it', () => {
  const step = {
    type: 'click',
    point: { x: 0.9, y: 0.9 },
    target: { automationId: '1', controlType: 'Pane' }
  };
  const result = groundLearnedStepToElements(step, [{
    automationId: '1',
    controlType: 'Pane',
    enabled: true,
    offscreen: false,
    isPassword: false,
    bounds: { x: 1920, y: 80, width: 600, height: 400 }
  }], bounds);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'generic_surface_point_outside_current_surface');
});

test('a prepared learned skill run preserves window identity independently from geometry', () => {
  const window = {
    processId: 120,
    processName: 'ExampleApp',
    nativeWindowHandle: 777,
    name: 'Document 1*',
    bounds
  };
  const run = createSkillRunState({
    runId: 'run-1',
    skill: { skillId: 'skill-1' },
    skillPath: 'skill.json',
    steps: [{ type: 'click' }],
    window,
    windowHandle: 777,
    now: 1_000
  });

  assert.ok(run.windowIdentity);
  assert.notEqual(run.windowIdentity, window);
  assert.equal(sameWindowIdentity({
    ...window,
    name: 'Document 1',
    bounds: { x: 2100, y: 40, width: 1500, height: 900 }
  }, run.windowIdentity), true);
  assert.equal(sameWindowIdentity({ ...window, nativeWindowHandle: 778 }, run.windowIdentity), false);
});
