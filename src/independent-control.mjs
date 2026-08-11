export function evaluateIndependentControl(worker = {}) {
  const observationDisplay = worker.observation?.assignedDisplay || null;
  const controlDisplay = worker.uiAutomation?.assignedDisplay || worker.pointer?.assignedDisplay || null;
  const checks = [
    {
      id: 'display_boundary',
      required: true,
      passed: Boolean(observationDisplay && controlDisplay && observationDisplay === controlDisplay && worker.observation?.boundaryReady)
    },
    {
      id: 'window_local_control',
      required: true,
      passed: worker.uiAutomation?.available === true && worker.pointer?.available === true && worker.pointer?.mode === 'direct-window'
    },
    {
      id: 'physical_pointer_unused',
      required: true,
      passed: worker.uiAutomation?.systemPointerMoved === false && worker.pointer?.systemPointerMoved === false
    },
    {
      id: 'virtual_pointer',
      required: true,
      passed: worker.pointerOverlay?.enabled === true && !worker.pointerOverlay?.error
    },
    {
      id: 'confirmation_policy',
      required: true,
      passed: worker.pointer?.requiresConfirmation === true
    },
    {
      id: 'emergency_stop',
      required: true,
      passed: worker.emergencyHotkey?.registered === true
    },
    {
      id: 'not_paused',
      required: true,
      passed: worker.safety?.paused === false
    }
  ];
  const failedRequiredChecks = checks.filter((check) => check.required && !check.passed).map((check) => check.id);
  return {
    ready: failedRequiredChecks.length === 0,
    mode: 'same-session-window-local',
    sameWindowsSessionSupported: true,
    windowsSessionId: worker.diagnostics?.session?.sessionId ?? null,
    assignedDisplay: controlDisplay,
    bounds: worker.uiAutomation?.bounds || worker.observation?.bounds || null,
    controlMethod: 'UI Automation + Direct Window + AI Cursor',
    physicalPointerUsed: false,
    confirmationRequired: true,
    failedRequiredChecks,
    checks
  };
}
