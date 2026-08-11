const $ = (selector) => document.querySelector(selector);

const statusDot = $('#status-dot');
const statusTitle = $('#status-title');
const statusDetail = $('#status-detail');
const result = $('#result');
const prompt = $('#prompt');
const mode = $('#mode');
const ownerSession = $('#owner-session');
const workerSession = $('#worker-session');
const controlMethod = $('#control-method');
const isolationChecks = $('#isolation-checks');
const windowSelect = $('#window-select');
const inspectButton = $('#inspect-window');
const analyzeButton = $('#analyze-window');
const auditTelegramButton = $('#audit-telegram');
const elementList = $('#element-list');
const displayDetail = $('#display-detail');
const planNextButton = $('#plan-next');
const executePlanButton = $('#execute-plan');
const cancelMissionButton = $('#cancel-mission');
const agentPlanStatus = $('#agent-plan-status');
const skillName = $('#skill-name');
const startTeachingButton = $('#start-teaching');
const stopTeachingButton = $('#stop-teaching');
const cancelTeachingButton = $('#cancel-teaching');
const teachingStatus = $('#teaching-status');
const skillSelect = $('#skill-select');
const refreshSkillsButton = $('#refresh-skills');
const recommendSkillButton = $('#recommend-skill');
const prepareSkillButton = $('#prepare-skill');
const executeSkillStepButton = $('#execute-skill-step');
const cancelSkillRunButton = $('#cancel-skill-run');
const skillStatus = $('#skill-status');
const pauseAiButton = $('#pause-ai');
const resumeAiButton = $('#resume-ai');
const showAuditButton = $('#show-audit');
const safetyTitle = $('#safety-title');
const safetyDetail = $('#safety-detail');

let currentWindowHandle = null;
let currentAgentPlan = null;
let currentMission = null;
let currentTeachingSession = null;
let currentSkillRun = null;
let executionPaused = false;

function showJson(value) {
  result.textContent = JSON.stringify(value, null, 2);
}

function renderSafetyState(state) {
  executionPaused = state?.paused === true;
  safetyTitle.textContent = executionPaused ? 'ИИ ОСТАНОВЛЕН' : 'Действия ИИ разрешены';
  safetyDetail.textContent = executionPaused
    ? `Новые действия заблокированы${state?.reason ? `: ${state.reason}` : '.'}`
    : 'Кнопка или Ctrl+Shift+F12 блокирует любые новые клики, ввод и шаги навыков.';
  pauseAiButton.disabled = executionPaused;
  resumeAiButton.disabled = !executionPaused;
  executePlanButton.disabled = executionPaused || !currentAgentPlan ||
    currentAgentPlan.proposal?.action?.type === 'done' || currentAgentPlan.policy?.allowExecution === false;
  executeSkillStepButton.disabled = executionPaused || !currentSkillRun;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.body = body;
    throw error;
  }
  return body;
}

function renderTeachingState(body) {
  const active = body?.active === true;
  currentTeachingSession = active ? body.session : null;
  startTeachingButton.disabled = active || !currentWindowHandle;
  stopTeachingButton.disabled = !active;
  cancelTeachingButton.disabled = !active;
  windowSelect.disabled = active;
  planNextButton.disabled = active || !currentWindowHandle;
  if (active) {
    teachingStatus.textContent = `Запись активна: ${body.session?.name || 'новый навык'}. Покажите действия в выбранной программе, затем вернитесь и сохраните.`;
  } else if (!currentWindowHandle) {
    teachingStatus.textContent = 'Выберите окно второго монитора, введите задачу и нажмите «Начать показ».';
  } else {
    teachingStatus.textContent = 'Готово к записи. Основной экран и парольные поля не записываются.';
  }
}

