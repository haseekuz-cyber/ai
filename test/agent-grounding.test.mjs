import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeGroundedAction,
  groundPlannerProposal,
  normalizeAndGround
} from '../src/agent-grounding.mjs';
import { normalizePlannerOutput, PLANNER_SYSTEM_PROMPT } from '../src/agent-planner.mjs';

const windowBounds = { x: 0, y: 0, width: 1920, height: 1080 };

function pointForScreen(x, y) {
  return { x: x / (windowBounds.width - 1), y: y / (windowBounds.height - 1) };
}

function makeProposal({
  type = 'click',
  point = pointForScreen(200, 125),
  targetHint = { name: 'Test Button' },
  text = 'hello'
} = {}) {
  const action = { type, point };
  if (targetHint) action.targetHint = targetHint;
  if (type === 'typeText') action.text = text;
  return {
    action,
    observation: 'test',
    reason: 'test action',
    expectedResult: 'visible change',
    risk: { level: 'read_only', reason: 'test' },
    confidence: 0.8
  };
}

function makeElement(overrides = {}) {
  return {
    runtimeId: overrides.runtimeId || '',
    parentRuntimeId: overrides.parentRuntimeId || '',
    automationId: overrides.automationId || '',
    name: overrides.name ?? 'Test Button',
    className: overrides.className ?? 'Button',
    controlType: overrides.controlType ?? 'Button',
    bounds: overrides.bounds ?? { x: 100, y: 100, width: 200, height: 50 },
    enabled: overrides.enabled ?? true,
    offscreen: overrides.offscreen ?? false,
    isPassword: overrides.isPassword ?? false,
    capabilities: overrides.capabilities ?? ['invoke'],
    clickablePoint: overrides.clickablePoint ?? null
  };
}

test('exact automationId binds with lowercase UIA capability', () => {
  const proposal = makeProposal({ targetHint: { automationId: 'btn_submit', controlType: 'Button' } });
  const result = normalizeAndGround({
    proposal,
    elements: [
      makeElement({ automationId: 'btn_submit', name: 'Submit' }),
      makeElement({ automationId: 'btn_cancel', name: 'Cancel' })
    ],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.target.automationId, 'btn_submit');
  assert.equal(result.grounding.confidence, 1);
});

test('missing target identity blocks click', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: null }),
    elements: [makeElement()],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'missing_target_identity');
});

test('controlType alone is not accepted as identity', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: { controlType: 'Button' } }),
    elements: [makeElement()],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'missing_target_identity');
});

test('planner normalization requires a click identity, not only controlType', () => {
  assert.throws(() => normalizePlannerOutput({
    action: {
      type: 'click',
      point: { x: 0.5, y: 0.5 },
      targetHint: { controlType: 'Button' }
    },
    confidence: 0.8
  }), /requires automationId, name, or visibleText/);
});

test('planner normalization preserves a valid targetHint', () => {
  const proposal = normalizePlannerOutput({
    action: {
      type: 'click',
      point: { x: 0.5, y: 0.5 },
      targetHint: { name: 'Save', controlType: 'Button' }
    },
    confidence: 0.8
  });
  assert.deepEqual(proposal.action.targetHint, { name: 'Save', controlType: 'Button' });
});

test('no semantic match blocks click', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: { automationId: 'expected' } }),
    elements: [makeElement({ automationId: 'different' })],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'no_semantic_match');
});

test('provided controlType is enforced as a constraint', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: { name: 'Save', controlType: 'Button' } }),
    elements: [makeElement({ name: 'Save', controlType: 'MenuItem' })],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'no_semantic_match');
});

test('nested semantic tie selects the actual descendant', () => {
  const proposal = makeProposal({
    point: pointForScreen(180, 170),
    targetHint: { name: 'Save', controlType: 'Button' }
  });
  const result = normalizeAndGround({
    proposal,
    elements: [
      makeElement({
        runtimeId: 'outer',
        name: 'Save',
        bounds: { x: 100, y: 100, width: 300, height: 200 }
      }),
      makeElement({
        runtimeId: 'inner',
        parentRuntimeId: 'outer',
        name: 'Save',
        bounds: { x: 150, y: 150, width: 100, height: 50 }
      })
    ],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.target.runtimeId, 'inner');
});

test('overlapping unrelated candidates remain ambiguous', () => {
  const proposal = makeProposal({
    point: pointForScreen(240, 125),
    targetHint: { name: 'Save' }
  });
  const result = normalizeAndGround({
    proposal,
    elements: [
      makeElement({ name: 'Save', bounds: { x: 100, y: 100, width: 150, height: 50 } }),
      makeElement({ name: 'Save', bounds: { x: 230, y: 110, width: 40, height: 30 } })
    ],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'ambiguous_target');
});

test('non-actionable UIA surface requires visual refinement', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: { name: 'Static label' } }),
    elements: [makeElement({
      name: 'Static label',
      className: 'Text',
      controlType: 'Text',
      capabilities: []
    })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.reason, 'visual_refinement_required');
  assert.equal(result.grounding.adjusted, false);
  assert.equal(result.grounding.confidence, 0);
});

