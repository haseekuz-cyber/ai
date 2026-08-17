function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createdAt(skill) {
  const value = Date.parse(skill?.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

export function findLatestSemanticObservation(skills = [], processName = '') {
  const normalizedProcess = clean(processName).toLowerCase();
  return [...skills]
    .filter((skill) => skill?.semanticExperience &&
      (!normalizedProcess || clean(skill.application?.processName).toLowerCase() === normalizedProcess))
    .sort((left, right) => createdAt(right) - createdAt(left))[0] || null;
}

export function canRepeatSemanticObservation(skill) {
  const semantic = skill?.semanticExperience;
  return semantic?.understood === true && Boolean(clean(semantic.sessionGoal)) &&
    skill?.causalReplay?.ready === true && skill?.executionPolicy?.replayable === true;
}

export function summarizeSemanticObservation(skill) {
  const semantic = skill?.semanticExperience;
  if (!semantic) return 'Смысл наблюдения ещё не собран.';
  const understood = semantic.understood === true ? 'да' : 'нет';
  const confidence = Math.round((Number(semantic.confidence) || 0) * 100);
  const result = clean(semantic.comparison?.outcome) || 'видимый итог не подтверждён';
  const cause = clean(semantic.whyActions) || 'причина действий пока не определена';
  const episodes = (semantic.episodes || []).map((episode) => clean(episode.title)).filter(Boolean);
  return [
    `Понял: ${understood} (${confidence}%).`,
    `Цель: ${clean(semantic.sessionGoal) || 'не определена'}.`,
    `Почему вы так действовали: ${cause}.`,
    `Что получилось: ${result}.`,
    episodes.length ? `Полезные этапы: ${episodes.join('; ')}.` : ''
  ].filter(Boolean).join(' ');
}

export function semanticObservationGoal(skill) {
  if (!canRepeatSemanticObservation(skill)) return null;
  const semantic = skill.semanticExperience;
  const expected = clean(semantic.comparison?.after) || clean(semantic.comparison?.outcome) ||
    `На свежем экране виден результат цели: ${clean(semantic.sessionGoal)}`;
  const knowledge = (semantic.portableKnowledge || []).map((item) => clean(item.description)).filter(Boolean).slice(0, 3);
  return {
    actionable: true,
    goal: clean(semantic.sessionGoal),
    learningObjective: clean(semantic.whyActions) || 'Повторить понятый способ с адаптацией к свежему интерфейсу.',
    hypothesis: knowledge.length
      ? `Если применить понятые приёмы (${knowledge.join('; ')}), получится тот же смысловой результат без слепого повтора координат.`
      : 'Если заново найти нужные элементы на свежем экране, можно повторить смысл показанного действия без слепого повтора координат.',
    reason: 'Пользователь попросил JARVIS продемонстрировать, что он понял из последнего наблюдения.',
    successCriteria: expected,
    risk: 'local_change',
    // The user explicitly selected this learned goal for a trial; visual certainty is still checked per action.
    confidence: Math.max(0.65, Math.min(1, Number(semantic.confidence) || 0))
  };
}