async function loadSkills() {
  try {
    const body = await api('/api/skills');
    const selected = skillSelect.value;
    skillSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = body.count ? 'Выберите выученный навык' : 'Сохранённых навыков пока нет';
    skillSelect.append(placeholder);
    for (const skill of body.skills) {
      const option = document.createElement('option');
      option.value = skill.skillId;
      option.textContent = `${skill.name} · ${skill.application?.processName || 'приложение'} · ${skill.steps?.length || 0} шагов`;
      skillSelect.append(option);
    }
    if ([...skillSelect.options].some((option) => option.value === selected)) skillSelect.value = selected;
    prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value || Boolean(currentSkillRun);
    return body;
  } catch (error) {
    skillStatus.textContent = `Не удалось загрузить навыки: ${error.message}`;
    return null;
  }
}

function renderBoundaries(body, visionStatus) {
  const independence = body.independentControl;
  ownerSession.textContent = independence?.windowsSessionId ?? body.worker?.diagnostics?.session?.sessionId ?? '—';
  workerSession.textContent = independence?.assignedDisplay ?? body.worker?.uiAutomation?.assignedDisplay ?? '—';
  controlMethod.textContent = independence?.controlMethod ?? 'недоступен';
  isolationChecks.replaceChildren();

  const labels = {
    display_boundary: `Зрение и управление ограничены монитором ${independence?.assignedDisplay || '—'}`,
    window_local_control: 'Собственное управление отправляет действия прямо выбранному окну',
    physical_pointer_unused: 'Физическая мышь пользователя не используется',
    virtual_pointer: 'Синий AI-курсор запущен',
    confirmation_policy: 'Каждое изменение требует подтверждения',
    emergency_stop: `Аварийная клавиша ${body.worker?.emergencyHotkey?.shortcut || 'Ctrl+Shift+F12'} зарегистрирована`,
    not_paused: 'AI-управление не остановлено'
  };
  const checks = [
    ...(independence?.checks || []).map((check) => ({ passed: check.passed, label: labels[check.id] || check.id })),
    {
      passed: visionStatus?.local?.reachable === true,
      label: visionStatus?.local?.reachable
        ? `Локальный LM Studio доступен; моделей: ${visionStatus.local.models?.length || 0}`
        : 'Локальный LM Studio пока недоступен'
    }
  ];

  for (const check of checks) {
    const item = document.createElement('li');
    item.className = check.passed ? 'check-pass' : 'check-fail';
    item.textContent = `${check.passed ? '✓' : '○'} ${check.label}`;
    isolationChecks.append(item);
  }
}

async function refreshStatus() {
  statusDot.className = 'status-dot pending';
  statusTitle.textContent = 'Проверяем Worker…';
  statusDetail.textContent = 'Подключение к локальному исполнителю.';

  try {
    const body = await api('/api/status');
    let visionStatus = null;
    try { visionStatus = await api('/api/vision/status'); } catch {}
    let teachingState = null;
    try { teachingState = await api('/api/teach/status'); } catch {}
    renderSafetyState(body.worker?.safety);
    const uia = body.worker?.uiAutomation;
    const independence = body.independentControl;
    statusDot.className = `status-dot ${independence?.ready ? 'ready' : 'error'}`;
    statusTitle.textContent = independence?.ready
      ? 'AI готов работать на втором мониторе'
      : 'Неинвазивное управление недоступно';
    statusDetail.textContent = independence?.ready
      ? `Закреплён ${independence.assignedDisplay}; физическая мышь свободна, изменения выполняются только после подтверждения.`
      : uia?.error || body.worker?.diagnosticsError || 'Проверьте Worker.';
    displayDetail.textContent = uia?.available
      ? `${uia.assignedDisplay}: ${uia.bounds.width}×${uia.bounds.height}, координаты ${uia.bounds.x}:${uia.bounds.y}`
      : 'Второй монитор пока не определён.';
    renderBoundaries(body, visionStatus);
    renderTeachingState(teachingState);
    await loadSkills();
    showJson({
      ready: independence?.ready === true,
      display: uia?.assignedDisplay,
      mode: independence?.mode,
      pointerOverlay: body.worker?.pointerOverlay,
      safety: body.worker?.safety,
      emergencyHotkey: body.worker?.emergencyHotkey,
      vision: visionStatus,
      message: 'Нажмите «Найти окна», чтобы проверить новый канал.'
    });
  } catch (error) {
    statusDot.className = 'status-dot error';
    statusTitle.textContent = 'Worker недоступен';
    statusDetail.textContent = 'Запустите scripts/start-worker.ps1.';
    showJson({ error: error.message });
  }
}

