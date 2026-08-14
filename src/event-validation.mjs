function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

function sameTarget(target, element) {
  if (!target || !element) return false;
  if (target.runtimeId && target.runtimeId === element.runtimeId) return true;
  if (target.automationId && target.automationId === element.automationId) return true;
  return Boolean(clean(target.name) && clean(target.name) === clean(element.name) &&
    (!target.controlType || clean(target.controlType) === clean(element.controlType)));
}

export function verifyTypedValue({ action, grounding, elements = [] } = {}) {
  if (action?.type !== 'typeText' || action.textMode === 'insert') return { available: false };
  const target = elements.find((element) => sameTarget(grounding?.target, element));
  if (!target || target.isPassword || typeof target.value !== 'string') return { available: false };
  const success = target.value === action.text;
  return {
    available: true,
    success,
    evidence: success
      ? `UI Automation verified the exact field value: ${JSON.stringify(action.text)}.`
      : `UI Automation read ${JSON.stringify(target.value)} instead of ${JSON.stringify(action.text)}.`,
    confidence: 1,
    nextStep: '',
    limitations: [],
    source: 'uia_postcondition'
  };
}

export function decidePostActionValidation({ action, settling, deterministic } = {}) {
  if (deterministic?.available) return { route: 'deterministic', validation: deterministic };
  if (action?.type !== 'wait' && settling?.reason === 'timeout_without_change') {
    return {
      route: 'local_no_change',
      validation: {
        success: false,
        evidence: 'No visible or structural change was detected after the action.',
        confidence: 1,
        nextStep: '',
        limitations: ['Qwen was not called because the local observer detected no result to interpret.'],
        source: 'event_stream'
      }
    };
  }
  return { route: 'vision', validation: null };
}
