import fs from 'node:fs/promises';
import path from 'node:path';

function cleanText(value, maxLength = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeRating(value) {
  if (!['positive', 'negative'].includes(value)) throw new TypeError('rating must be positive or negative.');
  return value;
}

function feedbackKey(record) {
  if (record.planId) return `plan:${record.planId}`;
  if (record.runId && Number.isInteger(record.stepIndex)) return `skill:${record.runId}:${record.stepIndex}`;
  return record.feedbackId ? `feedback:${record.feedbackId}` : '';
}

export function buildStepFeedback({
  feedbackId,
  rating,
  instruction,
  application,
  action,
  reason = '',
  expectedResult = '',
  automatedValidation = null,
  planId = null,
  missionId = null,
  runId = null,
  skillId = null,
  stepIndex = null,
  createdAt = new Date().toISOString()
}) {
  const normalizedRating = normalizeRating(rating);
  if (!feedbackId || !action?.type) throw new TypeError('Feedback data is incomplete.');
  return {
    schemaVersion: 2,
    feedbackId,
    kind: 'step_feedback',
    rating: normalizedRating,
    createdAt,
    planId,
    missionId,
    runId,
    skillId,
    stepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
    instruction: cleanText(instruction, 4_000),
    application: {
      processName: cleanText(application?.processName, 128),
      className: cleanText(application?.className, 128)
    },
    step: {
      action,
      reason: cleanText(reason),
      expectedResult: cleanText(expectedResult),
      humanApproved: normalizedRating === 'positive',
      humanRating: normalizedRating,
      automatedValidation
    }
  };
}

export function buildPlanFeedback({ plan, rating, feedbackId, createdAt = new Date().toISOString() }) {
  if (!plan || plan.status !== 'executed') throw new TypeError('Only an executed step can be rated.');
  if (!plan.planId || !plan.proposal?.action?.type) throw new TypeError('Executed plan data is incomplete.');
  return buildStepFeedback({
    feedbackId,
    rating,
    createdAt,
    planId: plan.planId,
    missionId: plan.missionId || null,
    instruction: plan.instruction,
    application: plan.window,
    action: plan.proposal.action,
    reason: plan.proposal.reason,
    expectedResult: plan.proposal.expectedResult,
    automatedValidation: plan.validation || null
  });
}

// Compatibility for older callers and already-written tests/data.
export function buildApprovedStep({ plan, feedbackId, createdAt = new Date().toISOString() }) {
  const record = buildPlanFeedback({ plan, rating: 'positive', feedbackId, createdAt });
  return {
    ...record,
    schemaVersion: 1,
    kind: 'step_approved'
  };
}

async function readFeedbackFile(filePath) {
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((item) => item && ['step_approved', 'step_feedback'].includes(item.kind));
}

export async function appendStepFeedback(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const key = feedbackKey(record);
  try {
    const existing = (await readFeedbackFile(filePath)).find((item) => feedbackKey(item) === key);
    if (existing) return { record: existing, created: false };
  } catch { }
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return { record, created: true };
}

export const appendApprovedStep = appendStepFeedback;

export async function readRatedSteps(filePath, { processName = '', limit = 8 } = {}) {
  const normalizedProcess = cleanText(processName, 128).toLowerCase();
  return (await readFeedbackFile(filePath))
    .map((item) => item.kind === 'step_approved'
      ? { ...item, rating: 'positive', step: { ...item.step, humanRating: 'positive' } }
      : item)
    .filter((item) => !normalizedProcess || cleanText(item.application?.processName, 128).toLowerCase() === normalizedProcess)
    .slice(-Math.max(1, Math.min(Number(limit) || 8, 30)));
}

export async function readApprovedSteps(filePath, options = {}) {
  return (await readRatedSteps(filePath, { ...options, limit: Math.max(Number(options.limit) || 5, 20) }))
    .filter((item) => item.rating === 'positive')
    .slice(-Math.max(1, Math.min(Number(options.limit) || 5, 20)));
}

export function ratedStepsForPrompt(records, maxChars = 1_000) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const candidates = records.slice().reverse().map((record) => ({
    rating: record.rating || (record.step?.humanApproved ? 'positive' : 'negative'),
    task: record.instruction,
    action: {
      type: record.step?.action?.type,
      targetHint: record.step?.action?.targetHint || record.step?.action?.target || null,
      key: record.step?.action?.key || null
    },
    reason: record.step?.reason,
    expectedResult: record.step?.expectedResult
  }));
  const prefix = '\nОценённый пользователем опыт для этой программы: ';
  const suffix = '\nПоложительные примеры используй как опыт. Отрицательные означают, что этот шаг или способ привёл к неверному результату: не повторяй его без изменения. Каждый раз сверяйся со свежим изображением и не повторяй старые координаты вслепую.';
  const examples = [];
  for (const candidate of candidates) {
    const next = [...examples, candidate];
    if (prefix.length + JSON.stringify(next).length + suffix.length > maxChars) break;
    examples.push(candidate);
  }
  return examples.length ? `${prefix}${JSON.stringify(examples)}${suffix}` : '';
}

export function approvedStepsForPrompt(records, maxChars = 800) {
  return ratedStepsForPrompt(records, maxChars);
}