function windowLabel(window) {
  const title = window.name || '(окно без названия)';
  return `${title} · ${window.processName || 'process'}`;
}

async function scanWindows() {
  $('#scan-windows').disabled = true;
  try {
    const body = await api('/api/uia/windows');
    const windows = body.windows
      .filter((window) => window.name && !['ChatGPT', 'Codex'].includes(window.processName))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    windowSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = windows.length ? 'Выберите программу' : 'Подходящих окон не найдено';
    windowSelect.append(placeholder);

    for (const window of windows) {
      const option = document.createElement('option');
      option.value = String(window.nativeWindowHandle);
      option.textContent = windowLabel(window);
      windowSelect.append(option);
    }
    inspectButton.disabled = true;
    analyzeButton.disabled = true;
    auditTelegramButton.disabled = true;
    recommendSkillButton.disabled = true;
    planNextButton.disabled = true;
    executePlanButton.disabled = true;
    cancelMissionButton.disabled = true;
    currentAgentPlan = null;
    currentMission = null;
    planNextButton.textContent = 'Qwen: начать многошаговую задачу';
    currentWindowHandle = null;
    showJson({ found: windows.length, display: body.display?.assignedDisplay, windows });
  } catch (error) {
    showJson({ error: error.message });
  } finally {
    $('#scan-windows').disabled = false;
  }
}

function actionLabel(action) {
  return {
    invoke: 'Нажать',
    toggle: 'Переключить',
    select: 'Выбрать',
    expand: 'Раскрыть',
    collapse: 'Свернуть'
  }[action] || action;
}

function elementSelector(element) {
  if (element.runtimeId) return { runtimeId: element.runtimeId };
  if (element.automationId) return { automationId: element.automationId, controlType: element.controlType };
  return { name: element.name, controlType: element.controlType };
}

async function runElementAction(element, action, value) {
  const readableName = element.name || element.automationId || element.controlType;
  if (!window.confirm(`Выполнить «${actionLabel(action)}» для элемента «${readableName}»?`)) return;

  try {
    const body = await api('/api/uia/actions', {
      method: 'POST',
      body: JSON.stringify({
        windowHandle: currentWindowHandle,
        selector: elementSelector(element),
        action,
        ...(action === 'setValue' ? { value } : {}),
        confirmed: true
      })
    });
    showJson(body);
    await inspectWindow();
  } catch (error) {
    showJson({ error: error.message, element: readableName, action });
  }
}

function renderElements(elements) {
  const actionable = elements.filter((element) =>
    element.enabled &&
    !element.offscreen &&
    element.bounds?.width > 0 &&
    element.bounds?.height > 0 &&
    element.capabilities?.length > 0 &&
    (element.name || element.automationId)
  );

  elementList.replaceChildren();
  if (!actionable.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'У этого окна не найдено стандартных Accessibility-действий. Для него понадобится визуальный исполнитель второго этапа.';
    elementList.append(empty);
    return;
  }

  for (const element of actionable.slice(0, 100)) {
    const card = document.createElement('article');
    card.className = 'element-card';

    const description = document.createElement('div');
    description.className = 'element-description';
    const title = document.createElement('strong');
    title.textContent = element.name || element.automationId;
    const meta = document.createElement('small');
    meta.textContent = `${element.controlType} · ${element.automationId || 'без AutomationId'}`;
    description.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'element-actions';

    if (element.capabilities.includes('value')) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = element.value ?? '';
      input.setAttribute('aria-label', `Новое значение: ${element.name || element.automationId}`);
      const button = document.createElement('button');
      button.className = 'secondary compact';
      button.textContent = 'Записать';
      button.addEventListener('click', () => runElementAction(element, 'setValue', input.value));
      actions.append(input, button);
    }

    for (const action of ['invoke', 'toggle', 'select', 'expand', 'collapse']) {
      if (!element.capabilities.includes(action) && !(action === 'expand' && element.capabilities.includes('expandCollapse'))) continue;
      if (action === 'collapse' && !element.capabilities.includes('expandCollapse')) continue;
      const button = document.createElement('button');
      button.className = 'secondary compact';
      button.textContent = actionLabel(action);
      button.addEventListener('click', () => runElementAction(element, action));
      actions.append(button);
    }

    card.append(description, actions);
    elementList.append(card);
  }
}

