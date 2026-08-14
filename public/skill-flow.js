export function prepareSavedSkillRequest({ skillId, windowHandle }) {
  if (typeof skillId !== 'string' || !skillId) throw new TypeError('skillId is required.');
  if (!Number.isInteger(windowHandle) || windowHandle <= 0) throw new TypeError('windowHandle must be a positive integer.');
  return {
    path: '/api/skills/prepare',
    options: {
      method: 'POST',
      body: JSON.stringify({ windowHandle, skillId })
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