test('planner guidance distinguishes canvas gestures from control clicks', () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /use drag/i);
  assert.match(PLANNER_SYSTEM_PROMPT, /fresh screenshot as the source of truth/i);
  assert.match(PLANNER_SYSTEM_PROMPT, /Do not use click on an empty canvas/i);
});

test('planner rejects a zero-distance drag', () => {
  assert.throws(() => normalizePlannerOutput({
    action: {
      type: 'drag',
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.5, y: 0.5 }
    },
    confidence: 0.9
  }), /visible non-zero drag/);
});

test('planner preserves a semantic target hint for typeText', () => {
  const proposal = normalizePlannerOutput({
    action: {
      type: 'typeText',
      point: { x: 0.2, y: 0.1 },
      text: '40',
      targetHint: { name: 'Width', visibleText: '57.349 cm' }
    },
    confidence: 0.9
  });
  assert.deepEqual(proposal.action.targetHint, { name: 'Width', visibleText: '57.349 cm' });
});

test('inaccessible UIA surface preserves the semantic target for visual refinement', () => {
  const proposal = makeProposal({ targetHint: { name: 'Pointer tool', visibleText: 'Pointer' } });
  const result = normalizeAndGround({
    proposal,
    elements: [makeElement({
      name: 'CorelDRAW',
      className: 'MainWindow',
      controlType: 'Window',
      capabilities: []
    })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.reason, 'visual_refinement_required');
  assert.deepEqual(result.grounding.targetHint, proposal.action.targetHint);
});

test('visual fallback stays blocked when UIA exposes another actionable control', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({
      point: pointForScreen(900, 700),
      targetHint: { name: 'Pointer tool' }
    }),
    elements: [makeElement({
      name: 'Save',
      bounds: { x: 100, y: 100, width: 200, height: 50 }
    })],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'no_actionable_target');
});

test('lowercase toggle capability makes a checkbox actionable', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ targetHint: { name: 'Remember me', controlType: 'CheckBox' } }),
    elements: [makeElement({
      name: 'Remember me',
      controlType: 'CheckBox',
      capabilities: ['toggle']
    })],
    windowBounds
  });
  assert.equal(result.blocked, false);
});

test('disabled and offscreen elements block clicks', () => {
  for (const element of [makeElement({ enabled: false }), makeElement({ offscreen: true })]) {
    const result = normalizeAndGround({ proposal: makeProposal(), elements: [element], windowBounds });
    assert.equal(result.blocked, true);
    assert.equal(result.abortReason, 'no_actionable_target');
  }
});