async function inspectWindow() {
  if (!currentWindowHandle) return;
  inspectButton.disabled = true;
  try {
    const body = await api('/api/uia/inspect', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: currentWindowHandle, maxDepth: 7, maxElements: 800 })
    });
    renderElements(body.elements);
    showJson({
      window: body.window,
      scannedElements: body.count,
      truncated: body.truncated,
      actionableElements: body.elements.filter((element) => element.capabilities?.length).length
    });
  } catch (error) {
    elementList.innerHTML = `<p class="empty-state"></p>`;
    elementList.firstElementChild.textContent = error.message;
    showJson({ error: error.message });
  } finally {
    inspectButton.disabled = false;
  }
}

windowSelect.addEventListener('change', async () => {
  if (currentMission?.missionId) {
    try {
      await api('/api/missions/cancel', {
        method: 'POST', body: JSON.stringify({ missionId: currentMission.missionId })
      });
    } catch {}
  }
  currentMission = null;
  currentWindowHandle = Number.parseInt(windowSelect.value, 10) || null;
  inspectButton.disabled = !currentWindowHandle;
  analyzeButton.disabled = !currentWindowHandle;
  auditTelegramButton.disabled = !currentWindowHandle;
  recommendSkillButton.disabled = !currentWindowHandle;
  planNextButton.disabled = !currentWindowHandle;
  executePlanButton.disabled = true;
  cancelMissionButton.disabled = true;
  currentAgentPlan = null;
  planNextButton.textContent = 'Qwen: начать многошаговую задачу';
  startTeachingButton.disabled = Boolean(currentTeachingSession) || !currentWindowHandle;
  prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value || Boolean(currentSkillRun);
  agentPlanStatus.textContent = currentWindowHandle
    ? 'Введите задачу. Qwen будет выполнять её по одному проверяемому шагу.'
    : 'Выберите окно второго монитора.';
  if (!currentTeachingSession) {
    teachingStatus.textContent = currentWindowHandle
      ? 'Готово к записи. Основной экран и парольные поля не записываются.'
      : 'Выберите окно второго монитора, введите задачу и нажмите «Начать показ».';
  }
});

