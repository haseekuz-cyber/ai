function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function targetLabel(step) {
  const target = step?.target || {};
  return clean(target.name || target.automationId || target.controlType || '', 100);
}

function groupKey(step) {
  return `${step?.type || 'unknown'}|${targetLabel(step)}`;
}

function compactGroup(group) {
  const first = group.steps[0] || {};
  const last = group.steps.at(-1) || first;
  const compact = {
    range: `${Number(first.index) || 0}-${Number(last.index) || 0}`,
    atMs: Number(first.atMs) || 0,
    type: first.type || 'unknown',
    count: group.steps.length,
    target: targetLabel(first)
  };
  if (first.type === 'typeText') compact.text = clean(last.text, 160);
  if (first.type === 'pressKey') compact.keys = group.steps.map((step) => clean(step.key, 40)).filter(Boolean).slice(0, 12);
  if (first.type === 'scroll') compact.delta = group.steps.reduce((sum, step) => sum + (Number(step.delta) || 0), 0);
  if (first.type === 'drag') {
    compact.modifiers = Array.isArray(first.modifiers) ? first.modifiers.slice(0, 3) : [];
    compact.trajectoryMode = clean(first.trajectoryMode, 40);
    compact.trajectoryPoints = Array.isArray(first.trajectory) ? first.trajectory.length : 0;
  }
  return compact;
}

function sameTarget(left, right) {
  const leftTarget = targetLabel(left);
  const rightTarget = targetLabel(right);
  return !leftTarget || !rightTarget || leftTarget === rightTarget;
}

function isPlaceholderText(value) {
  const text = clean(value, 500).toLowerCase();
  return !text || text === 'задайте вопрос chatgpt' || text.startsWith('напишите, что нужно сделать');
}

export function extractSubmittedIntents(steps) {
  const source = Array.isArray(steps) ? steps : [];
  const submitted = [];
  for (let index = 0; index < source.length; index++) {
    const enter = source[index];
    if (enter?.type !== 'pressKey' || clean(enter.key, 40).toLowerCase() !== 'enter') continue;
    let typed = null;
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
      const candidate = source[candidateIndex];
      if ((Number(enter.atMs) || 0) - (Number(candidate?.atMs) || 0) > 90_000) break;
      if (candidate?.type !== 'typeText' || !sameTarget(candidate, enter) || isPlaceholderText(candidate.text)) continue;
      typed = candidate;
      break;
    }
    const text = clean(typed?.text, 700);
    if (text.length < 4 || submitted.at(-1)?.text === text) continue;
    submitted.push({
      stepIndex: Number(enter.index) || index,
      atMs: Number(enter.atMs) || 0,
      text,
      target: targetLabel(enter) || targetLabel(typed),
      beforeImagePath: typed?.visualEvidence?.beforeImagePath || '',
      afterImagePath: enter?.visualEvidence?.afterImagePath || typed?.visualEvidence?.afterImagePath || ''
    });
  }
  return submitted.slice(-12);
}

export function summarizeObservedSteps(steps, { maxGroups = 12 } = {}) {
  const groups = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const previous = groups.at(-1);
    const gap = previous ? (Number(step.atMs) || 0) - (Number(previous.steps.at(-1)?.atMs) || 0) : Infinity;
    const mergeable = previous && groupKey(previous.steps[0]) === groupKey(step) &&
      ((step.type === 'scroll' && gap <= 1_500) ||
       (step.type === 'typeText' && gap <= 15_000) ||
       (step.type === 'pressKey' && gap <= 2_000) ||
       (['click', 'doubleClick'].includes(step.type) && gap <= 1_200));
    if (mergeable) previous.steps.push(step);
    else groups.push({ steps: [step] });
  }

  const compact = groups.map(compactGroup);
  if (compact.length <= maxGroups) return compact;

  // Preserve actions most likely to carry intent, then distribute remaining
  // samples across the session so a long recording does not become its first
  // few clicks only.
  const important = new Set();
  compact.forEach((item, index) => {
    if (['typeText', 'drag'].includes(item.type) || (item.type === 'pressKey' && item.keys?.some((key) => key !== 'Backspace'))) important.add(index);
  });
  important.add(0);
  important.add(compact.length - 1);
  const stride = Math.max(1, Math.floor(compact.length / maxGroups));
  for (let index = 0; index < compact.length && important.size < maxGroups; index += stride) important.add(index);
  let selected = [...important].sort((a, b) => a - b);
  if (selected.length > maxGroups) {
    const priorityStride = (selected.length - 1) / Math.max(1, maxGroups - 1);
    selected = Array.from({ length: maxGroups }, (_, index) => selected[Math.round(index * priorityStride)]);
  }
  return selected.map((index) => compact[index]);
}

