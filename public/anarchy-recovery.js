function compact(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function createAnarchyRecoveryState() {
  return {
    missionId: null,
    fingerprint: '',
    repeated: 0,
    total: 0
  };
}

export function resetAnarchyRecoveryState(missionId = null) {
  return { ...createAnarchyRecoveryState(), missionId };
}

export function decideAnarchyRecovery(state, {
  missionId = null,
  errorCode = '',
  abortReason = '',
  message = ''
} = {}) {
  const previous = state || createAnarchyRecoveryState();
  const normalizedMessage = compact(message).toLowerCase();
  const fingerprint = [errorCode || '', abortReason || '', normalizedMessage].join('|');
  const repeated = previous.fingerprint === fingerprint ? previous.repeated + 1 : 1;
  const total = previous.total + 1;
  const nextState = { missionId, fingerprint, repeated, total };
  const staleContext = ['stale_mission', 'mission_not_active', 'target_window_changed', 'active_document_changed']
    .includes(errorCode);
  if (repeated >= 3 || total >= 5) {
    return {
      state: nextState,
      action: 'needs_user',
      shouldRecordCorrection: false,
      delayMs: null,
      report: 'Несколько новых попыток не дали прогресса. Автоповтор приостановлен: можно написать короткую подсказку, показать этот шаг или остановить свободный режим.'
    };
  }

  const abandonGoal = staleContext || repeated >= 2;

  if (abandonGoal) {
    const reason = staleContext
      ? 'окно или документ изменились'
        : 'тот же способ снова привёл к той же ошибке';
    return {
      state: nextState,
      action: 'new_mission',
      shouldRecordCorrection: repeated === 1 && !staleContext,
      delayMs: 1_200,
      report: `Причина: ${reason}. Изменение: текущая гипотеза закрывается, следующий опыт будет построен по новому снимку.`
    };
  }

  return {
    state: nextState,
    action: 'retry',
    shouldRecordCorrection: repeated === 1,
    delayMs: Math.min(900 + (total - 1) * 600, 3_000),
    report: `Попытка восстановления ${total}/5. Изменение: не повторять прежнее действие, переснять экран и выбрать другой видимый способ.`
  };
}