planNextButton.addEventListener('click', async () => {
  if (!currentWindowHandle) return;
  const instruction = prompt.value.trim();
  if (!instruction) return showJson({ error: 'Введите задачу для локальной модели.' });
  planNextButton.disabled = true;
  executePlanButton.disabled = true;
  currentAgentPlan = null;
  agentPlanStatus.textContent = 'Qwen изучает окно и готовит следующий шаг без выполнения…';
  try {
    if (!currentMission?.missionId) {
      const started = await api('/api/missions', {
        method: 'POST',
        body: JSON.stringify({ windowHandle: currentWindowHandle, instruction, maxSteps: 20 })
      });
      currentMission = started.mission;
      cancelMissionButton.disabled = false;
      planNextButton.textContent = 'Qwen: следующий шаг';
    }
    const body = await api('/api/missions/plan-next', {
      method: 'POST',
      body: JSON.stringify({ missionId: currentMission.missionId })
    });
    currentMission = body.mission;
    const done = body.proposal?.action?.type === 'done' || body.mission?.status === 'complete';
    const blocked = body.policy?.allowExecution === false;
    currentAgentPlan = done || blocked ? null : body;
    executePlanButton.disabled = executionPaused || done || blocked;
    if (done) {
      currentMission = null;
      cancelMissionButton.disabled = true;
      planNextButton.textContent = 'Qwen: начать новую задачу';
      agentPlanStatus.textContent = 'Qwen считает многошаговую задачу выполненной. Проверьте итог.';
    } else if (blocked) {
      agentPlanStatus.textContent = `Шаг заблокирован политикой: ${body.policy.reason}`;
    } else {
      const step = (body.mission?.stepCount || 0) + 1;
      agentPlanStatus.textContent = `Шаг ${step} готов: ${body.proposal?.reason || body.proposal?.action?.type}. Требуется подтверждение.`;
    }
    showJson(body);
  } catch (error) {
    agentPlanStatus.textContent = `План безопасно остановлен: ${error.message}`;
    showJson(error.body || { error: error.message });
  } finally {
    planNextButton.disabled = !currentWindowHandle || Boolean(currentAgentPlan);
  }
});

executePlanButton.addEventListener('click', async () => {
  if (!currentAgentPlan?.planId) return;
  const proposal = currentAgentPlan.proposal;
  const risk = currentAgentPlan.policy?.effectiveRisk || proposal?.risk?.level || 'dangerous';
  const question = [
    `Действие: ${proposal?.action?.type || 'неизвестно'}`,
    `Причина: ${proposal?.reason || 'не указана'}`,
    `Риск: ${risk} — ${currentAgentPlan.policy?.reason || proposal?.risk?.reason || 'не классифицирован'}`,
    `Ожидаемый результат: ${proposal?.expectedResult || 'не указан'}`,
    '',
    'Выполнить этот единственный шаг?'
  ].join('\n');
  if (!window.confirm(question)) return;

  executePlanButton.disabled = true;
  planNextButton.disabled = true;
  agentPlanStatus.textContent = 'Выполняется один подтверждённый шаг и проверяется результат…';
  try {
    const body = await api('/api/agent/execute-plan', {
      method: 'POST',
      body: JSON.stringify({ planId: currentAgentPlan.planId, confirmed: true })
    });
    currentMission = body.mission || currentMission;
    showJson(body);
    const missionFinished = ['complete', 'limit_reached', 'cancelled'].includes(currentMission?.status);
    agentPlanStatus.textContent = body.validation?.success
      ? `Шаг выполнен и проверен. Выполнено шагов: ${currentMission?.stepCount || 1}.`
      : 'Шаг выполнен, но результат не подтверждён. Qwen учтёт это при следующем плане.';
    currentAgentPlan = null;
    if (missionFinished) {
      currentMission = null;
      cancelMissionButton.disabled = true;
      planNextButton.textContent = 'Qwen: начать новую задачу';
    } else {
      planNextButton.textContent = 'Qwen: следующий шаг';
    }
  } catch (error) {
    agentPlanStatus.textContent = 'Шаг не выполнен.';
    showJson({ error: error.message });
    currentAgentPlan = null;
  } finally {
    planNextButton.disabled = !currentWindowHandle;
  }
});

cancelMissionButton.addEventListener('click', async () => {
  if (!currentMission?.missionId) return;
  if (!window.confirm('Остановить текущую многошаговую задачу?')) return;
  try {
    await api('/api/missions/cancel', {
      method: 'POST', body: JSON.stringify({ missionId: currentMission.missionId })
    });
  } catch {}
  currentMission = null;
  currentAgentPlan = null;
  executePlanButton.disabled = true;
  cancelMissionButton.disabled = true;
  planNextButton.disabled = !currentWindowHandle;
  planNextButton.textContent = 'Qwen: начать новую задачу';
  agentPlanStatus.textContent = 'Задача остановлена.';
});

