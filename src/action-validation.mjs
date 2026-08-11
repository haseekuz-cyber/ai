export function applySettlingEvidence(validation, settling, { actionType } = {}) {
  const normalized = {
    success: validation?.success === true,
    evidence: typeof validation?.evidence === 'string' ? validation.evidence : '',
    confidence: Number.isFinite(Number(validation?.confidence)) ? Number(validation.confidence) : 0,
    nextStep: typeof validation?.nextStep === 'string' ? validation.nextStep : '',
    limitations: Array.isArray(validation?.limitations) ? [...validation.limitations] : []
  };

  if (actionType !== 'wait' && settling?.reason === 'timeout_without_change') {
    normalized.success = false;
    normalized.confidence = 0;
    normalized.evidence = normalized.evidence
      ? `${normalized.evidence} No visible change was detected after the action.`
      : 'No visible change was detected after the action.';
    normalized.limitations.push('Validation stopped because the screen did not change before the settling timeout.');
  }

  return normalized;
}
