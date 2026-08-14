import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlannerMiniPlanOutput } from '../src/agent-planner.mjs';
import { rebindQueuedProposal } from '../src/agent-grounding.mjs';
import { prepareMiniPlanContinuation } from '../src/mini-plan.mjs';

const bounds = { x: 100, y: 100, width: 1_000, height: 700 };
const button = {
  runtimeId: 'button-1', parentRuntimeId: '', automationId: 'tool.select', name: 'Select',
  controlType: 'Button', enabled: true, offscreen: false, capabilities: ['invoke'],
  bounds: { x: 150, y: 160, width: 100, height: 40, empty: false }
};

function proposal(point = { x: 0.1, y: 0.1 }) {
  return {
    action: { type: 'click', point, targetHint: { automationId: 'tool.select', name: 'Select', controlType: 'Button' } },
    reason: 'Select the visible tool', expectedResult: 'The tool becomes selected',
    risk: { level: 'local_change', reason: 'local' }, confidence: 0.97,
    precondition: 'The Select button is visible', checkpoint: 'deterministic'
  };
}

test('planner normalizes no more than two guarded continuation actions', () => {
  const raw = {
    observation: 'visible', action: proposal().action, reason: 'first', expectedResult: 'first done',
    risk: { level: 'local_change' }, confidence: 0.98,
    nextActions: [proposal(), proposal(), proposal()]
  };
  const normalized = normalizePlannerMiniPlanOutput(raw, bounds);
  assert.equal(normalized.continuation.length, 2);
});

test('only visible deterministic semantic controls enter the mini-plan queue', () => {
  const prepared = prepareMiniPlanContinuation({
    proposals: [proposal({ x: 0.1, y: 0.1 })],
    elements: [button], windowBounds: bounds, processName: 'DesignApp'
  });
  assert.equal(prepared.steps.length, 1);
  assert.equal(prepared.rejectedReason, null);
  assert.equal(prepared.steps[0].preparedGrounding.target.automationId, 'tool.select');
});

test('queued action is rebound to the same semantic target after geometry changes', () => {
  const prepared = prepareMiniPlanContinuation({
    proposals: [proposal()], elements: [button], windowBounds: bounds, processName: 'DesignApp'
  }).steps[0];
  const moved = { ...button, bounds: { x: 500, y: 300, width: 100, height: 40, empty: false } };
  const rebound = rebindQueuedProposal({
    proposal: prepared.proposal,
    preparedGrounding: prepared.preparedGrounding,
    elements: [moved],
    windowBounds: bounds
  });
  assert.ok(rebound.proposal.action.point.x > 0.4);
  assert.equal(rebound.grounding.target.automationId, 'tool.select');
});

test('missing or changed semantic target invalidates the mini-plan', () => {
  const prepared = prepareMiniPlanContinuation({
    proposals: [proposal()], elements: [button], windowBounds: bounds, processName: 'DesignApp'
  }).steps[0];
  assert.throws(() => rebindQueuedProposal({
    proposal: prepared.proposal,
    preparedGrounding: prepared.preparedGrounding,
    elements: [],
    windowBounds: bounds
  }), /no longer visible/);
});

test('visual checkpoints and external applications are never queued', () => {
  assert.equal(prepareMiniPlanContinuation({
    proposals: [{ ...proposal(), checkpoint: 'visual' }], elements: [button], windowBounds: bounds, processName: 'DesignApp'
  }).steps.length, 0);
  assert.equal(prepareMiniPlanContinuation({
    proposals: [proposal()], elements: [button], windowBounds: bounds, processName: 'Telegram'
  }).steps.length, 0);
});