pauseAiButton.addEventListener('click', async () => {
  pauseAiButton.disabled = true;
  try {
    const body = await api('/api/safety/pause', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Аварийная пауза из панели' })
    });
    renderSafetyState(body);
    showJson({ safety: body, message: 'Все новые действия ИИ заблокированы.' });
  } catch (error) {
    pauseAiButton.disabled = false;
    showJson({ error: error.message });
  }
});

resumeAiButton.addEventListener('click', async () => {
  if (!window.confirm('Снова разрешить ИИ выполнять только подтверждённые действия?')) return;
  resumeAiButton.disabled = true;
  try {
    const body = await api('/api/safety/resume', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    renderSafetyState(body);
    showJson({ safety: body, message: 'Выполнение подтверждённых действий снова разрешено.' });
  } catch (error) {
    resumeAiButton.disabled = false;
    showJson({ error: error.message });
  }
});

showAuditButton.addEventListener('click', async () => {
  try {
    showJson(await api('/api/audit?limit=100'));
  } catch (error) {
    showJson({ error: error.message });
  }
});

startTeachingButton.addEventListener('click', async () => {
  if (!currentWindowHandle) return;
  const instruction = prompt.value.trim();
  if (!instruction) return showJson({ error: 'Опишите задачу, которую вы собираетесь показать.' });
  const name = skillName.value.trim() || instruction.slice(0, 96);
  if (!window.confirm('Начать запись демонстрации только внутри выбранного окна?\n\nПарольные поля и действия на основном мониторе не записываются.')) return;
  startTeachingButton.disabled = true;
  planNextButton.disabled = true;
  teachingStatus.textContent = 'Запускается безопасная запись показа…';
  try {
    const body = await api('/api/teach/start', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: currentWindowHandle, name, instruction, maxDurationSeconds: 120 })
    });
    currentTeachingSession = body;
    stopTeachingButton.disabled = false;
    cancelTeachingButton.disabled = false;
    windowSelect.disabled = true;
    teachingStatus.textContent = 'Запись идёт. Покажите действия в выбранной программе, затем нажмите «Завершить и сохранить».';
    showJson(body);
  } catch (error) {
    currentTeachingSession = null;
    startTeachingButton.disabled = !currentWindowHandle;
    planNextButton.disabled = !currentWindowHandle;
    teachingStatus.textContent = 'Запись не запущена.';
    showJson({ error: error.message });
  }
});

stopTeachingButton.addEventListener('click', async () => {
  if (!currentTeachingSession?.sessionId) return;
  stopTeachingButton.disabled = true;
  cancelTeachingButton.disabled = true;
  teachingStatus.textContent = 'Останавливаю запись и собираю воспроизводимый навык…';
  try {
    const body = await api('/api/teach/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentTeachingSession.sessionId })
    });
    currentTeachingSession = null;
    windowSelect.disabled = false;
    startTeachingButton.disabled = !currentWindowHandle;
    planNextButton.disabled = !currentWindowHandle;
    teachingStatus.textContent = `Навык сохранён: ${body.skill?.name || body.skill?.skillId}. Шагов: ${body.skill?.steps?.length || 0}.`;
    showJson(body);
    await loadSkills();
  } catch (error) {
    teachingStatus.textContent = 'Не удалось сохранить показ. Проверьте журнал.';
    showJson({ error: error.message });
  }
});

cancelTeachingButton.addEventListener('click', async () => {
  if (!currentTeachingSession?.sessionId) return;
  if (!window.confirm('Отменить текущую запись без сохранения навыка?')) return;
  try {
    await api('/api/teach/cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentTeachingSession.sessionId })
    });
  } catch {}
  currentTeachingSession = null;
  windowSelect.disabled = false;
  stopTeachingButton.disabled = true;
  cancelTeachingButton.disabled = true;
  startTeachingButton.disabled = !currentWindowHandle;
  planNextButton.disabled = !currentWindowHandle;
  teachingStatus.textContent = 'Запись отменена.';
});

