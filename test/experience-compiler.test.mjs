import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildObservationCompilerPrompt,
  normalizeObservationExperience,
  selectObservationKeyframes,
  summarizeObservedSteps
} from '../src/experience-compiler.mjs';
import { validateSkillForWindow } from '../src/skill-runner.mjs';

function sampleSkill(steps) {
  return {
    schemaVersion: 1,
    skillId: '11111111-1111-4111-8111-111111111111',
    application: { processName: 'browser', titleAtRecording: 'Design chat' },
    steps,
    visualReference: { imagePath: 'after.png' }
  };
}

test('passive microsteps are condensed while preserving the final typed intent and modifiers', () => {
  const summary = summarizeObservedSteps([
    { index: 0, type: 'typeText', atMs: 100, text: 'сделай', target: { automationId: 'prompt' } },
    { index: 1, type: 'typeText', atMs: 200, text: 'сделай три пирожка', target: { automationId: 'prompt' } },
    { index: 2, type: 'drag', atMs: 1_000, modifiers: ['Control'], trajectoryMode: 'exact', trajectory: [{}, {}] },
    { index: 3, type: 'scroll', atMs: 2_000, delta: -120, target: { controlType: 'Pane' } },
    { index: 4, type: 'scroll', atMs: 2_100, delta: -120, target: { controlType: 'Pane' } }
  ]);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].text, 'сделай три пирожка');
  assert.deepEqual(summary[1].modifiers, ['Control']);
  assert.equal(summary[2].delta, -240);
});

test('semantic compilation compares chronological keyframes and keeps the prompt bounded', () => {
  const steps = Array.from({ length: 300 }, (_, index) => ({
    index,
    type: index % 11 === 0 ? 'typeText' : 'click',
    atMs: index * 500,
    text: `описание действия ${index} `.repeat(8),
    target: { automationId: `target-${index}` },
    visualEvidence: { afterImagePath: `frame-${index}.png` }
  }));
  const skill = sampleSkill(steps);
  assert.deepEqual(selectObservationKeyframes(skill, { beforePath: 'before.png', afterPath: 'after.png' }), [
    'before.png', 'frame-100.png', 'frame-200.png', 'after.png'
  ]);
  assert.deepEqual(selectObservationKeyframes(skill, { beforePath: 'before.png', afterPath: 'after.png', maxImages: 3 }), [
    'before.png', 'frame-200.png', 'after.png'
  ]);
  assert.ok(buildObservationCompilerPrompt({ skill }).length <= 4_000);
});

test('explicit guidance typed during desktop observation enters the compiler prompt as intent, not replay', () => {
  const skill = {
    application: { processName: 'CorelDRW', titleAtRecording: 'Document' },
    demonstration: {
      guidance: [{ text: 'Сначала создайте документ, затем нажмите Enter.' }],
      observedApplications: [{ processName: 'CorelDRW', windowName: 'Document' }]
    },
    steps: [{ index: 0, type: 'click', atMs: 100, target: { name: 'Создать документ' } }]
  };
  const prompt = buildObservationCompilerPrompt({ skill });
  assert.match(prompt, /demonstrationGuidance/);
  assert.match(prompt, /Сначала создайте документ/);
  assert.match(prompt, /observedApplications/);
});

test('normalization records causal outcome but exact-identical frames cannot be marked changed', () => {
  const skill = sampleSkill([{ index: 0, type: 'click' }]);
  const result = normalizeObservationExperience({
    understood: true,
    confidence: 0.9,
    sessionGoal: 'Изменить композицию',
    whyActions: 'Выбор объекта позволил применить изменение.',
    comparison: {
      before: 'Исходный макет', after: 'Изменённый макет', changed: true,
      matchedIntent: 'yes', outcome: 'Композиция изменена', evidence: ['Объект перемещён']
    },
    actionEvidence: [{ stepRange: '0-1', action: 'выделение', purpose: 'выбрать объект', importance: 'causal' }],
    noiseSummary: 'Лишние движения отброшены',
    episodes: [{
      title: 'Перемещение', goal: 'Изменить композицию', causalSequence: ['выбрать', 'переместить'],
      result: 'объект перемещён', success: 'yes', technique: 'сначала выбрать объект', retrievalTerms: ['перемещение']
    }],
    portableKnowledge: [{
      type: 'technique', name: 'Сначала выбрать', description: 'Перед изменением выбрать объект',
      trigger: 'объект не активен', expectedResult: 'появляется выделение', scope: 'universal'
    }]
  }, { skill, beforeSha256: 'same', afterSha256: 'same' });
  assert.equal(result.comparison.changed, false);
  assert.equal(result.episodes[0].causalSequence.length, 2);
  assert.equal(result.portableKnowledge[0].name, 'Сначала выбрать');
});

test('a passive observation is knowledge evidence and cannot be replayed blindly', () => {
  const skill = sampleSkill([{ index: 0, type: 'click', point: { x: 0.2, y: 0.3 } }]);
  skill.executionPolicy = { replayable: false };
  assert.throws(() => validateSkillForWindow(skill, { processName: 'browser' }), /semantic observation evidence/);
});