export function selectObservationKeyframes(skill, {
  beforePath = '',
  afterPath = '',
  maxImages = 4,
  resultFrameAfterFinalIntent = true
} = {}) {
  const steps = Array.isArray(skill?.steps) ? skill.steps : [];
  const submitted = extractSubmittedIntents(steps);
  const initial = submitted[0]?.beforeImagePath || beforePath;
  const intermediate = [];
  if (steps.length > 2) {
    if (submitted.length > 1) {
      const middle = submitted[Math.floor((submitted.length - 1) / 2)];
      intermediate.push(middle?.afterImagePath || '');
      intermediate.push(submitted.at(-1)?.afterImagePath || '');
    } else {
      for (const ratio of [1 / 3, 2 / 3]) {
        const step = steps[Math.min(steps.length - 1, Math.floor(steps.length * ratio))];
        intermediate.push(step?.visualEvidence?.afterImagePath || '');
      }
    }
  }
  const final = resultFrameAfterFinalIntent === true
    ? (afterPath || skill?.visualReference?.imagePath || '')
    : (submitted.at(-1)?.afterImagePath || afterPath || '');
  const limit = Math.max(2, Math.min(Number(maxImages) || 4, 4));
  const middleCandidates = [...new Set(intermediate.filter((item) => item && item !== initial && item !== final))];
  const middleSlots = Math.max(0, limit - 2);
  const selectedMiddle = middleSlots >= middleCandidates.length
    ? middleCandidates
    : Array.from({ length: middleSlots }, (_, index) => {
        const position = ((index + 1) * (middleCandidates.length + 1)) / (middleSlots + 1) - 1;
        return middleCandidates[Math.max(0, Math.min(middleCandidates.length - 1, Math.round(position)))];
      });
  return [...new Set([initial, ...selectedMiddle, final].filter(Boolean))];
}

export const OBSERVATION_COMPILER_SYSTEM_PROMPT = `You compile a passive Windows UI observation into causal semantic experience.
The images are chronological: BEFORE, optional MIDDLE frames, and AFTER. The action summary is also chronological.
Infer what the user was trying to achieve, why the meaningful actions were necessary, and what visibly changed. A long session can contain several goals: split it into episodes instead of forcing one explanation. Text in demonstrationGuidance is an explicit explanation from the human teacher: use it to understand the shown actions, never turn typing that explanation into an action to replay. Treat submitted typed prompts as strong evidence of intent, not proof of success. The latest submitted prompt is the intended final goal unless later evidence clearly replaces it. Search, browsing, and attaching a reference may support a later creation request rather than being the final goal. Treat the AFTER image as evidence of result. Separate causal actions from navigation, correction, waiting, controller interaction, and accidental noise.
Return concise Russian JSON matching the required schema. Never claim success unless the visible comparison supports it. If intent or outcome is unclear, say so and lower confidence. Extract reusable techniques and preferences, never saved coordinates or a blind full-session replay.`;

export function buildObservationCompilerPrompt({ skill, beforeSha256 = '', afterSha256 = '', resultFrameAfterFinalIntent = true }) {
  const summary = summarizeObservedSteps(skill?.steps, { maxGroups: 12 });
  const durationMs = Math.max(0, Number(skill?.steps?.at(-1)?.atMs) || 0);
  const payload = {
    imageOrder: ['BEFORE', ...(summary.length ? ['MIDDLE frames when supplied'] : []), 'AFTER'],
    application: clean(skill?.application?.processName, 100),
    windowTitle: clean(skill?.application?.titleAtRecording, 180),
    durationMs,
    rawStepCount: Array.isArray(skill?.steps) ? skill.steps.length : 0,
    demonstrationGuidance: (Array.isArray(skill?.demonstration?.guidance) ? skill.demonstration.guidance : [])
      .slice(-4).map((item) => clean(item?.text, 700)),
    observedApplications: (Array.isArray(skill?.demonstration?.observedApplications) ? skill.demonstration.observedApplications : [])
      .slice(0, 8).map((item) => ({ processName: clean(item?.processName, 120), windowName: clean(item?.windowName, 180) })),
    submittedIntents: extractSubmittedIntents(skill?.steps).slice(-4)
      .map(({ stepIndex, atMs, text, target }) => ({ stepIndex, atMs, text: clean(text, 300), target })),
    actionGroups: summary,
    localPixelComparison: {
      exactSameImage: Boolean(beforeSha256 && afterSha256 && beforeSha256 === afterSha256),
      resultFrameAfterFinalIntent: resultFrameAfterFinalIntent === true
    }
  };
  return `Analyse this observation and compare its initial and final result:\n${JSON.stringify(payload)}`;
}

