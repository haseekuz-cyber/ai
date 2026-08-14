const riskRank = new Map([
  ['read_only', 0],
  ['local_change', 1],
  ['external_effect', 2],
  ['dangerous', 3]
]);

const externalProcesses = new Set([
  'telegram', 'chrome', 'msedge', 'firefox', 'outlook', 'olk',
  'slack', 'teams', 'ms-teams', 'discord', 'whatsapp', 'signal'
]);

function elevatedRisk(current, minimum) {
  return (riskRank.get(current) ?? 3) >= (riskRank.get(minimum) ?? 3) ? current : minimum;
}

export function evaluateActionPolicy({ proposal, processName }) {
  const action = proposal?.action?.type;
  if (action === 'done') {
    return {
      allowExecution: true,
      requiresConfirmation: false,
      effectiveRisk: proposal.risk?.level || 'read_only',
      externalEnvironment: false,
      reason: 'No UI action will be performed.'
    };
  }

  const normalizedProcess = String(processName || '').toLowerCase().replace(/\.exe$/, '');
  const externalEnvironment = externalProcesses.has(normalizedProcess);
  let effectiveRisk = proposal?.risk?.level || 'dangerous';
  if (externalEnvironment && action !== 'wait') effectiveRisk = elevatedRisk(effectiveRisk, 'external_effect');
  const confidence = Number(proposal?.confidence) || 0;
  const allowExecution = action === 'wait' || confidence >= 0.55;

  return {
    allowExecution,
    requiresConfirmation: action !== 'wait',
    effectiveRisk,
    externalEnvironment,
    reason: !allowExecution
      ? 'Local model confidence is below 0.55; execution is blocked until a clearer plan is produced.'
      : externalEnvironment && action !== 'wait'
        ? 'The target application can create external effects such as read receipts, messages, uploads, or account changes.'
        : 'Every state-changing UI action requires explicit confirmation.'
  };
}

const autonomousActionTypes = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'wait']);
const irreversibleIntent = /(?:send|submit|publish|post|upload|delete|remove|erase|purchase|buy|pay|checkout|sign\s*out|log\s*out|password|account|security|system\s*settings|отправ|опубли|загруз|удал|стер|куп|оплат|заказ|выйти\s+из|парол|аккаунт|безопасност|системн\w*\s+настрой)/i;

function hasIrreversibleIntent(proposal) {
  return irreversibleIntent.test(JSON.stringify({
    observation: proposal?.observation,
    reason: proposal?.reason,
    expectedResult: proposal?.expectedResult,
    targetHint: proposal?.action?.targetHint,
    target: proposal?.action?.target
  }));
}

function normalizedPoint(value) {
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)) &&
    Number(value.x) >= 0 && Number(value.x) <= 1 && Number(value.y) >= 0 && Number(value.y) <= 1;
}

export function allowUnverifiedAutonomousProbe({ proposal, missionMode }) {
  if (missionMode !== 'anarchy') return false;
  const action = proposal?.action;
  const type = action?.type;
  if (!['click', 'doubleClick', 'typeText'].includes(type)) return false;
  if (!normalizedPoint(action.point)) return false;
  if (!['read_only', 'local_change'].includes(proposal?.risk?.level)) return false;
  if (hasIrreversibleIntent(proposal)) return false;
  const confidence = Number(proposal?.confidence);
  return Number.isFinite(confidence) && confidence >= 0;
}

export function evaluateAutonomousActionPolicy({ proposal, processName, missionMode }) {
  const policy = evaluateActionPolicy({ proposal, processName });
  const action = proposal?.action?.type;
  if (missionMode !== 'anarchy') {
    return {
      ...policy,
      allowAutonomousExecution: false,
      autonomousReason: 'Autonomous execution is available only inside an anarchy mission.'
    };
  }
  const exploratoryProbe = proposal?.exploratory === true &&
    allowUnverifiedAutonomousProbe({ proposal, missionMode });
  if ((!policy.allowExecution && !exploratoryProbe) || !autonomousActionTypes.has(action)) {
    return {
      ...policy,
      allowAutonomousExecution: false,
      autonomousReason: policy.allowExecution
        ? `Action ${action || 'unknown'} is not allowed in autonomous mode.`
        : policy.reason
    };
  }
  const declaredRisk = proposal?.risk?.level || 'dangerous';
  if (!['read_only', 'local_change'].includes(declaredRisk) || hasIrreversibleIntent(proposal)) {
    return {
      ...policy,
      allowAutonomousExecution: false,
      autonomousReason: 'Autonomous mode cannot create external effects or perform dangerous changes.'
    };
  }
  return {
    ...policy,
    effectiveRisk: declaredRisk,
    allowAutonomousExecution: true,
    autonomousReason: exploratoryProbe
      ? 'JARVIS may try this uncertain but reversible local step once and must validate the fresh visible result.'
      : 'JARVIS may execute this reversible local step and must validate the visible result.'
  };
}

export function evaluateLearnedStepPolicy({ step, processName }) {
  const baseRisk = step?.type === 'scroll' ? 'read_only' : 'local_change';
  const policy = evaluateActionPolicy({
    processName,
    proposal: {
      action: { type: step?.type || 'click' },
      risk: { level: baseRisk },
      confidence: 1
    }
  });
  return {
    ...policy,
    allowExecution: true,
    requiresConfirmation: true,
    reason: policy.externalEnvironment
      ? 'Выученный шаг выполняется во внешней программе и может создать внешний эффект.'
      : step?.type === 'scroll'
        ? 'Выученный шаг только прокручивает локальное окно, но всё равно требует подтверждения.'
        : 'Выученный шаг изменяет состояние выбранной программы и требует подтверждения.'
  };
}
