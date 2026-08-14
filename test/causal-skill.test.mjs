import assert from 'node:assert/strict';
import test from 'node:test';
import {
  causalReplayReadiness,
  compileCausalReplaySkill,
  executableSkillSteps
} from '../src/causal-skill.mjs';

function passiveSkill(overrides = {}) {
  return {
    schemaVersion: 1,
    skillId: '00000000-0000-4000-8000-000000000001',
    learningMode: 'passive',
    instruction: 'Создать объект и подписать его',
    application: { processName: 'UniversalApp' },
    visualReference: { imagePath: 'final.png', sha256: 'abc' },
    steps: [
      { index: 0, type: 'drag', from: { x: 0.1, y: 0.2 }, to: { x: 0.4, y: 0.5 }, modifiers: ['Control'], trajectoryMode: 'adaptive', trajectory: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }] },
      { index: 1, type: 'typeText', point: { x: 0.3, y: 0.3 }, text: 'Привет' },
      { index: 2, type: 'click', point: { x: 0.6, y: 0.6 } }
    ],
    semanticExperience: {
      understood: true,
      confidence: 0.95,
      sessionGoal: 'Создать объект и подписать его',
      comparison: {
        before: 'Пустой документ',
        after: 'Объект с подписью',
        matchedIntent: 'yes',
        resultFrameAfterFinalIntent: true
      },
      actionEvidence: [
        { stepRange: '1-1', importance: 'noise', purpose: 'Ввести нужную подпись' },
        { stepRange: '2', importance: 'causal', purpose: 'Завершить редактирование' }
      ]
    },
    ...overrides
  };
}

test('a verified observation becomes an executable causal skill without losing recorded actions', () => {
  const compiled = compileCausalReplaySkill(passiveSkill());
  assert.equal(compiled.executionPolicy.replayable, true);
  assert.equal(compiled.causalReplay.ready, true);
  assert.equal(compiled.causalReplay.sourceStepCount, 3);
  assert.equal(executableSkillSteps(compiled).length, 3);
  assert.deepEqual(compiled.causalSteps[0].modifiers, ['Control']);
  assert.equal(compiled.causalSteps[0].trajectoryMode, 'adaptive');
  assert.equal(compiled.causalSteps[1].causal.role, 'essential');
  assert.match(compiled.causalSteps[1].causal.purpose, /подпись/);
  assert.equal(compiled.causalReplay.graphReady, true);
  assert.equal(compiled.skillGraph.entryNodeId, 'precondition:0');
  assert.equal(compiled.skillGraph.finalNodeId, 'final-reference');
  assert.equal(compiled.skillGraph.nodes.find((node) => node.nodeId === 'action:0').requiredModifiers[0], 'Control');
  assert.equal(compiled.skillGraph.nodes.find((node) => node.nodeId === 'validation:1').edges.onMismatch, 'recovery:1');
  assert.equal(compiled.skillGraph.nodes.find((node) => node.nodeId === 'recovery:1').edges.onCorrected, 'precondition:2');
  assert.equal(compiled.skillGraph.nodes.find((node) => node.nodeId === 'validation:2').edges.onMatched, 'final-reference');
});

test('unclear observation remains evidence and cannot silently become replayable', () => {
  const skill = passiveSkill({
    semanticExperience: {
      understood: false,
      confidence: 0.2,
      sessionGoal: '',
      comparison: { matchedIntent: 'unclear', resultFrameAfterFinalIntent: true }
    }
  });
  assert.equal(causalReplayReadiness(skill).ready, false);
  const compiled = compileCausalReplaySkill(skill);
  assert.equal(compiled.executionPolicy.replayable, false);
  assert.equal(compiled.causalReplay.ready, false);
});