skillSelect.addEventListener('change', () => {
  prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value || Boolean(currentSkillRun);
  if (!currentSkillRun) {
    skillStatus.textContent = skillSelect.value
      ? 'Навык выбран. Подготовьте его для текущего окна.'
      : 'Каждый выученный шаг отдельно показывается и требует подтверждения.';
  }
});

refreshSkillsButton.addEventListener('click', loadSkills);

recommendSkillButton.addEventListener('click', async () => {
  if (!currentWindowHandle) return;
  const instruction = prompt.value.trim();
  if (!instruction) return showJson({ error: 'Сначала опишите задачу для подбора навыка.' });
  recommendSkillButton.disabled = true;
  skillStatus.textContent = 'Локальная Qwen сравнивает задачу только с навыками выбранной программы…';
  try {
    const body = await api('/api/skills/recommend', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: currentWindowHandle, instruction })
    });
    if (body.skill?.skillId) {
      await loadSkills();
      skillSelect.value = body.skill.skillId;
      const prepared = await api('/api/skills/prepare', {
        method: 'POST',
        body: JSON.stringify({ skillId: body.skill.skillId, windowHandle: currentWindowHandle })
      });
      currentSkillRun = prepared;
      windowSelect.disabled = true;
      skillSelect.disabled = true;
      executeSkillStepButton.disabled = false;
      cancelSkillRunButton.disabled = false;
      prepareSkillButton.disabled = true;
      skillStatus.textContent = `Навык «${body.skill.name}» подобран и подготовлен. Следующий шаг ${prepared.currentStep?.type} выполнится только после подтверждения.`;
      showJson({ recommendation: body, prepared });
    } else {
      skillStatus.textContent = body.recommendation?.reason || 'Подходящий навык не найден.';
      showJson(body);
    }
  } catch (error) {
    skillStatus.textContent = 'Не удалось подобрать навык.';
    showJson({ error: error.message });
  } finally {
    recommendSkillButton.disabled = !currentWindowHandle;
  }
});

prepareSkillButton.addEventListener('click', async () => {
  if (!currentWindowHandle || !skillSelect.value) return;
  prepareSkillButton.disabled = true;
  skillStatus.textContent = 'Проверяю совместимость навыка с выбранной программой…';
  try {
    const body = await api('/api/skills/prepare', {
      method: 'POST',
      body: JSON.stringify({ skillId: skillSelect.value, windowHandle: currentWindowHandle })
    });
    currentSkillRun = body;
    windowSelect.disabled = true;
    skillSelect.disabled = true;
    executeSkillStepButton.disabled = false;
    cancelSkillRunButton.disabled = false;
    skillStatus.textContent = `Навык готов. Следующий шаг: ${body.currentStep?.type}.`;
    showJson(body);
  } catch (error) {
    prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value;
    skillStatus.textContent = 'Навык не подготовлен.';
    showJson({ error: error.message });
  }
});

