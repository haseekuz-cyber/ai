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
