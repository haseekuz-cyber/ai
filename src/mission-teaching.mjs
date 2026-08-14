export function suspendMissionsForTeaching(missions, windowHandle, { now = Date.now(), ttlMs }) {
  const suspended = [];
  for (const mission of missions.values()) {
    if (mission.windowHandle !== windowHandle || !['active', 'needs_review'].includes(mission.status)) continue;
    suspended.push({ missionId: mission.missionId, previousStatus: mission.status });
    mission.pendingMiniPlan = null;
    mission.status = 'teaching';
    mission.expiresAtMs = now + ttlMs;
    mission.expiresAt = new Date(mission.expiresAtMs).toISOString();
  }
  return suspended;
}

export function resumeMissionsAfterTeaching(missions, session, {
  skillId = null,
  cancelled = false,
  now = Date.now(),
  ttlMs
} = {}) {
  const resumed = [];
  for (const suspended of session?.suspendedMissions || []) {
    const mission = missions.get(suspended.missionId);
    if (!mission || mission.status !== 'teaching') continue;
    mission.status = 'needs_review';
    mission.expiresAtMs = now + ttlMs;
    mission.expiresAt = new Date(mission.expiresAtMs).toISOString();
    if (!cancelled && skillId) {
      mission.guidance.push({
        correction: `Пользователь показал правильный способ для текущего затруднения. Навык ${skillId} и финальный визуальный референс уже сохранены. Считай показанное состояние достигнутым, извлеки причинно важные действия и продолжи со следующего недостигнутого результата.`,
        createdAt: new Date(now).toISOString(),
        afterStep: mission.stepCount,
        source: 'live_demonstration'
      });
      mission.guidance = mission.guidance.slice(-12);
    }
    resumed.push(mission.missionId);
  }
  return resumed;
}
