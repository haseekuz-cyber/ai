export function prepareSavedSkillRequest({ skillId, windowHandle, startStepIndex = 0 }) {
  if (typeof skillId !== 'string' || !skillId) throw new TypeError('skillId is required.');
  if (!Number.isInteger(windowHandle) || windowHandle <= 0) throw new TypeError('windowHandle must be a positive integer.');
  if (!Number.isInteger(startStepIndex) || startStepIndex < 0) throw new TypeError('startStepIndex must be a non-negative integer.');
  return {
    path: '/api/skills/prepare',
    options: {
      method: 'POST',
      body: JSON.stringify({ windowHandle, skillId, ...(startStepIndex > 0 ? { startStepIndex } : {}) })
    }
  };
}

export function executeSavedSkillStepRequest({ runId }) {
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required.');
  return {
    path: '/api/skills/execute-step',
    options: {
      method: 'POST',
      body: JSON.stringify({ runId, confirmed: true })
    }
  };
}
