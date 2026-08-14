import assert from 'node:assert/strict';
import test from 'node:test';
import { allowUnverifiedAutonomousProbe, evaluateAutonomousActionPolicy } from '../src/action-policy.mjs';

function proposal(type = 'click', risk = 'local_change', confidence = 0.9) {
  return { action: { type }, risk: { level: risk }, confidence };
}

test('anarchy mission can execute a reversible local action without confirmation', () => {
  const policy = evaluateAutonomousActionPolicy({
    proposal: proposal('drag'),
    processName: 'CorelDRW',
    missionMode: 'anarchy'
  });
  assert.equal(policy.allowAutonomousExecution, true);
});

test('guided mission cannot use autonomous execution as a confirmation bypass', () => {
  const policy = evaluateAutonomousActionPolicy({
    proposal: proposal('click'),
    processName: 'CorelDRW',
    missionMode: 'guided'
  });
  assert.equal(policy.allowAutonomousExecution, false);
});

test('anarchy can explore an external application but blocks an explicit send action', () => {
  const explore = evaluateAutonomousActionPolicy({
    proposal: { ...proposal('scroll', 'read_only'), reason: 'Изучить видимый список локально' },
    processName: 'Telegram',
    missionMode: 'anarchy'
  });
  assert.equal(explore.allowAutonomousExecution, true);
  assert.equal(explore.externalEnvironment, true);

  const send = evaluateAutonomousActionPolicy({
    proposal: {
      ...proposal('click'),
      action: { type: 'click', targetHint: { visibleText: 'Отправить' } },
      reason: 'Отправить сообщение'
    },
    processName: 'Telegram',
    missionMode: 'anarchy'
  });
  assert.equal(send.allowAutonomousExecution, false);
});

test('anarchy blocks dangerous and low-confidence proposals', () => {
  assert.equal(evaluateAutonomousActionPolicy({
    proposal: proposal('click', 'dangerous'), processName: 'sample', missionMode: 'anarchy'
  }).allowAutonomousExecution, false);
  assert.equal(evaluateAutonomousActionPolicy({
    proposal: proposal('click', 'local_change', 0.2), processName: 'sample', missionMode: 'anarchy'
  }).allowAutonomousExecution, false);
});

test('anarchy may try one uncertain reversible visual point when marked exploratory', () => {
  const uncertainClick = {
    ...proposal('click', 'local_change', 0),
    exploratory: true,
    action: { type: 'click', point: { x: 0.42, y: 0.61 } },
    reason: 'Проверить локальную кнопку и затем сверить свежий экран'
  };
  assert.equal(allowUnverifiedAutonomousProbe({ proposal: uncertainClick, missionMode: 'anarchy' }), true);
  const policy = evaluateAutonomousActionPolicy({
    proposal: uncertainClick,
    processName: 'CorelDRW',
    missionMode: 'anarchy'
  });
  assert.equal(policy.allowAutonomousExecution, true);
  assert.match(policy.autonomousReason, /uncertain but reversible/i);
});

test('uncertain probes remain blocked outside anarchy and for irreversible targets', () => {
  const proposalValue = {
    ...proposal('click', 'local_change', 0.3),
    exploratory: true,
    action: { type: 'click', point: { x: 0.5, y: 0.5 }, targetHint: { visibleText: 'Отправить' } },
    reason: 'Отправить сообщение'
  };
  assert.equal(allowUnverifiedAutonomousProbe({ proposal: proposalValue, missionMode: 'guided' }), false);
  assert.equal(allowUnverifiedAutonomousProbe({ proposal: proposalValue, missionMode: 'anarchy' }), false);
  assert.equal(evaluateAutonomousActionPolicy({
    proposal: proposalValue,
    processName: 'Telegram',
    missionMode: 'anarchy'
  }).allowAutonomousExecution, false);
});