test('UIA clickablePoint is used only when it is inside the matched element', () => {
  const proposal = makeProposal({ targetHint: { name: 'Test Button' } });
  const result = normalizeAndGround({
    proposal,
    elements: [makeElement({ clickablePoint: { x: 250, y: 130 } })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.pointMethod, 'uia_clickable_point');
  assert.deepEqual(result.grounding.safePoint, pointForScreen(250, 130));
});

test('fallback point is deterministic and stays near the fresh planned point', () => {
  const proposal = makeProposal({ point: pointForScreen(115, 112) });
  const element = makeElement();
  const first = normalizeAndGround({ proposal, elements: [element], windowBounds });
  const second = normalizeAndGround({ proposal, elements: [element], windowBounds });
  assert.equal(first.grounding.pointMethod, 'planned_interior_point');
  assert.deepEqual(first.grounding.safePoint, second.grounding.safePoint);
  assert.deepEqual(first.grounding.safePoint, proposal.action.point);
});

test('typeText keeps legacy single editable target grounding with lowercase value capability', () => {
  const proposal = makeProposal({ type: 'typeText', point: pointForScreen(1500, 900), targetHint: null });
  const result = normalizeAndGround({
    proposal,
    elements: [makeElement({
      name: 'Message',
      className: 'Edit',
      controlType: 'Edit',
      capabilities: ['value']
    })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.reason, 'single_editable_target');
  assert.notDeepEqual(result.proposal.action.point, proposal.action.point);
});

test('ambiguous editable targets block typeText', () => {
  const proposal = makeProposal({ type: 'typeText', point: pointForScreen(1500, 900), targetHint: null });
  const result = normalizeAndGround({
    proposal,
    elements: [
      makeElement({ name: 'First', controlType: 'Edit', capabilities: ['value'] }),
      makeElement({
        name: 'Second',
        controlType: 'Edit',
        capabilities: ['value'],
        bounds: { x: 400, y: 100, width: 200, height: 50 }
      })
    ],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'ambiguous_editable_targets');
});

test('groundPlannerProposal throws before later planning stages when blocked', () => {
  assert.throws(() => groundPlannerProposal({
    proposal: makeProposal({ targetHint: null }),
    elements: [makeElement()],
    windowBounds
  }), (error) => error.code === 'invalid_local_plan' && error.abortReason === 'missing_target_identity');
});

test('blocked grounding never calls the executor', async () => {
  let calls = 0;
  await assert.rejects(() => executeGroundedAction({
    action: { type: 'click' },
    grounding: { blocked: true, confidence: 1 },
    execute: async () => { calls += 1; }
  }), (error) => error.code === 'grounding_blocked');
  assert.equal(calls, 0);
});

test('accepted grounding calls the executor exactly once', async () => {
  let calls = 0;
  const result = await executeGroundedAction({
    action: { type: 'click' },
    grounding: { blocked: false, confidence: 0.9 },
    execute: async () => { calls += 1; return 'ok'; }
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('inaccessible UIA surface permits visual refinement of an identified text field', () => {
  const proposal = makeProposal({
    type: 'typeText',
    point: pointForScreen(250, 100),
    targetHint: { name: 'Width' },
    text: '40'
  });
  const result = normalizeAndGround({
    proposal,
    elements: [makeElement({
      name: 'CorelDRAW',
      className: 'MainWindow',
      controlType: 'Window',
      capabilities: []
    })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.reason, 'visual_text_refinement_required');
  assert.deepEqual(result.grounding.targetHint, { name: 'Width' });
});

test('inaccessible UIA surface blocks unidentified typeText', () => {
  const result = normalizeAndGround({
    proposal: makeProposal({ type: 'typeText', targetHint: null, text: '40' }),
    elements: [makeElement({ controlType: 'Window', capabilities: [] })],
    windowBounds
  });
  assert.equal(result.blocked, true);
  assert.equal(result.abortReason, 'no_editable_target');
});

test('identified canvas text insertion uses full-window visual refinement instead of no_editable_target', () => {
  const proposal = makeProposal({
    type: 'typeText',
    point: pointForScreen(900, 600),
    targetHint: { name: 'Document canvas', controlType: 'Canvas' },
    text: 'Привет'
  });
  proposal.reason = 'Написать текст на холсте';
  proposal.expectedResult = 'Фраза появится на странице';
  const result = normalizeAndGround({
    proposal,
    elements: [makeElement({ controlType: 'Window', capabilities: [] })],
    windowBounds
  });
  assert.equal(result.blocked, false);
  assert.equal(result.grounding.reason, 'visual_surface_text_refinement_required');
});

test('verified visual grounding can execute exactly once', async () => {
  let calls = 0;
  const result = await executeGroundedAction({
    action: { type: 'click' },
    grounding: {
      adjusted: true,
      blocked: false,
      reason: 'visual_target_refined',
      confidence: 0.7,
      pointMethod: 'vision_refined_point'
    },
    execute: async () => { calls += 1; return 'visual-ok'; }
  });
  assert.equal(result, 'visual-ok');
  assert.equal(calls, 1);
});

test('low-confidence visual text grounding is blocked', async () => {
  await assert.rejects(() => executeGroundedAction({
    action: { type: 'typeText' },
    grounding: {
      adjusted: true,
      blocked: false,
      reason: 'visual_text_target_refined',
      confidence: 0.59
    },
    execute: async () => 'unexpected'
  }), (error) => error.code === 'grounding_blocked');
});