executeSkillStepButton.addEventListener('click', async () => {
  if (!currentSkillRun?.runId) return;
  const step = currentSkillRun.currentStep || currentSkillRun.nextStep;
  const details = step?.type === 'typeText'
    ? `\nТекст: ${step.text}`
    : step?.type === 'pressKey' ? `\nКлавиша: ${step.key}` : '';
  const risk = step?.policy?.effectiveRisk || 'dangerous';
  const external = step?.policy?.externalEnvironment ? '\nВНИМАНИЕ: это внешняя программа.' : '';
  const question = `Выполнить выученный шаг ${step?.index + 1}: ${step?.type}?${details}\nРиск: ${risk}\n${step?.policy?.reason || ''}${external}`;
  if (!window.confirm(question)) return;
  executeSkillStepButton.disabled = true;
  skillStatus.textContent = 'Выполняю один подтверждённый шаг и проверяю результат…';
  try {
    const body = await api('/api/skills/execute-step', {
      method: 'POST',
      body: JSON.stringify({ runId: currentSkillRun.runId, confirmed: true })
    });
    showJson(body);
    if (body.status === 'complete') {
      currentSkillRun = null;
      windowSelect.disabled = false;
      skillSelect.disabled = false;
      cancelSkillRunButton.disabled = true;
      prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value;
      skillStatus.textContent = 'Все шаги навыка выполнены.';
    } else {
      currentSkillRun = { ...currentSkillRun, ...body, currentStep: body.nextStep };
      executeSkillStepButton.disabled = false;
      skillStatus.textContent = `Шаг выполнен. Следующий: ${body.nextStep?.type}.`;
    }
  } catch (error) {
    executeSkillStepButton.disabled = false;
    skillStatus.textContent = 'Шаг не выполнен.';
    showJson({ error: error.message });
  }
});

cancelSkillRunButton.addEventListener('click', async () => {
  if (!currentSkillRun?.runId) return;
  try {
    await api('/api/skills/cancel-run', {
      method: 'POST',
      body: JSON.stringify({ runId: currentSkillRun.runId })
    });
  } catch {}
  currentSkillRun = null;
  windowSelect.disabled = false;
  skillSelect.disabled = false;
  executeSkillStepButton.disabled = true;
  cancelSkillRunButton.disabled = true;
  prepareSkillButton.disabled = !currentWindowHandle || !skillSelect.value;
  skillStatus.textContent = 'Выполнение навыка остановлено.';
});

auditTelegramButton.addEventListener('click', async () => {
  if (!currentWindowHandle) return;
  auditTelegramButton.disabled = true;
  showJson({ state: 'telegram_preview_started', mode: 'read-only', message: 'Ищем badge без открытия чатов…' });
  try {
    const body = await api('/api/telegram/audit-preview', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: currentWindowHandle })
    });
    showJson({
      mode: body.mode,
      actionsPerformed: body.actionsPerformed,
      readReceiptsSent: body.readReceiptsSent,
      candidateCount: body.candidateCount,
      candidates: body.candidates,
      warning: body.warning,
      screenshot: body.observation?.outputPath
    });
  } catch (error) {
    showJson({ error: error.message });
  } finally {
    auditTelegramButton.disabled = !currentWindowHandle;
  }
});

analyzeButton.addEventListener('click', async () => {
  if (!currentWindowHandle) return;
  analyzeButton.disabled = true;
  const requestedPrompt = prompt.value.trim() || 'Опиши видимое окно, важный текст и элементы управления. Ничего не выполняй.';
  showJson({ state: 'analysis_started', mode: 'read-only', message: 'Локальная модель анализирует снимок окна…' });
  try {
    const body = await api('/api/vision/analyze-window', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: currentWindowHandle, prompt: requestedPrompt })
    });
    showJson({
      mode: body.mode,
      actionsPerformed: body.actionsPerformed,
      window: body.window,
      analysis: body.vision?.analysis,
      stats: body.vision?.stats,
      screenshot: body.observation?.outputPath
    });
  } catch (error) {
    showJson({ error: error.message, hint: 'Проверьте, что LM Studio Server запущен и модель загружена.' });
  } finally {
    analyzeButton.disabled = !currentWindowHandle;
  }
});

$('#refresh').addEventListener('click', async () => {
  try { await api('/api/refresh', { method: 'POST' }); } catch {}
  await refreshStatus();
});

$('#scan-windows').addEventListener('click', scanWindows);
inspectButton.addEventListener('click', inspectWindow);

$('#submit').addEventListener('click', async () => {
  const value = prompt.value.trim();
  if (!value) return showJson({ error: 'Введите задачу.' });
  try {
    showJson(await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: value, mode: mode.value })
    }));
  } catch (error) {
    showJson({ error: error.message });
  }
});

refreshStatus();
