export const REFERENCE_COMPARATOR_SYSTEM_PROMPT = `You compare two screenshots for a universal Windows skill.
The first image is the final visual reference recorded during the user's demonstration.
The second image is the current result after executing the learned skill.
Judge whether the task-relevant visible result matches, while allowing harmless differences such as cursor position, selection highlight, timestamps, and window chrome.
Return JSON only:
{
  "success":true,
  "evidence":"short Russian explanation of the comparison",
  "confidence":0.0,
  "limitations":["anything that cannot be compared safely"]
}`;

export const STEP_REFERENCE_COMPARATOR_SYSTEM_PROMPT = `You compare two chronological screenshots for one step of a universal Windows skill.
The first image is the demonstrated result immediately after that step.
The second image is the current result immediately after replaying the same causal step.
Judge only the task-relevant local change. Allow harmless differences in cursor position, window geometry, selection highlight and timestamps.
Return JSON only:
{
  "success":true,
  "evidence":"short Russian explanation of what matched or differed",
  "confidence":0.0,
  "limitations":["anything that cannot be compared safely"]
}`;

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

export function normalizeReferenceComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Reference comparison must be an object.');
  }
  return {
    status: value.success === true ? 'matched' : 'mismatch',
    success: value.success === true,
    evidence: typeof value.evidence === 'string' ? value.evidence : '',
    confidence: confidence(value.confidence),
    limitations: Array.isArray(value.limitations)
      ? value.limitations.filter((item) => typeof item === 'string').slice(0, 20)
      : []
  };
}

export function referenceNeedsReview(error, code = 'reference_compare_unavailable') {
  return {
    status: 'needs_review',
    success: false,
    error: code,
    evidence: '',
    confidence: 0,
    limitations: [String(error?.message || error || 'Visual reference comparison is unavailable.')]
  };
}

export function applyReferenceComparison(validation, comparison) {
  const base = {
    success: validation?.success === true,
    evidence: typeof validation?.evidence === 'string' ? validation.evidence : '',
    confidence: Number.isFinite(Number(validation?.confidence)) ? Number(validation.confidence) : 0,
    nextStep: typeof validation?.nextStep === 'string' ? validation.nextStep : '',
    limitations: Array.isArray(validation?.limitations) ? [...validation.limitations] : []
  };
  if (!comparison) return base;

  base.success = base.success && comparison.status === 'matched' && comparison.success === true;
  base.confidence = Math.min(base.confidence, Number(comparison.confidence) || 0);
  if (comparison.evidence) {
    base.evidence = base.evidence ? `${base.evidence} Референс: ${comparison.evidence}` : comparison.evidence;
  }
  base.limitations.push(...(comparison.limitations || []));
  if (comparison.status === 'needs_review') {
    base.limitations.push('Финальный результат требует проверки пользователем: сравнение с визуальным референсом недоступно.');
  }
  return base;
}