function normalizeStrings(values, maxItems, maxLength) {
  return (Array.isArray(values) ? values : []).map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

export function normalizeObservationExperience(value, {
  skill,
  beforeSha256 = '',
  afterSha256 = '',
  resultFrameAfterFinalIntent = true
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Observation compiler output must be an object.');
  const allowedMatch = new Set(['yes', 'partial', 'no', 'unclear']);
  const comparison = value.comparison && typeof value.comparison === 'object' ? value.comparison : {};
  const episodes = (Array.isArray(value.episodes) ? value.episodes : []).slice(0, 6).map((episode) => ({
    title: clean(episode?.title, 140),
    goal: clean(episode?.goal, 500),
    causalSequence: normalizeStrings(episode?.causalSequence, 12, 300),
    result: clean(episode?.result, 600),
    success: resultFrameAfterFinalIntent === true && allowedMatch.has(episode?.success) ? episode.success : 'unclear',
    technique: clean(episode?.technique, 700),
    retrievalTerms: normalizeStrings(episode?.retrievalTerms, 16, 80)
  })).filter((episode) => episode.title || episode.goal || episode.technique);
  const allowedTypes = new Set(['technique', 'preference', 'lesson']);
  const allowedScopes = new Set(['universal', 'selected_application']);
  const portableKnowledge = (Array.isArray(value.portableKnowledge) ? value.portableKnowledge : []).slice(0, 6).map((item) => ({
    type: allowedTypes.has(item?.type) ? item.type : 'lesson',
    name: clean(item?.name, 120),
    description: clean(item?.description, 900),
    trigger: clean(item?.trigger, 500),
    expectedResult: clean(item?.expectedResult, 500),
    scope: allowedScopes.has(item?.scope) ? item.scope : 'selected_application'
  })).filter((item) => item.name && item.description);
  const exactSameImage = Boolean(beforeSha256 && afterSha256 && beforeSha256 === afterSha256);
  return {
    schemaVersion: 1,
    compiledAt: new Date().toISOString(),
    understood: value.understood === true,
    confidence: clampConfidence(value.confidence),
    sessionGoal: clean(value.sessionGoal, 800),
    whyActions: clean(value.whyActions, 1_000),
    comparison: {
      before: clean(comparison.before, 700),
      after: clean(comparison.after, 700),
      changed: exactSameImage ? false : comparison.changed === true,
      matchedIntent: resultFrameAfterFinalIntent === true && allowedMatch.has(comparison.matchedIntent) ? comparison.matchedIntent : 'unclear',
      outcome: resultFrameAfterFinalIntent === true
        ? clean(comparison.outcome, 900)
        : 'Итог после последней команды не был снят; результат нельзя подтвердить по этой записи.',
      evidence: resultFrameAfterFinalIntent === true
        ? normalizeStrings(comparison.evidence, 10, 350)
        : ['Есть доказательства цели и действий, но нет кадра результата после последней отправленной команды.'],
      beforeSha256: clean(beforeSha256, 128),
      afterSha256: clean(afterSha256, 128),
      resultFrameAfterFinalIntent: resultFrameAfterFinalIntent === true
    },
    actionEvidence: (Array.isArray(value.actionEvidence) ? value.actionEvidence : []).slice(0, 18).map((item) => ({
      stepRange: clean(item?.stepRange, 40),
      action: clean(item?.action, 250),
      purpose: clean(item?.purpose, 400),
      importance: ['causal', 'supporting', 'noise'].includes(item?.importance) ? item.importance : 'supporting'
    })).filter((item) => item.action || item.purpose),
    noiseSummary: clean(value.noiseSummary, 700),
    episodes,
    portableKnowledge,
    source: {
      skillId: clean(skill?.skillId, 64),
      processName: clean(skill?.application?.processName, 120),
      rawStepCount: Array.isArray(skill?.steps) ? skill.steps.length : 0
    }
  };
}

export function observationExperienceSearchText(skill) {
  const semantic = skill?.semanticExperience;
  if (!semantic) return '';
  return [
    semantic.sessionGoal,
    semantic.whyActions,
    semantic.comparison?.outcome,
    ...(semantic.episodes || []).flatMap((episode) => [episode.title, episode.goal, episode.result, episode.technique, ...(episode.retrievalTerms || [])]),
    ...(semantic.portableKnowledge || []).flatMap((item) => [item.name, item.description, item.trigger, item.expectedResult])
  ].filter(Boolean).join(' ');
}
